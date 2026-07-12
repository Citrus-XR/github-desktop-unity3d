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
  IUnityPrefabOverrideDiff,
  IUnityResolvedGuid,
  IUnitySemanticDiffResult,
} from '../../models/unity/semantic-diff'
import { buildHierarchy } from './hierarchy-builder'
import { expandPrefabInstances, overrideAppliedKey } from './prefab-expansion'
import { computeSemanticDiff, IUnityParsedSide } from './semantic-diff'
import { diffPrefabInstances, sourcePrefabGuidOf } from './prefab-diff'
import {
  buildPrefabTargetIndex,
  IUnityPrefabTargetInfo,
} from './prefab-target-index'
import { collectReferencedGuids } from './reference-collector'

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
    instanceRoots?: Map<UnityFileId, UnityFileId>,
    sourceGuidByExpandedNode?: Map<UnityFileId, string>,
    sourceOriginByExpandedNode?: Map<string, UnityFileId>,
    appliedOverrides?: Set<string>
  ): IUnityParsedSide => {
    const expanded = expandPrefabInstances(
      documents,
      guid => sources.get(guid) ?? null,
      resolveName,
      instanceRoots,
      sourceGuidByExpandedNode,
      sourceOriginByExpandedNode,
      appliedOverrides
    )
    return { documents: expanded, roots: buildHierarchy(expanded) }
  }

  const instanceCount =
    sourceGuidsOf(before.documents).length +
    sourceGuidsOf(after.documents).length
  const shouldExpand = instanceCount > 0

  const afterInstanceRoots = new Map<UnityFileId, UnityFileId>()
  const beforeInstanceRoots = new Map<UnityFileId, UnityFileId>()
  // fileId (in the current file's expanded namespace) → the source-prefab
  // guid the object came from via a nested-prefab expansion. Missing entries
  // mean the object is native to the file being diffed.
  const sourceGuidByExpandedNode = new Map<UnityFileId, string>()
  // "guid::sourceFileId" → fileId of the object in the CURRENT expanded
  // namespace. Populated recursively so an override targeting any nested
  // source (direct or reach-through) resolves to its actual hierarchy node.
  // Prefer after-side because that's what the user is inspecting; fall back
  // to before-side for removed content.
  const afterSourceOrigin = new Map<string, UnityFileId>()
  const beforeSourceOrigin = new Map<string, UnityFileId>()
  // Override keys that the expansion successfully baked into a cloned doc on
  // each side. Their effect is already visible in the per-document property
  // diff so the enricher tags the matching override diff entries as
  // `applied` and the Inspector suppresses them from the override panel;
  // whichever side landed the override is enough — if only one side applied
  // (typical for a removed-only or added-only override) the doc diff on that
  // side still reflects the change.
  const beforeAppliedOverrides = new Set<string>()
  const afterAppliedOverrides = new Set<string>()
  const beforeSide: IUnityParsedSide = shouldExpand
    ? expandSide(
        before.documents,
        beforeInstanceRoots,
        sourceGuidByExpandedNode,
        beforeSourceOrigin,
        beforeAppliedOverrides
      )
    : { documents: before.documents, roots: before.roots }
  const afterSide: IUnityParsedSide = shouldExpand
    ? expandSide(
        after.documents,
        afterInstanceRoots,
        sourceGuidByExpandedNode,
        afterSourceOrigin,
        afterAppliedOverrides
      )
    : { documents: after.documents, roots: after.roots }

  const { roots, documents } = computeSemanticDiff(beforeSide, afterSide)
  // PrefabInstance (!u!1001) diffing runs against the ORIGINAL, un-expanded
  // documents on purpose: expandPrefabInstances drops the 1001s from its
  // output (their content is grafted into the tree instead), so an expanded
  // side never carries a 1001 to compare — running the override diff on the
  // pre-expansion sides is what surfaces per-override modification/add/remove.
  const prefabInstances = diffPrefabInstances(before.documents, after.documents)

  // Per-source target indexes shared across every instance that points at the
  // same source prefab. A single scene often instantiates the same prefab many
  // times; without this the walk would run once per instance for identical
  // input.
  //
  // The index is built off the FULLY EXPANDED source, not the raw source
  // documents: an override's `target.fileID` frequently points at an object
  // that lives deeper in a nested prefab (Unity permits reach-through), whose
  // id in the source's own file is only a stripped placeholder or a remapped
  // clone of a base object. Expanding the source materializes those into real
  // GameObjects/components so the lookup resolves to something with a name
  // and a hierarchy path instead of falling through to "Unresolved".
  const targetIndexByGuid = new Map<
    string,
    ReadonlyMap<UnityFileId, IUnityPrefabTargetInfo>
  >()
  const expandedSourceByGuid = new Map<
    string,
    ReadonlyArray<IUnitySerializedDocument>
  >()
  const expandSourceOnce = (
    guid: string
  ): ReadonlyArray<IUnitySerializedDocument> | undefined => {
    const cached = expandedSourceByGuid.get(guid)
    if (cached !== undefined) {
      return cached
    }
    const raw = sources.get(guid)
    if (raw === undefined) {
      return undefined
    }
    const expanded = expandPrefabInstances(
      raw,
      g => sources.get(g) ?? null,
      resolveName
    )
    expandedSourceByGuid.set(guid, expanded)
    return expanded
  }
  const targetIndexFor = (
    guid: string
  ): ReadonlyMap<UnityFileId, IUnityPrefabTargetInfo> | undefined => {
    const cached = targetIndexByGuid.get(guid)
    if (cached !== undefined) {
      return cached
    }
    const expanded = expandSourceOnce(guid)
    if (expanded === undefined) {
      return undefined
    }
    const index = buildPrefabTargetIndex(expanded, resolveName)
    targetIndexByGuid.set(guid, index)
    return index
  }

  // Unity re-serializes floats every time a scene is saved, so a rotated
  // GameObject accretes quaternion overrides whose axes wobble in their
  // last few significant digits without any real change. Detect this so the
  // Inspector can hide the drift behind "Show unchanged" instead of drowning
  // real edits in a wall of near-identical numbers. Nested paths (arrays,
  // maps) are left alone — the pattern is quaternion/vector scalars only.
  const floatDriftRelativeThreshold = 1e-5
  const scalarFloatValue = (
    value: IUnityPrefabOverrideDiff['before']
  ): number | undefined => {
    if (value === null || value.kind !== 'scalar') {
      return undefined
    }
    const parsed = Number(value.value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const isTrivialFloatDrift = (override: IUnityPrefabOverrideDiff): boolean => {
    if (override.status !== 'modified') {
      return false
    }
    const before = scalarFloatValue(override.before)
    const after = scalarFloatValue(override.after)
    if (before === undefined || after === undefined || before === after) {
      return false
    }
    const magnitude = Math.max(Math.abs(before), Math.abs(after))
    if (magnitude === 0) {
      return false
    }
    return Math.abs(before - after) / magnitude < floatDriftRelativeThreshold
  }

  const enrichOverride = (
    override: IUnityPrefabOverrideDiff,
    fallbackGuid: string | undefined,
    enclosingInstanceId: UnityFileId
  ): IUnityPrefabOverrideDiff => {
    const guid = override.targetGuid ?? fallbackGuid
    const index = guid !== undefined ? targetIndexFor(guid) : undefined
    const info = index?.get(override.targetFileId)
    const appliedKey = overrideAppliedKey(
      enclosingInstanceId,
      override.targetGuid,
      override.targetFileId,
      override.propertyPath
    )
    const isApplied =
      beforeAppliedOverrides.has(appliedKey) ||
      afterAppliedOverrides.has(appliedKey)
    let withMeta: IUnityPrefabOverrideDiff = override
    if (isApplied) {
      withMeta = { ...withMeta, applied: true }
    }
    if (isTrivialFloatDrift(override)) {
      withMeta = { ...withMeta, trivialFloatDrift: true }
    }
    // Look up the target in the CURRENT file's expanded namespace via the
    // recursive origin map. Handles both direct (target.guid === enclosing
    // .sourcePrefabGuid) and deep reach-through (target.guid is a further-
    // nested source) — the map was populated for all `(guid, sourceFileId)`
    // pairs during expansion, so any reachable target resolves in one lookup.
    // Key includes enclosingInstanceId so multiple instances of the same
    // source prefab (two KanbanYukata → two WebLauncherDialog clones) stay
    // distinct instead of aggregating on one node. AFTER wins over BEFORE so
    // the badge follows the current state; removed objects fall back to
    // their before-side position.
    const lookup = (sourceFileId: UnityFileId | undefined) => {
      if (guid === undefined || sourceFileId === undefined) {
        return undefined
      }
      const key = `${enclosingInstanceId}::${guid}::${sourceFileId}`
      return afterSourceOrigin.get(key) ?? beforeSourceOrigin.get(key)
    }
    const expandedTargetGameObjectFileId = lookup(
      info?.ownerGameObjectFileId ?? override.targetFileId
    )
    // The target itself (component or GameObject) — used to route the override
    // into the correct component section in the Inspector rather than piling
    // every override onto one "Prefab overrides" block at the top.
    const expandedTargetFileId = lookup(override.targetFileId)
    if (info === undefined) {
      if (
        expandedTargetGameObjectFileId === undefined &&
        expandedTargetFileId === undefined
      ) {
        return withMeta
      }
      return {
        ...withMeta,
        expandedTargetGameObjectFileId,
        expandedTargetFileId,
      }
    }
    const label =
      info.kind === 'GameObject'
        ? info.ownerName.length > 0
          ? info.ownerName
          : withMeta.targetLabel
        : `${info.ownerName.length > 0 ? info.ownerName : '(unnamed)'} (${
            info.componentType ?? 'Component'
          })`
    return {
      ...withMeta,
      targetLabel: label,
      targetKind: info.kind,
      targetGameObjectFileId: info.ownerGameObjectFileId,
      targetGameObjectPath: info.ownerPath,
      targetGameObjectName: info.ownerName,
      targetComponentType: info.componentType,
      expandedTargetGameObjectFileId,
      expandedTargetFileId,
    }
  }

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
    // Instance existed on both sides: prefer the AFTER-side placeholders so
    // the current state drives resolution. A removed instance falls back to
    // BEFORE (that's where it lived); an added one falls back to AFTER.
    return {
      ...instance,
      sourcePrefabPath,
      name,
      // Removed instances have no after-side expansion; fall back to where they
      // WERE in the before-side tree so the hierarchy still surfaces them under
      // the right parent instead of dumping them into a top-level fallback.
      nodeFileId:
        afterInstanceRoots.get(instance.fileId) ??
        beforeInstanceRoots.get(instance.fileId),
      overrides: instance.overrides.map(o =>
        enrichOverride(o, instance.sourcePrefabGuid, instance.fileId)
      ),
    }
  })

  // GUIDs whose paths the Inspector needs to render: the ones referenced in
  // the raw file (m_Script, materials, etc.), the source-prefab GUIDs of every
  // PrefabInstance, AND every GUID reachable through the expanded namespace —
  // the cloned docs surfaced by expansion pull in script and material refs
  // that live in nested prefabs and therefore never appear in the outer
  // file's raw text. Missing those leaves a MonoBehaviour heading rendered as
  // its raw script GUID instead of the friendly script name.
  const guids = new Set<string>([
    ...before.referencedGuids,
    ...after.referencedGuids,
    ...sourceGuidsOf(before.documents),
    ...sourceGuidsOf(after.documents),
    ...(shouldExpand ? collectReferencedGuids(beforeSide.documents) : []),
    ...(shouldExpand ? collectReferencedGuids(afterSide.documents) : []),
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

  // Convert the guid map to a path map so the Inspector can render a
  // human-friendly "Prefab: X.prefab" badge without another async lookup.
  const sourcePrefabByExpandedNode = new Array<readonly [UnityFileId, string]>()
  for (const [fileId, guid] of sourceGuidByExpandedNode) {
    const path = pathForGuid(guid)
    if (path !== undefined) {
      sourcePrefabByExpandedNode.push([fileId, path])
    }
  }

  return {
    result: {
      status,
      roots,
      documents,
      prefabInstances: enrichedInstances,
      resolvedGuids,
      sourcePrefabByExpandedNode,
      warnings: [...before.warnings, ...after.warnings],
    },
    expandedBefore: beforeSide.documents,
    expandedAfter: afterSide.documents,
  }
}
