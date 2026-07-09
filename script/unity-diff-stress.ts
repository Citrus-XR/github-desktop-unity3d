/**
 * Stress-test harness for the Unity semantic-diff pipeline. Walks every commit
 * in a target repository, and for each Unity asset changed in that commit,
 * runs the full parse → expand → diff pipeline on both sides. Any thrown
 * exception is caught, printed with commit + file context, and counted; the
 * walk continues so one bad file doesn't stop the run.
 *
 * Usage:
 *   node --import tsx script/unity-diff-stress.ts <repoPath> [--limit N] [--from <sha>] [--verbose]
 *
 * Not part of the test suite (script/test.mjs matches only `*-test.ts`).
 */

import { execFileSync, spawnSync } from 'child_process'
import { readFileSync } from 'fs'

import { parseUnityYaml } from '../app/src/lib/unity/unity-yaml-parser'
import { buildHierarchy } from '../app/src/lib/unity/hierarchy-builder'
import { collectReferencedGuids } from '../app/src/lib/unity/reference-collector'
import {
  computeUnityAssetDiff,
  IParsedAssetSide,
} from '../app/src/lib/unity/asset-diff'
import { getWorkingTreeMetaIndex } from '../app/src/main-process/unity/meta-scanner'
import {
  buildModelDocuments,
  isModelPath,
  parseModelNameTable,
} from '../app/src/lib/unity/model-prefab'
import { IUnitySerializedDocument } from '../app/src/models/unity/serialized-asset'
import { isUnityAssetPath } from '../app/src/lib/unity/unity-asset-path'
import { isErrnoException } from '../app/src/lib/errno-exception'

interface IArgs {
  readonly repo: string
  readonly limit: number | null
  readonly from: string | null
  readonly verbose: boolean
}

const parseArgs = (argv: ReadonlyArray<string>): IArgs => {
  const positional: string[] = []
  let repo: string | null = null
  let limit: number | null = null
  let from: string | null = null
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--limit') {
      limit = Number(argv[++i])
      continue
    }
    if (a === '--from') {
      from = argv[++i]
      continue
    }
    if (a === '--verbose') {
      verbose = true
      continue
    }
    if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`)
      process.exit(2)
    }
    positional.push(a)
  }
  if (positional.length !== 1) {
    console.error(
      'usage: unity-diff-stress.ts <repoPath> [--limit N] [--from <sha>] [--verbose]'
    )
    process.exit(2)
  }
  repo = positional[0]
  return { repo, limit, from, verbose }
}

const args = parseArgs(process.argv.slice(2))

const gitOutput = (repo: string, ...gitArgs: string[]): string =>
  execFileSync('git', ['-C', repo, ...gitArgs], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })

const gitShow = (repo: string, ref: string, path: string): string | null => {
  // exec instead of execFile to distinguish "path missing at ref" (exit 128)
  // from a hard git failure.
  const result = spawnSync('git', ['-C', repo, 'show', `${ref}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })
  return result.status === 0 ? result.stdout : null
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
  const parsed = parseUnityYaml(content)
  return {
    present: true,
    documents: parsed.documents,
    roots: buildHierarchy(parsed.documents),
    status: parsed.status,
    warnings: [...parsed.warnings],
    referencedGuids: Array.from(collectReferencedGuids(parsed.documents)),
  }
}

const guidsOfPrefabInstances = (
  docs: ReadonlyArray<IUnitySerializedDocument>
): ReadonlyArray<string> => {
  const out: string[] = []
  for (const d of docs) {
    if (d.classId !== 1001) {
      continue
    }
    const s = d.properties.find(p => p.key === 'm_SourcePrefab')
    if (
      s?.value?.kind === 'reference' &&
      s.value.reference.guid !== undefined
    ) {
      out.push(s.value.reference.guid)
    }
  }
  return out
}

interface ISourceOutcome {
  readonly docs: ReadonlyArray<IUnitySerializedDocument> | null
  /** Set when the source read/parse threw and we intend to surface it. */
  readonly error?: Error
}

// The service reads sources with a per-repo cache; mirror that so a
// large-scene stress run doesn't re-parse the same source prefab thousands of
// times. `null` means resolved-but-absent; an error means the parse itself
// blew up and needs to surface as a failure (the production service throws
// too — the harness's job is to catch it visibly, not to swallow like the
// old broad catch).
const sourceCache = new Map<string, ISourceOutcome>()

const resolveSource = (
  repo: string,
  pathByGuid: ReadonlyMap<string, string>,
  guid: string
): ISourceOutcome => {
  const cached = sourceCache.get(guid)
  if (cached !== undefined) {
    return cached
  }
  const path = pathByGuid.get(guid)
  if (path === undefined) {
    const outcome: ISourceOutcome = { docs: null }
    sourceCache.set(guid, outcome)
    return outcome
  }
  const readMeta = (metaPath: string): string | null => {
    try {
      return readFileSync(`${repo}/${metaPath}`, 'utf8')
    } catch (e) {
      // A missing source file is expected: an asset can reference a guid
      // that has been deleted or moved. Anything else — bad permissions,
      // decode failure — surfaces so the harness sees it.
      if (isErrnoException(e) && e.code === 'ENOENT') {
        return null
      }
      throw e
    }
  }
  try {
    if (isModelPath(path)) {
      const meta = readMeta(`${path}.meta`)
      if (meta === null) {
        const outcome: ISourceOutcome = { docs: null }
        sourceCache.set(guid, outcome)
        return outcome
      }
      const table = parseModelNameTable(meta)
      const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
      const docs = buildModelDocuments(table, base)
      const outcome: ISourceOutcome = { docs }
      sourceCache.set(guid, outcome)
      return outcome
    }
    const content = readMeta(path)
    if (content === null) {
      const outcome: ISourceOutcome = { docs: null }
      sourceCache.set(guid, outcome)
      return outcome
    }
    const docs = parseUnityYaml(content).documents
    const outcome: ISourceOutcome = { docs }
    sourceCache.set(guid, outcome)
    return outcome
  } catch (e) {
    // Any thrown error (parse failure, permission, etc.) is cached AS a
    // failure — repeated lookups for the same guid re-raise it via the
    // caller so the stress run reports the underlying bug rather than the
    // secondary consequence of it.
    const outcome: ISourceOutcome = {
      docs: null,
      error: e instanceof Error ? e : new Error(String(e)),
    }
    sourceCache.set(guid, outcome)
    return outcome
  }
}

const buildSourceMap = (
  repo: string,
  pathByGuid: ReadonlyMap<string, string>,
  seedDocs: ReadonlyArray<IUnitySerializedDocument>
): Map<string, ReadonlyArray<IUnitySerializedDocument>> => {
  const map = new Map<string, ReadonlyArray<IUnitySerializedDocument>>()
  const seen = new Set<string>()
  let frontier: string[] = [...guidsOfPrefabInstances(seedDocs)]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const guid of frontier) {
      if (seen.has(guid)) {
        continue
      }
      seen.add(guid)
      const outcome = resolveSource(repo, pathByGuid, guid)
      if (outcome.error !== undefined) {
        // Re-raise the first source failure so the outer try/catch attributes
        // it to the current commit + file the harness is processing.
        throw outcome.error
      }
      if (outcome.docs === null) {
        continue
      }
      map.set(guid, outcome.docs)
      for (const g of guidsOfPrefabInstances(outcome.docs)) {
        if (!seen.has(g)) {
          next.push(g)
        }
      }
    }
    frontier = next
  }
  return map
}

interface IFailure {
  readonly commit: string
  readonly file: string
  readonly stage: string
  readonly message: string
  readonly stack: string
}

const failures: IFailure[] = []
let filesProcessed = 0
let commitsProcessed = 0
let commitsSkipped = 0

const run = async () => {
  const t0 = Date.now()
  console.log(
    `stress: repo=${args.repo}${
      args.limit !== null ? ` limit=${args.limit}` : ''
    }${args.from !== null ? ` from=${args.from}` : ''}`
  )

  const metaIndex = await getWorkingTreeMetaIndex(args.repo)
  const pathByGuid = metaIndex.toPathByGuid()
  console.log(`meta index: ${metaIndex.size} entries, ${Date.now() - t0}ms`)

  // Newest first; the file list is what we iterate.
  const range = args.from !== null ? `${args.from}` : 'HEAD'
  const commits = gitOutput(args.repo, 'log', '--format=%H', range)
    .split('\n')
    .filter(l => l.length > 0)
  const list = args.limit !== null ? commits.slice(0, args.limit) : commits
  console.log(`commits to walk: ${list.length}`)

  for (let i = 0; i < list.length; i++) {
    const commit = list[i]
    // First commit has no parent; skip it (nothing to diff against).
    const parentRaw = spawnSync(
      'git',
      ['-C', args.repo, 'rev-parse', `${commit}^`],
      { encoding: 'utf8' }
    )
    if (parentRaw.status !== 0) {
      commitsSkipped++
      continue
    }
    const parent = parentRaw.stdout.trim()

    // Which files changed between parent and commit.
    let changedFiles: string[]
    try {
      changedFiles = gitOutput(args.repo, 'diff', '--name-only', parent, commit)
        .split('\n')
        .filter(f => f.length > 0)
    } catch (e: unknown) {
      failures.push({
        commit,
        file: '',
        stage: 'git diff --name-only',
        message: (e as Error).message,
        stack: (e as Error).stack ?? '',
      })
      continue
    }

    const unityFiles = changedFiles.filter(isUnityAssetPath)
    for (const file of unityFiles) {
      filesProcessed++
      try {
        const beforeContent = gitShow(args.repo, parent, file)
        const afterContent = gitShow(args.repo, commit, file)
        if (beforeContent === null && afterContent === null) {
          continue
        }

        const before = parseSide(beforeContent !== null, beforeContent ?? '')
        const after = parseSide(afterContent !== null, afterContent ?? '')

        const sources = buildSourceMap(args.repo, pathByGuid, [
          ...before.documents,
          ...after.documents,
        ])
        const { result } = computeUnityAssetDiff(before, after, sources, g =>
          pathByGuid.get(g)
        )
        if (args.verbose) {
          const changedNodes = countChangedNodes(result.roots)
          const changedPrefabs = result.prefabInstances.filter(
            p => p.status !== 'unchanged'
          ).length
          console.log(
            `  ${commit.slice(0, 7)} ${file}: status=${
              result.status
            } nodes.changed=${changedNodes} prefabs.changed=${changedPrefabs}`
          )
        }
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e))
        failures.push({
          commit,
          file,
          stage: 'diff pipeline',
          message: err.message,
          stack: err.stack ?? '',
        })
        console.error(
          `\n[FAIL] commit ${commit.slice(0, 12)} file ${file}\n  ${
            err.message
          }`
        )
      }
    }

    commitsProcessed++
    if ((i + 1) % 25 === 0) {
      const elapsed = Math.round((Date.now() - t0) / 1000)
      console.log(
        `  ...${i + 1}/${list.length} commits (${filesProcessed} files, ${
          failures.length
        } failures, ${elapsed}s)`
      )
    }
  }

  const seconds = Math.round((Date.now() - t0) / 1000)
  console.log(
    `\ndone: commits=${commitsProcessed} skipped=${commitsSkipped} files=${filesProcessed} failures=${failures.length} elapsed=${seconds}s`
  )

  if (failures.length > 0) {
    console.log(`\nfailures (${failures.length}):`)
    for (const f of failures) {
      console.log(`\n  commit=${f.commit}`)
      console.log(`  file=${f.file}`)
      console.log(`  stage=${f.stage}`)
      console.log(`  message=${f.message}`)
      if (args.verbose) {
        console.log(`  stack=${f.stack}`)
      }
    }
    process.exit(1)
  }
}

const countChangedNodes = (nodes: ReadonlyArray<any>): number => {
  let n = 0
  for (const node of nodes) {
    if (node.status !== 'unchanged') {
      n++
    }
    n += countChangedNodes(node.children)
  }
  return n
}

run().catch(e => {
  console.error('harness crashed:', e)
  process.exit(2)
})
