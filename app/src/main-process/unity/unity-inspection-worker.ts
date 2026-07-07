/**
 * Worker-thread entry for Unity asset inspection. It owns all CPU-bound work for
 * a diff — YAML parsing, prefab expansion, hierarchy reconstruction, and the
 * semantic diff — so the main process never blocks. It is fed only strings (the
 * two sides' file contents plus a GUID→path map) because parsed document trees
 * are far too large to ship across the thread boundary; the worker reads source
 * prefabs from the working tree itself.
 *
 * It is stateful: source prefabs and the project's layer names are cached per
 * repository with a short TTL, and the expanded documents of the most recent
 * diffs are kept so a single node's property diff can be served on demand
 * (`kind: 'docs'`). This keeps the eager diff result small — it carries only
 * the changed documents — while the Inspector can still show any node's values
 * without re-running the whole pipeline.
 */

import { parentPort } from 'worker_threads'
import { readFile } from 'fs/promises'
import { join, basename, extname } from 'path'
import { parseUnityYaml } from '../../lib/unity/unity-yaml-parser'
import { buildHierarchy } from '../../lib/unity/hierarchy-builder'
import { collectReferencedGuids } from '../../lib/unity/reference-collector'
import {
  computeUnityAssetDiff,
  IParsedAssetSide,
} from '../../lib/unity/asset-diff'
import { diffDocument, indexById } from '../../lib/unity/semantic-diff'
import { sourcePrefabGuidOf } from '../../lib/unity/prefab-diff'
import {
  buildModelDocuments,
  isModelPath,
  parseModelNameTable,
} from '../../lib/unity/model-prefab'
import {
  IUnityDocumentDiff,
  IUnitySemanticDiffResult,
} from '../../models/unity/semantic-diff'
import {
  IUnitySerializedDocument,
  UnityFileId,
} from '../../models/unity/serialized-asset'
import { isErrnoException } from '../../lib/errno-exception'

export interface IUnityDiffRequest {
  readonly id: number
  readonly kind: 'diff'
  readonly requestKey: string
  readonly repoPath: string
  readonly beforePresent: boolean
  readonly afterPresent: boolean
  readonly beforeContent: string
  readonly afterContent: string
  /** GUID→repo-relative path, so the worker can read source prefabs itself. */
  readonly pathByGuid: ReadonlyArray<readonly [string, string]>
}

export interface IUnityDocsRequest {
  readonly id: number
  readonly kind: 'docs'
  readonly requestKey: string
  readonly fileIds: ReadonlyArray<UnityFileId>
}

export type IUnityWorkerRequest = IUnityDiffRequest | IUnityDocsRequest

export interface IUnityDiffResponse {
  readonly id: number
  readonly kind: 'diff'
  readonly result: IUnitySemanticDiffResult
}

export interface IUnityDocsResponse {
  readonly id: number
  readonly kind: 'docs'
  readonly documents: ReadonlyArray<IUnityDocumentDiff>
}

export interface IUnityErrorResponse {
  readonly id: number
  readonly kind: 'error'
  readonly message: string
}

export type IUnityWorkerResponse =
  | IUnityDiffResponse
  | IUnityDocsResponse
  | IUnityErrorResponse

/** Cap on how many source prefabs we read while expanding one asset. */
const maxSourcePrefabs = 5000
/** How many recent diffs keep their expanded documents for on-demand lookups. */
const maxCachedDiffs = 2
/** Simultaneous open descriptors while resolving source prefabs, matching
 *  meta-scanner's cap — an unlimited fan-out over hundreds of guids on a big
 *  scene exhausts the process's file-descriptor limit (EMFILE). */
const maxConcurrentReads = 128
/** Freshness window on the per-repo caches below. Long enough that back-to-back
 *  requests on the same scene share their reads, short enough that a working-
 *  tree change (a renamed prefab, an edited TagManager) shows up on the next
 *  request instead of only after restarting the app. */
const cacheTtlMs = 60_000

interface IRepoSourceCache {
  readonly builtAt: number
  readonly entries: Map<
    string,
    ReadonlyArray<IUnitySerializedDocument> | null
  >
}

// Parsed source-prefab documents per repository (null = resolved-but-absent, so
// we don't re-attempt within the TTL). Expires as a whole after cacheTtlMs so
// working-tree edits in Unity aren't stuck behind a stale entry.
const sourceCacheByRepo = new Map<string, IRepoSourceCache>()

interface ICachedDiff {
  readonly before: Map<UnityFileId, IUnitySerializedDocument>
  readonly after: Map<UnityFileId, IUnitySerializedDocument>
}
const diffCache = new Map<string, ICachedDiff>()

const cacheDiff = (key: string, value: ICachedDiff): void => {
  diffCache.delete(key)
  diffCache.set(key, value)
  while (diffCache.size > maxCachedDiffs) {
    const oldest = diffCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    diffCache.delete(oldest)
  }
}

const sourceGuidsOf = (
  documents: ReadonlyArray<IUnitySerializedDocument>
): ReadonlyArray<string> => {
  const guids = new Array<string>()
  for (const doc of documents) {
    if (doc.classId === 1001) {
      const guid = sourcePrefabGuidOf(doc)
      if (guid !== undefined) {
        guids.push(guid)
      }
    }
  }
  return guids
}

const parseSide = (present: boolean, content: string): IParsedAssetSide => {
  if (!present) {
    return {
      present: false,
      documents: [],
      roots: [],
      status: 'parsed',
      warnings: [],
      referencedGuids: [],
    }
  }
  try {
    const parsed = parseUnityYaml(content)
    const roots = buildHierarchy(parsed.documents)
    const warnings = [...parsed.warnings]
    const gameObjectCount = parsed.documents.filter(
      d => d.classId === 1 && !d.stripped
    ).length
    if (gameObjectCount > 0 && roots.length === 0) {
      warnings.push(
        `Hierarchy reconstruction produced no roots from ${gameObjectCount} GameObject(s) — unsupported prefab structure?`
      )
    }
    return {
      present: true,
      documents: parsed.documents,
      roots,
      status: parsed.status,
      warnings,
      referencedGuids: Array.from(collectReferencedGuids(parsed.documents)),
    }
  } catch (e) {
    return {
      present: true,
      documents: [],
      roots: [],
      status: 'invalid-yaml',
      warnings: [e instanceof Error ? e.message : String(e)],
      referencedGuids: [],
    }
  }
}

/** Read and parse one source by path (working tree), or null if absent. */
const resolveSourceDocs = async (
  repoPath: string,
  path: string
): Promise<ReadonlyArray<IUnitySerializedDocument> | null> => {
  try {
    if (isModelPath(path)) {
      const meta = await readFile(join(repoPath, `${path}.meta`), 'utf8')
      return buildModelDocuments(
        parseModelNameTable(meta),
        basename(path, extname(path))
      )
    }
    const content = await readFile(join(repoPath, path), 'utf8')
    return parseUnityYaml(content).documents
  } catch (e) {
    // A missing source file (the guid pointed at something no longer on disk)
    // is expected. Anything else — permission, IO, or a parse error — should
    // surface rather than silently dropping the source and floating whatever
    // referenced it.
    if (isErrnoException(e) && e.code === 'ENOENT') {
      return null
    }
    throw e
  }
}

const buildSourceMap = async (
  repoPath: string,
  rootDocuments: ReadonlyArray<IUnitySerializedDocument>,
  pathByGuid: ReadonlyMap<string, string>
): Promise<Map<string, ReadonlyArray<IUnitySerializedDocument>>> => {
  const existing = sourceCacheByRepo.get(repoPath)
  const repoCache: IRepoSourceCache =
    existing !== undefined && Date.now() - existing.builtAt < cacheTtlMs
      ? existing
      : { builtAt: Date.now(), entries: new Map() }
  sourceCacheByRepo.set(repoPath, repoCache)

  const map = new Map<string, ReadonlyArray<IUnitySerializedDocument>>()
  const seen = new Set<string>()
  let frontier: ReadonlyArray<string> = sourceGuidsOf(rootDocuments)

  while (frontier.length > 0 && map.size < maxSourcePrefabs) {
    const toFetch = new Array<{ guid: string; path: string }>()
    const next = new Array<string>()
    const enqueue = (docs: ReadonlyArray<IUnitySerializedDocument>) => {
      for (const guid of sourceGuidsOf(docs)) {
        if (!seen.has(guid)) {
          next.push(guid)
        }
      }
    }

    for (const guid of frontier) {
      if (seen.has(guid)) {
        continue
      }
      seen.add(guid)
      const cached = repoCache.entries.get(guid)
      if (cached !== undefined) {
        if (cached !== null) {
          map.set(guid, cached)
          enqueue(cached)
        }
        continue
      }
      const path = pathByGuid.get(guid)
      if (path !== undefined) {
        toFetch.push({ guid, path })
      }
    }

    const fetched = new Array<{
      guid: string
      docs: ReadonlyArray<IUnitySerializedDocument> | null
    }>(toFetch.length)
    let cursor = 0
    const reader = async (): Promise<void> => {
      while (cursor < toFetch.length) {
        const index = cursor++
        const { guid, path } = toFetch[index]
        fetched[index] = { guid, docs: await resolveSourceDocs(repoPath, path) }
      }
    }
    const lanes = Math.min(maxConcurrentReads, toFetch.length)
    await Promise.all(Array.from({ length: lanes }, reader))
    for (const { guid, docs } of fetched) {
      repoCache.entries.set(guid, docs)
      if (docs !== null) {
        map.set(guid, docs)
        enqueue(docs)
      }
    }

    frontier = next
  }
  return map
}

interface ILayerNamesCache {
  readonly builtAt: number
  readonly names: ReadonlyArray<string>
}
// Project layer names (index → name) per repository, read from
// TagManager.asset. Expires alongside the source cache so a Unity-side layer
// rename picks up on the next request.
const layerNamesByRepo = new Map<string, ILayerNamesCache>()

const readLayerNames = async (
  repoPath: string
): Promise<ReadonlyArray<string>> => {
  const cached = layerNamesByRepo.get(repoPath)
  if (cached !== undefined && Date.now() - cached.builtAt < cacheTtlMs) {
    return cached.names
  }
  let names: ReadonlyArray<string> = []
  try {
    const content = await readFile(
      join(repoPath, 'ProjectSettings/TagManager.asset'),
      'utf8'
    )
    const tagManager = parseUnityYaml(content).documents.find(
      d => d.classId === 78
    )
    const layers = tagManager?.properties.find(p => p.key === 'layers')?.value
    if (layers !== undefined && layers.kind === 'sequence') {
      names = layers.items.map(item =>
        item.kind === 'scalar' ? item.value : ''
      )
    }
  } catch (e) {
    // No TagManager (a repo that isn't a Unity project, or one that hasn't
    // committed its ProjectSettings) — fall back to built-in layer names.
    // Anything else is surfaced so we don't hide a real failure.
    if (!isErrnoException(e) || e.code !== 'ENOENT') {
      throw e
    }
  }
  layerNamesByRepo.set(repoPath, { builtAt: Date.now(), names })
  return names
}

const handleDiff = async (
  request: IUnityDiffRequest
): Promise<IUnityDiffResponse> => {
  const pathByGuid = new Map(request.pathByGuid)
  const before = parseSide(request.beforePresent, request.beforeContent)
  const after = parseSide(request.afterPresent, request.afterContent)
  const sources = await buildSourceMap(
    request.repoPath,
    [...before.documents, ...after.documents],
    pathByGuid
  )
  const { result, expandedBefore, expandedAfter } = computeUnityAssetDiff(
    before,
    after,
    sources,
    guid => pathByGuid.get(guid)
  )
  cacheDiff(request.requestKey, {
    before: indexById(expandedBefore),
    after: indexById(expandedAfter),
  })
  const layerNames = await readLayerNames(request.repoPath)
  return { id: request.id, kind: 'diff', result: { ...result, layerNames } }
}

const handleDocs = (request: IUnityDocsRequest): IUnityDocsResponse => {
  const cached = diffCache.get(request.requestKey)
  const documents = new Array<IUnityDocumentDiff>()
  if (cached !== undefined) {
    for (const id of request.fileIds) {
      const before = cached.before.get(id) ?? null
      const after = cached.after.get(id) ?? null
      if (before === null && after === null) {
        continue
      }
      documents.push(diffDocument(before, after))
    }
  }
  return { id: request.id, kind: 'docs', documents }
}

const port = parentPort

if (port !== null) {
  port.on('message', async (request: IUnityWorkerRequest) => {
    try {
      const response =
        request.kind === 'diff'
          ? await handleDiff(request)
          : handleDocs(request)
      port.postMessage(response)
    } catch (e) {
      const error: IUnityErrorResponse = {
        id: request.id,
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      }
      port.postMessage(error)
    }
  })
}
