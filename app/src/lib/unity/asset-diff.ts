/**
 * Pure expand → diff → enrich pipeline for one Unity asset's two parsed sides.
 * This is the CPU-heavy core that the inspection worker runs off the main
 * process: it materializes prefab instances, builds the merged hierarchy diff,
 * and enriches prefab-instance diffs with resolved paths and names. It performs
 * no I/O — source prefabs are supplied by the caller (read from the working
 * tree) and GUIDs resolve through `pathForGuid`. Alongside the renderer-bound
 * result it returns the expanded documents of each side so the caller can serve
 * a single document's property diff on demand (the result itself carries only
 * the changed documents).
 */

import {
  IUnityGameObjectNode,
  IUnitySerializedDocument,
  UnityFileId,
  UnityParseStatus,
} from '../../models/unity/serialized-asset'
import {
  IUnityResolvedGuid,
  IUnitySemanticDiffResult,
} from '../../models/unity/semantic-diff'
import { buildHierarchy } from './hierarchy-builder'
import { expandPrefabInstances } from './prefab-expansion'
import { computeSemanticDiff, IUnityParsedSide } from './semantic-diff'
import { diffPrefabInstances, sourcePrefabGuidOf } from './prefab-diff'

/** The basename of a `/`-separated path with its final extension removed. */
export const basenameWithoutExtension = (path: string): string => {
  const file = path.slice(path.lastIndexOf('/') + 1)
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

/** The basename of a `/`-separated path with a specific suffix removed. */
const basenameWithoutSuffix = (path: string, suffix: string): string => {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.endsWith(suffix) ? file.slice(0, -suffix.length) : file
}

export interface IParsedAssetSide {
  readonly present: boolean
  readonly documents: ReadonlyArray<IUnitySerializedDocument>
  readonly roots: ReadonlyArray<IUnityGameObjectNode>
  readonly status: UnityParseStatus
  readonly warnings: ReadonlyArray<string>
  readonly referencedGuids: ReadonlyArray<string>
}

export interface IComputedAssetDiff {
  readonly result: IUnitySemanticDiffResult
  /** Expanded documents per side, kept so a node's diff can be served later. */
  readonly expandedBefore: ReadonlyArray<IUnitySerializedDocument>
  readonly expandedAfter: ReadonlyArray<IUnitySerializedDocument>
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

export const computeUnityAssetDiff = (
  before: IParsedAssetSide,
  after: IParsedAssetSide,
  sources: ReadonlyMap<string, ReadonlyArray<IUnitySerializedDocument>>,
  pathForGuid: (guid: string) => string | undefined
): IComputedAssetDiff => {
  const resolveName = (guid: string): string | undefined => {
    const path = pathForGuid(guid)
    return path !== undefined ? basenameWithoutExtension(path) : undefined
  }

  const expandSide = (
    documents: ReadonlyArray<IUnitySerializedDocument>,
    instanceRoots?: Map<UnityFileId, UnityFileId>
  ): IUnityParsedSide => {
    const expanded = expandPrefabInstances(
      documents,
      guid => sources.get(guid) ?? null,
      resolveName,
      instanceRoots
    )
    return { documents: expanded, roots: buildHierarchy(expanded) }
  }

  const instanceCount =
    sourceGuidsOf(before.documents).length +
    sourceGuidsOf(after.documents).length
  const shouldExpand = instanceCount > 0

  const afterInstanceRoots = new Map<UnityFileId, UnityFileId>()
  const beforeSide: IUnityParsedSide = shouldExpand
    ? expandSide(before.documents)
    : { documents: before.documents, roots: before.roots }
  const afterSide: IUnityParsedSide = shouldExpand
    ? expandSide(after.documents, afterInstanceRoots)
    : { documents: after.documents, roots: after.roots }

  const { roots, documents } = computeSemanticDiff(beforeSide, afterSide)
  // PrefabInstance (!u!1001) diffing runs against the ORIGINAL, un-expanded
  // documents on purpose: expandPrefabInstances drops the 1001s from its
  // output (their content is grafted into the tree instead), so an expanded
  // side never carries a 1001 to compare — running the override diff on the
  // pre-expansion sides is what surfaces per-override modification/add/remove.
  const prefabInstances = diffPrefabInstances(before.documents, after.documents)

  const enrichedInstances = prefabInstances.map(instance => {
    const sourcePrefabPath =
      instance.sourcePrefabGuid !== undefined
        ? pathForGuid(instance.sourcePrefabGuid)
        : undefined
    const name =
      instance.name.length > 0
        ? instance.name
        : sourcePrefabPath !== undefined
        ? basenameWithoutSuffix(sourcePrefabPath, '.prefab')
        : '(prefab instance)'
    return {
      ...instance,
      sourcePrefabPath,
      name,
      nodeFileId: afterInstanceRoots.get(instance.fileId),
    }
  })

  const guids = new Set<string>([
    ...before.referencedGuids,
    ...after.referencedGuids,
    ...sourceGuidsOf(before.documents),
    ...sourceGuidsOf(after.documents),
  ])
  const resolvedGuids = new Array<IUnityResolvedGuid>()
  for (const guid of guids) {
    const path = pathForGuid(guid)
    if (path !== undefined) {
      resolvedGuids.push({ guid, path })
    }
  }

  // The after side governs presentation; fall back to the before side for a
  // deleted file. A non-`parsed` status drives the renderer's text fallback.
  const status: UnityParseStatus =
    (after.present ? after.status : undefined) ??
    (before.present ? before.status : undefined) ??
    'invalid-yaml'

  return {
    result: {
      status,
      roots,
      documents,
      prefabInstances: enrichedInstances,
      resolvedGuids,
      warnings: [...before.warnings, ...after.warnings],
    },
    expandedBefore: beforeSide.documents,
    expandedAfter: afterSide.documents,
  }
}
