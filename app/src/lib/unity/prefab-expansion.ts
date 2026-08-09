/**
 * Expands prefab instances by grafting the source prefab's objects into the
 * asset. A `!u!1001 PrefabInstance` only stores overrides; the instantiated
 * objects live in the source `.prefab`. We clone the source documents, remap
 * their fileIDs into the instance's id space (Unity derives an instance object
 * id by XOR-ing the PrefabInstance id with the source object id), reparent the
 * instance root via `m_TransformParent`, apply structural overrides (renames,
 * removed objects), splice added components/GameObjects, and recurse for
 * nested prefabs.
 *
 * Value-level overrides (`m_LocalPosition.x`, `m_Materials.Array.data[0]`,
 * `objectReference:` swaps, etc.) are also baked into the cloned properties
 * so the merged per-side documents already reflect Unity's effective state.
 * A change like "remove one prefab-override entry" then surfaces as an
 * ordinary property diff (override value → source default) instead of as a
 * dangling "removed override" row that the reader has to mentally re-apply.
 *
 * Overrides whose target or property path do not resolve in the expanded
 * namespace are absent from the `appliedOverrides` out set, so the enricher
 * in `asset-diff` can tell them apart from the applied ones and the
 * Inspector still surfaces them under an "Unresolved" bucket.
 */

import {
  IUnityObjectReference,
  IUnitySerializedDocument,
  UnityFileId,
  IUnityPropertyNode,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'
import { transformClassIds } from '../../models/unity/class-ids'
/** Resolve a source prefab's parsed documents by GUID (null if unavailable). */
export type SourcePrefabResolver = (
  guid: string
) => ReadonlyArray<IUnitySerializedDocument> | null

/** Resolve a source prefab/model's display name (file basename) by GUID. */
export type SourceNameResolver = (guid: string) => string | undefined

const prefabInstanceClassId = 1001
const signMask = 0x7fffffffffffffffn

// Sentinel XOR'd into a placeholder Transform's id to derive a synthesized
// GameObject id for it (see the second pass in expandPrefabInstances). Keeps
// the id numeric so it survives further `remap` calls at outer expansion
// levels; bit 62 stays inside the 63-bit fileID space and is far above any
// densely packed real ids.
const dummyGameObjectSentinel = 1n << 62n

const scalarOf = (value: UnityPropertyValue | undefined): string | undefined =>
  value !== undefined && value.kind === 'scalar' ? value.value : undefined

/**
 * Derive an instance object's fileID from the PrefabInstance id and the source
 * object id (`(P ^ S) & 0x7fff…`). Matches the ids Unity writes for stripped
 * placeholders, so clones replace them and existing references resolve.
 */
export const remapFileId = (
  prefabInstanceId: UnityFileId,
  sourceFileId: UnityFileId
): UnityFileId =>
  ((BigInt(prefabInstanceId) ^ BigInt(sourceFileId)) & signMask).toString()

type Remap = (sourceFileId: UnityFileId) => UnityFileId

// The remapping functions below preserve object identity when nothing changes:
// a value whose subtree holds no remappable reference is returned as-is rather
// than deep-cloned. Expanded prefab content is mostly reference-free scalar data
// (component serialized fields), so sharing those subtrees across the clone
// avoids allocating millions of identical objects on a large scene.

const remapReference = (
  ref: IUnityObjectReference,
  remap: Remap
): IUnityObjectReference => {
  if (ref.guid !== undefined || ref.fileId === '0') {
    return ref
  }
  const fileId = remap(ref.fileId)
  return fileId === ref.fileId ? ref : { ...ref, fileId }
}

const remapValue = (
  value: UnityPropertyValue,
  remap: Remap
): UnityPropertyValue => {
  switch (value.kind) {
    case 'scalar':
      return value
    case 'reference': {
      const reference = remapReference(value.reference, remap)
      return reference === value.reference
        ? value
        : { kind: 'reference', reference }
    }
    case 'map': {
      let changed = false
      const entries = value.entries.map(e => {
        const v = remapValue(e.value, remap)
        if (v === e.value) {
          return e
        }
        changed = true
        return { key: e.key, value: v }
      })
      return changed ? { kind: 'map', entries } : value
    }
    case 'sequence': {
      let changed = false
      const items = value.items.map(item => {
        const v = remapValue(item, remap)
        if (v !== item) {
          changed = true
        }
        return v
      })
      return changed ? { kind: 'sequence', items } : value
    }
  }
}

const cloneDocument = (
  doc: IUnitySerializedDocument,
  remap: Remap
): IUnitySerializedDocument => {
  let changed = false
  const properties = doc.properties.map(n => {
    const v = remapValue(n.value, remap)
    if (v === n.value) {
      return n
    }
    changed = true
    return { key: n.key, value: v }
  })
  return {
    classId: doc.classId,
    fileId: remap(doc.fileId),
    typeName: doc.typeName,
    rootKey: doc.rootKey,
    properties: changed ? properties : doc.properties,
    stripped: false,
    rawTextRange: doc.rawTextRange,
  }
}

const findProperty = (
  properties: ReadonlyArray<IUnityPropertyNode>,
  key: string
): UnityPropertyValue | undefined => properties.find(n => n.key === key)?.value

const referenceFileId = (
  value: UnityPropertyValue | undefined
): UnityFileId | undefined =>
  value !== undefined && value.kind === 'reference'
    ? value.reference.fileId
    : undefined

const setProperty = (
  properties: ReadonlyArray<IUnityPropertyNode>,
  key: string,
  value: UnityPropertyValue
): ReadonlyArray<IUnityPropertyNode> => {
  let replaced = false
  const next = properties.map(n => {
    if (n.key === key) {
      replaced = true
      return { key, value }
    }
    return n
  })
  return replaced ? next : [...next, { key, value }]
}

/** Typed override value: a scalar string or a resolved object reference. */
type UnityOverrideValue =
  | { readonly kind: 'scalar'; readonly value: string }
  | { readonly kind: 'reference'; readonly reference: IUnityObjectReference }

/**
 * Property path segment. Unity paths mix keys (`.m_LocalPosition`), array
 * indexing (`[0]`), and a special `.size` at the tail of `Array.size`
 * expressions. The `Array` and `data` tokens Unity inserts around array
 * indexing are stripped by the parser — our value tree exposes sequences
 * directly, without those wrapper layers.
 */
type PathSegment =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'size' }

/** Tokens are either bare identifiers or `[digits]` bracket groups. */
const pathTokenRegex = /([A-Za-z_][\w]*)|\[(\d+)\]/g

const parsePropertyPath = (path: string): ReadonlyArray<PathSegment> => {
  const segments = new Array<PathSegment>()
  pathTokenRegex.lastIndex = 0
  let match: RegExpExecArray | null
  let insideArray = false
  while ((match = pathTokenRegex.exec(path)) !== null) {
    const identifier = match[1]
    if (identifier !== undefined) {
      if (identifier === 'Array') {
        insideArray = true
        continue
      }
      if (identifier === 'data' && insideArray) {
        // `.Array.data[N]` — the `data` layer is transparent in our tree.
        continue
      }
      if (identifier === 'size' && insideArray) {
        segments.push({ kind: 'size' })
        insideArray = false
        continue
      }
      insideArray = false
      segments.push({ kind: 'key', key: identifier })
    } else {
      segments.push({ kind: 'index', index: parseInt(match[2], 10) })
      insideArray = false
    }
  }
  return segments
}

const arraySizeOf = (value: UnityOverrideValue): number | undefined => {
  if (value.kind !== 'scalar' || !/^\d+$/.test(value.value)) {
    return undefined
  }
  const size = Number(value.value)
  return Number.isSafeInteger(size) ? size : undefined
}

/** Build a fresh value subtree from the tail of a path (used when a key or */
/** index is missing from the base clone and we still want to bake it in). */
const buildValueForPath = (
  segments: ReadonlyArray<PathSegment>,
  value: UnityOverrideValue
): UnityPropertyValue | undefined => {
  if (segments.length === 0) {
    return value
  }
  const seg = segments[0]
  const rest = segments.slice(1)
  if (seg.kind === 'key') {
    const child = buildValueForPath(rest, value)
    if (child === undefined) {
      return undefined
    }
    return {
      kind: 'map',
      entries: [{ key: seg.key, value: child }],
    }
  }
  if (seg.kind === 'index') {
    const child = buildValueForPath(rest, value)
    if (child === undefined) {
      return undefined
    }
    const items = new Array<UnityPropertyValue>()
    for (let i = 0; i < seg.index; i++) {
      items.push({ kind: 'scalar', value: '' })
    }
    items.push(child)
    return { kind: 'sequence', items }
  }
  const size = rest.length === 0 ? arraySizeOf(value) : undefined
  return size !== undefined
    ? {
        kind: 'sequence',
        items: Array.from({ length: size }, () => ({
          kind: 'scalar' as const,
          value: '',
        })),
      }
    : undefined
}

/**
 * Apply an override value at `segments` inside `current`. `undefined` means the
 * path could not be resolved. A successful result may be the original value
 * when the override already equals the source value.
 */
const applyOverrideAtPath = (
  current: UnityPropertyValue,
  segments: ReadonlyArray<PathSegment>,
  value: UnityOverrideValue
): UnityPropertyValue | undefined => {
  if (segments.length === 0) {
    return value
  }
  const seg = segments[0]
  const rest = segments.slice(1)
  if (seg.kind === 'key') {
    if (current.kind !== 'map') {
      return undefined
    }
    const idx = current.entries.findIndex(e => e.key === seg.key)
    if (idx < 0) {
      const built = buildValueForPath(rest, value)
      if (built === undefined) {
        return undefined
      }
      return {
        kind: 'map',
        entries: [...current.entries, { key: seg.key, value: built }],
      }
    }
    const entry = current.entries[idx]
    const nextSubValue = applyOverrideAtPath(entry.value, rest, value)
    if (nextSubValue === undefined) {
      return undefined
    }
    if (nextSubValue === entry.value) {
      return current
    }
    const entries = current.entries.slice()
    entries[idx] = { key: seg.key, value: nextSubValue }
    return { kind: 'map', entries }
  }
  if (seg.kind === 'index') {
    const sequence =
      current.kind === 'sequence'
        ? current
        : current.kind === 'scalar' && current.value.length === 0
        ? { kind: 'sequence' as const, items: [] }
        : undefined
    if (sequence === undefined) {
      return undefined
    }
    if (seg.index >= sequence.items.length) {
      const child = buildValueForPath(rest, value)
      if (child === undefined) {
        return undefined
      }
      const items = sequence.items.slice()
      while (items.length < seg.index) {
        items.push({ kind: 'scalar', value: '' })
      }
      items.push(child)
      return { kind: 'sequence', items }
    }
    const item = sequence.items[seg.index]
    const nextItem = applyOverrideAtPath(item, rest, value)
    if (nextItem === undefined) {
      return undefined
    }
    if (nextItem === item) {
      return sequence
    }
    const items = sequence.items.slice()
    items[seg.index] = nextItem
    return { kind: 'sequence', items }
  }
  const sequence =
    current.kind === 'sequence'
      ? current
      : current.kind === 'scalar' && current.value.length === 0
      ? { kind: 'sequence' as const, items: [] }
      : undefined
  const nextSize = arraySizeOf(value)
  if (sequence === undefined || nextSize === undefined) {
    return undefined
  }
  if (nextSize === sequence.items.length) {
    return sequence
  }
  if (nextSize > sequence.items.length) {
    const items = sequence.items.slice()
    while (items.length < nextSize) {
      items.push({ kind: 'scalar', value: '' })
    }
    return { kind: 'sequence', items }
  }
  return { kind: 'sequence', items: sequence.items.slice(0, nextSize) }
}

interface IModification {
  readonly targetFileId: UnityFileId
  readonly propertyPath: string
  readonly segments: ReadonlyArray<PathSegment>
  readonly value: UnityOverrideValue
}

const modificationsOf = (
  doc: IUnitySerializedDocument
): ReadonlyArray<IModification> => {
  const modification = findProperty(doc.properties, 'm_Modification')
  if (modification === undefined || modification.kind !== 'map') {
    return []
  }
  const list = findProperty(modification.entries, 'm_Modifications')
  if (list === undefined || list.kind !== 'sequence') {
    return []
  }
  const result = new Array<IModification>()
  for (const item of list.items) {
    if (item.kind !== 'map') {
      continue
    }
    const target = referenceFileId(findProperty(item.entries, 'target'))
    const path = findProperty(item.entries, 'propertyPath')
    if (target === undefined || path === undefined || path.kind !== 'scalar') {
      continue
    }
    const segments = parsePropertyPath(path.value)
    if (segments.length === 0) {
      continue
    }
    const rawValue = findProperty(item.entries, 'value')
    const scalarValue =
      rawValue !== undefined && rawValue.kind === 'scalar'
        ? rawValue.value
        : undefined
    // Unity writes both `value` and `objectReference` on each modification and
    // exactly one is meaningful. A non-empty scalar wins outright; otherwise a
    // non-zero object reference is the payload; otherwise the empty scalar is
    // an explicit "cleared to empty" override.
    let value: UnityOverrideValue
    if (scalarValue !== undefined && scalarValue.length > 0) {
      value = { kind: 'scalar', value: scalarValue }
    } else {
      const objectReference = findProperty(item.entries, 'objectReference')
      if (
        objectReference !== undefined &&
        objectReference.kind === 'reference' &&
        objectReference.reference.fileId !== '0'
      ) {
        value = objectReference
      } else {
        value = { kind: 'scalar', value: scalarValue ?? '' }
      }
    }
    result.push({
      targetFileId: target,
      propertyPath: path.value,
      segments,
      value,
    })
  }
  return result
}

/**
 * Stable key identifying a single override. Shared between the expansion pass
 * (which records "applied" outcomes) and the enrichment pass in `asset-diff`
 * (which lifts that outcome onto each override diff).
 */
export const overrideAppliedKey = (
  enclosingInstanceId: UnityFileId,
  targetGuid: string | undefined,
  targetFileId: UnityFileId,
  propertyPath: string
): string =>
  `${enclosingInstanceId}::${
    targetGuid ?? ''
  }::${targetFileId}::${propertyPath}`

const isRootTransform = (doc: IUnitySerializedDocument): boolean => {
  if (!transformClassIds.has(doc.classId)) {
    return false
  }
  const father = referenceFileId(findProperty(doc.properties, 'm_Father'))
  return father === undefined || father === '0'
}

const componentIds = (
  gameObject: IUnitySerializedDocument
): ReadonlyArray<UnityFileId> => {
  const value = findProperty(gameObject.properties, 'm_Component')
  if (value === undefined || value.kind !== 'sequence') {
    return []
  }
  return value.items
    .map(item =>
      item.kind === 'map'
        ? referenceFileId(findProperty(item.entries, 'component'))
        : item.kind === 'reference'
        ? item.reference.fileId
        : undefined
    )
    .filter((id): id is UnityFileId => id !== undefined)
}

/**
 * Index transforms by their `m_Father`. We traverse a removed subtree through
 * this rather than `m_Children` because a child can be parented to its father by
 * `m_Father` alone — e.g. an added GameObject (`m_AddedGameObjects`) reparented
 * under a base object — and would be missed by a `m_Children`-only walk, leaving
 * it orphaned when its father is removed.
 */
const transformChildrenByFather = (
  documents: ReadonlyArray<IUnitySerializedDocument>
): Map<UnityFileId, Array<UnityFileId>> => {
  const byFather = new Map<UnityFileId, Array<UnityFileId>>()
  for (const doc of documents) {
    if (!transformClassIds.has(doc.classId)) {
      continue
    }
    const father = referenceFileId(findProperty(doc.properties, 'm_Father'))
    if (father === undefined || father === '0') {
      continue
    }
    const siblings = byFather.get(father) ?? []
    siblings.push(doc.fileId)
    byFather.set(father, siblings)
  }
  return byFather
}

/**
 * Collect a GameObject and its whole subtree — the object, its components, and
 * recursively every descendant — as a set of fileIDs. Unity's
 * `m_RemovedGameObjects` drops the object together with everything parented under
 * it; removing only the named object would orphan its descendants, which then
 * reparent to the nearest surviving ancestor and surface as phantom siblings. The
 * walk runs over the instance's own documents and follows `m_Father` edges, so it
 * catches every descendant (including added/reparented objects) and never strays
 * via a remapped-id collision.
 */
const gameObjectSubtreeIds = (
  rootGameObjectId: UnityFileId,
  documentsById: ReadonlyMap<UnityFileId, IUnitySerializedDocument>,
  childrenByFather: ReadonlyMap<UnityFileId, ReadonlyArray<UnityFileId>>
): Set<UnityFileId> => {
  const ids = new Set<UnityFileId>()
  const visit = (gameObjectId: UnityFileId): void => {
    if (ids.has(gameObjectId)) {
      return
    }
    const gameObject = documentsById.get(gameObjectId)
    if (gameObject === undefined) {
      return
    }
    ids.add(gameObjectId)
    for (const componentId of componentIds(gameObject)) {
      ids.add(componentId)
      const component = documentsById.get(componentId)
      if (
        component === undefined ||
        !transformClassIds.has(component.classId)
      ) {
        continue
      }
      for (const childTransformId of childrenByFather.get(componentId) ?? []) {
        const childGameObject = referenceFileId(
          findProperty(
            documentsById.get(childTransformId)?.properties ?? [],
            'm_GameObject'
          )
        )
        if (childGameObject !== undefined) {
          visit(childGameObject)
        }
      }
    }
  }
  visit(rootGameObjectId)
  return ids
}

/** Raw (un-remapped) fileIDs listed under a modification key (excludes `0`). */
const rawRemovedFileIds = (
  doc: IUnitySerializedDocument,
  key: string
): ReadonlyArray<UnityFileId> => {
  const modification = findProperty(doc.properties, 'm_Modification')
  if (modification === undefined || modification.kind !== 'map') {
    return []
  }
  const list = findProperty(modification.entries, key)
  if (list === undefined || list.kind !== 'sequence') {
    return []
  }
  return list.items
    .map(item =>
      item.kind === 'reference' ? item.reference.fileId : undefined
    )
    .filter((id): id is UnityFileId => id !== undefined && id !== '0')
}

/**
 * `m_AddedComponents` entries: `{targetCorrespondingSourceObject, insertIndex,
 * addedObject}`. Each entry attaches a component (defined in the current file
 * as `addedObject`) to a GameObject in the instantiated source, identified by
 * its source-space fileID. Grouped by source GameObject so the expansion pass
 * can splice all additions onto that GameObject's `m_Component` list in one
 * go, in the order they were serialized.
 */
const addedComponentsByTargetSource = (
  doc: IUnitySerializedDocument
): Map<UnityFileId, Array<UnityFileId>> => {
  const byTarget = new Map<UnityFileId, Array<UnityFileId>>()
  const modification = findProperty(doc.properties, 'm_Modification')
  if (modification === undefined || modification.kind !== 'map') {
    return byTarget
  }
  const list = findProperty(modification.entries, 'm_AddedComponents')
  if (list === undefined || list.kind !== 'sequence') {
    return byTarget
  }
  for (const item of list.items) {
    if (item.kind !== 'map') {
      continue
    }
    const targetSourceId = referenceFileId(
      findProperty(item.entries, 'targetCorrespondingSourceObject')
    )
    const addedObjectId = referenceFileId(
      findProperty(item.entries, 'addedObject')
    )
    if (
      targetSourceId === undefined ||
      addedObjectId === undefined ||
      addedObjectId === '0'
    ) {
      continue
    }
    const existing = byTarget.get(targetSourceId) ?? []
    existing.push(addedObjectId)
    byTarget.set(targetSourceId, existing)
  }
  return byTarget
}

const strippedPlaceholdersByInstance = (
  documents: ReadonlyArray<IUnitySerializedDocument>
): Map<UnityFileId, Map<UnityFileId, UnityFileId>> => {
  const byInstance = new Map<UnityFileId, Map<UnityFileId, UnityFileId>>()
  for (const doc of documents) {
    if (!doc.stripped) {
      continue
    }
    const instanceId = referenceFileId(
      findProperty(doc.properties, 'm_PrefabInstance')
    )
    const sourceId = referenceFileId(
      findProperty(doc.properties, 'm_CorrespondingSourceObject')
    )
    if (instanceId === undefined || sourceId === undefined) {
      continue
    }
    const inner =
      byInstance.get(instanceId) ?? new Map<UnityFileId, UnityFileId>()
    inner.set(sourceId, doc.fileId)
    byInstance.set(instanceId, inner)
  }
  return byInstance
}

export const expandPrefabInstances = (
  documents: ReadonlyArray<IUnitySerializedDocument>,
  resolveSource: SourcePrefabResolver,
  resolveSourceName: SourceNameResolver = () => undefined,
  instanceRoots?: Map<UnityFileId, UnityFileId>,
  sourceGuidByExpandedNode?: Map<UnityFileId, string>,
  /**
   * `${guid}::${sourceFileId}` → fileID of the materialized object in the
   * CURRENT namespace. Populated at every recursion level (and folded into
   * outer levels via remap), so a Prefab override that targets `(guid, X)` in
   * ANY nested source — direct or deep reach-through — can be looked up to
   * the exact hierarchy node it affects.
   */
  sourceOriginByExpandedNode?: Map<string, UnityFileId>,
  /**
   * Overrides that were successfully baked into a cloned document, reported
   * via `overrideAppliedKey` so the enricher in `asset-diff` can annotate the
   * matching override diff entries and the Inspector can hide them (their
   * effect is already visible in the per-document property diff). Populated
   * only at the outermost call — inner overrides are the source prefab's own
   * business and don't participate in this diff.
   */
  appliedOverrides?: Set<string>,
  /**
   * Guids of source prefabs already being expanded in an ancestor call.
   * Prefabs are DAGs in a healthy Unity project, but broken imports can
   * introduce cycles; this set is the cycle guard replacing the old fixed
   * depth cap so genuinely deep-but-acyclic nesting expands fully.
   */
  visitedGuids: ReadonlySet<string> = new Set(),
  depth: number = 0
): ReadonlyArray<IUnitySerializedDocument> => {
  const out = new Map<UnityFileId, IUnitySerializedDocument>()
  for (const doc of documents) {
    if (doc.classId !== prefabInstanceClassId && !doc.stripped) {
      out.set(doc.fileId, doc)
    }
  }

  const placeholders = strippedPlaceholdersByInstance(documents)
  const rootTransformByInstance = new Map<UnityFileId, UnityFileId>()
  // Per-instance expanded source docs indexed by source fileId, kept for the
  // fallback pass so it can look up a placeholder's real source object name.
  const expandedSourceByInstance = new Map<
    UnityFileId,
    ReadonlyMap<UnityFileId, IUnitySerializedDocument>
  >()
  // Per-instance remap function + source guid, retained so the value-override
  // pass at the end of this call can walk each instance's modifications with
  // the same id remapping the clone pass used.
  const instanceRemaps = new Map<
    UnityFileId,
    { readonly remap: Remap; readonly sourcePrefabGuid: string }
  >()

  for (const instance of documents) {
    if (instance.classId !== prefabInstanceClassId) {
      continue
    }
    const source = findProperty(instance.properties, 'm_SourcePrefab')
    const guid =
      source !== undefined && source.kind === 'reference'
        ? source.reference.guid
        : undefined
    if (guid === undefined) {
      continue
    }
    // Cycle guard: if an ancestor call is already expanding this same source
    // prefab, don't recurse — Unity forbids cyclic prefabs but broken imports
    // can produce them, and the visited-set replaces the old fixed depth cap
    // so genuinely deep-but-acyclic nesting expands to completion.
    if (visitedGuids.has(guid)) {
      continue
    }
    const sourceDocs = resolveSource(guid)
    if (sourceDocs === null) {
      continue
    }

    const nextVisited = new Set(visitedGuids)
    nextVisited.add(guid)
    const innerOriginMap =
      sourceOriginByExpandedNode !== undefined
        ? new Map<string, UnityFileId>()
        : undefined
    const expandedSource = expandPrefabInstances(
      sourceDocs,
      resolveSource,
      resolveSourceName,
      undefined,
      undefined,
      innerOriginMap,
      undefined,
      nextVisited,
      depth + 1
    )
    const placeholderMap = placeholders.get(instance.fileId)
    // Memoize per instance: the same source id is remapped repeatedly (every
    // reference to an object), and each miss costs two BigInt parses.
    const remapCache = new Map<UnityFileId, UnityFileId>()
    const remap: Remap = sourceFileId => {
      let mapped = remapCache.get(sourceFileId)
      if (mapped === undefined) {
        mapped =
          placeholderMap?.get(sourceFileId) ??
          remapFileId(instance.fileId, sourceFileId)
        remapCache.set(sourceFileId, mapped)
      }
      return mapped
    }
    instanceRemaps.set(instance.fileId, { remap, sourcePrefabGuid: guid })

    // `m_RemovedComponents` drops a single component; `m_RemovedGameObjects`
    // drops a GameObject together with its whole subtree (Unity removes the
    // object and everything parented under it). Both are resolved to source ids:
    // the subtree is walked over this instance's own (pre-remap) source documents
    // so it follows genuine parent/child edges, and the resulting source ids are
    // skipped during cloning. Skipping by source id — rather than deleting
    // remapped ids from `out` — keeps a removal from ever touching another
    // instance's object whose remapped id happens to collide.
    const expandedSourceById = new Map<UnityFileId, IUnitySerializedDocument>(
      expandedSource.map(doc => [doc.fileId, doc])
    )
    expandedSourceByInstance.set(instance.fileId, expandedSourceById)
    const removedSourceIds = new Set<UnityFileId>(
      rawRemovedFileIds(instance, 'm_RemovedComponents')
    )
    const removedRoots = rawRemovedFileIds(instance, 'm_RemovedGameObjects')
    if (removedRoots.length > 0) {
      const childrenByFather = transformChildrenByFather(expandedSource)
      for (const rawId of removedRoots) {
        for (const subtreeId of gameObjectSubtreeIds(
          rawId,
          expandedSourceById,
          childrenByFather
        )) {
          removedSourceIds.add(subtreeId)
        }
      }
    }
    const transformParent = referenceFileId(
      (() => {
        const mod = findProperty(instance.properties, 'm_Modification')
        return mod !== undefined && mod.kind === 'map'
          ? findProperty(mod.entries, 'm_TransformParent')
          : undefined
      })()
    )

    // Components added to a nested instance's GameObjects via
    // `m_AddedComponents` — Unity variant overrides that graft an extra
    // MonoBehaviour (etc.) onto an existing source object. The addedObject
    // fileIDs live in the current file already (parsed as regular documents);
    // we just need to splice them into the target GameObject's `m_Component`
    // list so the hierarchy walk finds them under the right parent instead of
    // leaving them stranded as orphans.
    const addedComponents = addedComponentsByTargetSource(instance)

    for (const sourceDoc of expandedSource) {
      if (removedSourceIds.has(sourceDoc.fileId)) {
        continue
      }
      const newId = remap(sourceDoc.fileId)
      let cloned = cloneDocument(sourceDoc, remap)

      if (transformParent !== undefined && isRootTransform(sourceDoc)) {
        cloned = {
          ...cloned,
          properties: setProperty(cloned.properties, 'm_Father', {
            kind: 'reference',
            reference: { fileId: transformParent, propertyPath: 'm_Father' },
          }),
        }
        rootTransformByInstance.set(instance.fileId, newId)
        if (depth === 0 && instanceRoots !== undefined) {
          const rootGameObject = referenceFileId(
            findProperty(cloned.properties, 'm_GameObject')
          )
          if (rootGameObject !== undefined) {
            instanceRoots.set(instance.fileId, rootGameObject)
          }
        }
      }

      // Splice components added by `m_AddedComponents` onto their source
      // GameObject's `m_Component` list. Only applied at depth 0 — deeper
      // recursions may have already applied their own additions, but the
      // components added by THIS instance target THIS instance's source ids.
      const added = addedComponents.get(sourceDoc.fileId)
      if (added !== undefined && sourceDoc.classId === 1) {
        const componentValue = findProperty(cloned.properties, 'm_Component')
        const existingItems =
          componentValue !== undefined && componentValue.kind === 'sequence'
            ? componentValue.items
            : []
        const extraItems: ReadonlyArray<UnityPropertyValue> = added.map(
          componentId => ({
            kind: 'map',
            entries: [
              {
                key: 'component',
                value: {
                  kind: 'reference',
                  reference: {
                    fileId: componentId,
                    propertyPath: 'component',
                  },
                },
              },
            ],
          })
        )
        cloned = {
          ...cloned,
          properties: setProperty(cloned.properties, 'm_Component', {
            kind: 'sequence',
            items: [...existingItems, ...extraItems],
          }),
        }
      }

      out.set(newId, cloned)
      // Only the top-level expansion records origin. Recursive expansions
      // (depth>0) can't populate a top-level map because the caller re-remaps
      // their IDs when it clones them anyway; the outer clone step tags the
      // resulting top-level ID with the outer instance's own guid, which is
      // the "immediate parent prefab" the user actually cares about.
      if (depth === 0 && sourceGuidByExpandedNode !== undefined) {
        sourceGuidByExpandedNode.set(newId, guid)
      }
      // Origin map — populated at every depth. Key is
      // `${enclosingInstanceId}::${sourceGuid}::${sourceFileId}` so multiple
      // instances of the same source prefab in the current file get distinct
      // entries instead of clobbering each other (two KanbanYukata → two
      // WebLauncherDialog clones must both be addressable). The outer
      // expansion of a deeper source will re-remap these values via its own
      // `remap` (see the absorb step below) so the same key keeps pointing to
      // the correct clone all the way to depth 0.
      if (sourceOriginByExpandedNode !== undefined) {
        sourceOriginByExpandedNode.set(
          `${instance.fileId}::${guid}::${sourceDoc.fileId}`,
          newId
        )
      }
    }
    // Absorb the inner call's origin map. Keys already encode the sub-
    // instance's identity plus the deeper `(guid, sourceFileId)` pair, so we
    // keep them intact — only re-remap the VALUES (the fileIDs) into our
    // outer namespace via the same placeholder/XOR logic the clone loop just
    // applied above. The enclosingInstanceId in absorbed keys stays that of
    // the deeper instance; enrichOverride only looks up by the OUTER instance
    // key, which is written by the direct step above.
    if (
      sourceOriginByExpandedNode !== undefined &&
      innerOriginMap !== undefined
    ) {
      for (const [key, innerFileId] of innerOriginMap) {
        sourceOriginByExpandedNode.set(key, remap(innerFileId))
      }
    }
  }

  // Fallback pass for instances whose source couldn't be fully expanded (e.g.
  // an imported model whose `.meta` name table is empty, so we recovered zero
  // objects). Only stripped Transform placeholders participate here — a
  // GameObject placeholder alone doesn't drive tree nesting, and pairing each
  // Transform with a synthesized GameObject at a derived id gives every
  // instance one node in the merged tree instead of a duplicated pair. When
  // the synthesized root sits at depth 0 it also feeds `instanceRoots` so the
  // enclosing prefab-instance diff colours a real hierarchy node.
  const strippedTransformsByInstance = new Map<
    UnityFileId,
    Array<IUnitySerializedDocument>
  >()
  for (const doc of documents) {
    if (!doc.stripped || !transformClassIds.has(doc.classId)) {
      continue
    }
    const instanceId = referenceFileId(
      findProperty(doc.properties, 'm_PrefabInstance')
    )
    if (instanceId === undefined) {
      continue
    }
    const list = strippedTransformsByInstance.get(instanceId) ?? []
    list.push(doc)
    strippedTransformsByInstance.set(instanceId, list)
  }

  for (const instance of documents) {
    if (instance.classId !== prefabInstanceClassId) {
      continue
    }
    const strippedTransforms =
      strippedTransformsByInstance.get(instance.fileId) ?? []
    const toMaterialize = strippedTransforms.filter(t => !out.has(t.fileId))
    if (toMaterialize.length === 0) {
      continue
    }

    const source = findProperty(instance.properties, 'm_SourcePrefab')
    const guid =
      source !== undefined && source.kind === 'reference'
        ? source.reference.guid
        : undefined
    const prefabName = guid !== undefined ? resolveSourceName(guid) ?? '' : ''
    const modification = findProperty(instance.properties, 'm_Modification')
    const transformParent =
      modification !== undefined && modification.kind === 'map'
        ? referenceFileId(
            findProperty(modification.entries, 'm_TransformParent')
          )
        : undefined

    const expandedSourceById = expandedSourceByInstance.get(instance.fileId)
    const nameOfSource = (sourceId: UnityFileId): string => {
      const doc = expandedSourceById?.get(sourceId)
      if (doc === undefined) {
        return prefabName
      }
      if (doc.classId === 1) {
        return scalarOf(findProperty(doc.properties, 'm_Name')) ?? prefabName
      }
      if (transformClassIds.has(doc.classId)) {
        const gameObjectId = referenceFileId(
          findProperty(doc.properties, 'm_GameObject')
        )
        const gameObject =
          gameObjectId !== undefined
            ? expandedSourceById?.get(gameObjectId)
            : undefined
        return gameObject !== undefined
          ? scalarOf(findProperty(gameObject.properties, 'm_Name')) ??
              prefabName
          : prefabName
      }
      return prefabName
    }

    const materializedRoot = rootTransformByInstance.get(instance.fileId)
    const rootTransformId = materializedRoot ?? toMaterialize[0].fileId

    for (const strippedTransform of toMaterialize) {
      const transformId = strippedTransform.fileId
      const isRoot = transformId === rootTransformId
      const father = isRoot ? transformParent ?? '0' : rootTransformId
      const sourceId = referenceFileId(
        findProperty(
          strippedTransform.properties,
          'm_CorrespondingSourceObject'
        )
      )
      const name = sourceId !== undefined ? nameOfSource(sourceId) : prefabName
      // Bit-flip that keeps the id numeric while distinguishing it from the
      // placeholder Transform id we derived it from.
      const gameObjectId = (
        (BigInt(transformId) ^ dummyGameObjectSentinel) &
        signMask
      ).toString()
      out.set(gameObjectId, {
        classId: 1,
        fileId: gameObjectId,
        typeName: 'GameObject',
        rootKey: 'GameObject',
        stripped: false,
        isModelDummy: true,
        rawTextRange: { start: 0, end: 0 },
        properties: [
          { key: 'm_Name', value: { kind: 'scalar', value: name } },
          {
            key: 'm_Component',
            value: {
              kind: 'sequence',
              items: [
                {
                  kind: 'map',
                  entries: [
                    {
                      key: 'component',
                      value: {
                        kind: 'reference',
                        reference: {
                          fileId: transformId,
                          propertyPath: 'component',
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      })
      out.set(transformId, {
        classId: 4,
        fileId: transformId,
        typeName: 'Transform',
        rootKey: 'Transform',
        stripped: false,
        rawTextRange: { start: 0, end: 0 },
        properties: [
          {
            key: 'm_GameObject',
            value: {
              kind: 'reference',
              reference: { fileId: gameObjectId, propertyPath: 'm_GameObject' },
            },
          },
          {
            key: 'm_Father',
            value: {
              kind: 'reference',
              reference: { fileId: father, propertyPath: 'm_Father' },
            },
          },
          { key: 'm_Children', value: { kind: 'sequence', items: [] } },
        ],
      })

      if (
        depth === 0 &&
        sourceGuidByExpandedNode !== undefined &&
        guid !== undefined
      ) {
        sourceGuidByExpandedNode.set(gameObjectId, guid)
        sourceGuidByExpandedNode.set(transformId, guid)
      }
      // Origin entries for the FBX fallback: the stripped Transform's
      // m_CorrespondingSourceObject.fileId is the FBX-internal id an
      // override can reference. Unity's FBX importer pairs a Transform at
      // fileID 400000+N with a GameObject at 100000+N, so we can register
      // BOTH ids when the pattern holds. Key format matches the direct-clone
      // entries: enclosingInstanceId::guid::sourceFileId.
      if (sourceOriginByExpandedNode !== undefined && guid !== undefined) {
        if (sourceId !== undefined) {
          sourceOriginByExpandedNode.set(
            `${instance.fileId}::${guid}::${sourceId}`,
            transformId
          )
          const sourceIdBig = BigInt(sourceId)
          if (sourceIdBig >= 400000n) {
            const pairedGoId = (sourceIdBig - 300000n).toString()
            sourceOriginByExpandedNode.set(
              `${instance.fileId}::${guid}::${pairedGoId}`,
              gameObjectId
            )
          }
        }
      }

      if (
        isRoot &&
        depth === 0 &&
        instanceRoots !== undefined &&
        !instanceRoots.has(instance.fileId)
      ) {
        instanceRoots.set(instance.fileId, gameObjectId)
      }
    }
  }

  // Value-override pass. Bake each PrefabInstance's `m_Modifications` into the
  // cloned target documents so the per-side documents mirror Unity's effective
  // state — a change in an override then surfaces as an ordinary property
  // diff rather than as a dangling row the reader has to reconcile against a
  // silently-changed source default. Runs at every depth: inner overrides
  // bake into source-side clones that outer levels then remap into their own
  // namespace via `cloneDocument`. Runs AFTER the fallback pass so overrides
  // that target an FBX/model-import placeholder (whose real object graph we
  // couldn't expand) still land — the fallback pass populates those slots
  // with synthesized GameObject/Transform docs the walker can descend into.
  //
  // `applied` is populated only at depth 0 (the outermost file's overrides —
  // the ones surfaced by this diff). Inner-depth overrides are the source
  // prefab's own business and don't need to reach the enricher.
  for (const instance of documents) {
    if (instance.classId !== prefabInstanceClassId) {
      continue
    }
    const info = instanceRemaps.get(instance.fileId)
    if (info === undefined) {
      continue
    }
    const modifications = modificationsOf(instance)
    // Unity は配列を縮小しても範囲外の data override を残すため、size を
    // 最後に適用し、保存された論理サイズで余分な要素を確実に切り落とす。
    const orderedModifications = [
      ...modifications.filter(
        mod => mod.segments[mod.segments.length - 1].kind !== 'size'
      ),
      ...modifications.filter(
        mod => mod.segments[mod.segments.length - 1].kind === 'size'
      ),
    ]
    for (const mod of orderedModifications) {
      const targetId = info.remap(mod.targetFileId)
      const target = out.get(targetId)
      if (target === undefined) {
        continue
      }
      // Wrap the doc's top-level property list in a synthetic map so the
      // path walker's first-key case works uniformly; unwrap for storage.
      const rootValue: UnityPropertyValue = {
        kind: 'map',
        entries: target.properties,
      }
      const applied = applyOverrideAtPath(rootValue, mod.segments, mod.value)
      if (applied === undefined || applied.kind !== 'map') {
        continue
      }
      if (applied !== rootValue) {
        out.set(targetId, { ...target, properties: applied.entries })
      }
      if (appliedOverrides !== undefined && depth === 0) {
        appliedOverrides.add(
          overrideAppliedKey(
            instance.fileId,
            info.sourcePrefabGuid,
            mod.targetFileId,
            mod.propertyPath
          )
        )
      }
    }
  }

  return Array.from(out.values())
}
