/**
 * Expands prefab instances by grafting the source prefab's objects into the
 * asset. A `!u!1001 PrefabInstance` only stores overrides; the instantiated
 * objects live in the source `.prefab`. We clone the source documents, remap
 * their fileIDs into the instance's id space (Unity derives an instance object
 * id by XOR-ing the PrefabInstance id with the source object id), reparent the
 * instance root via `m_TransformParent`, apply structural overrides (renames,
 * removed objects), and recurse for nested prefabs.
 *
 * Value-level overrides (e.g. `m_LocalPosition.x`) are intentionally NOT applied
 * to the cloned properties — those changes are surfaced separately by the
 * prefab override diff. Expansion here exists to recover structure and names so
 * the hierarchy nests correctly instead of dropping instance content.
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
const maxExpansionDepth = 8
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

const remapValue = (value: UnityPropertyValue, remap: Remap): UnityPropertyValue => {
  switch (value.kind) {
    case 'scalar':
      return value
    case 'reference': {
      const reference = remapReference(value.reference, remap)
      return reference === value.reference ? value : { kind: 'reference', reference }
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

interface IModification {
  readonly targetFileId: UnityFileId
  readonly propertyPath: string
  readonly value: string
}

const modificationsOf = (doc: IUnitySerializedDocument): ReadonlyArray<IModification> => {
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
    const value = findProperty(item.entries, 'value')
    if (target !== undefined && path !== undefined && path.kind === 'scalar') {
      result.push({
        targetFileId: target,
        propertyPath: path.value,
        value: value !== undefined && value.kind === 'scalar' ? value.value : '',
      })
    }
  }
  return result
}

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
      if (component === undefined || !transformClassIds.has(component.classId)) {
        continue
      }
      for (const childTransformId of childrenByFather.get(componentId) ?? []) {
        const childGameObject = referenceFileId(
          findProperty(documentsById.get(childTransformId)?.properties ?? [], 'm_GameObject')
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
    .map(item => (item.kind === 'reference' ? item.reference.fileId : undefined))
    .filter((id): id is UnityFileId => id !== undefined && id !== '0')
}

const strippedPlaceholdersByInstance = (
  documents: ReadonlyArray<IUnitySerializedDocument>
): Map<UnityFileId, Map<UnityFileId, UnityFileId>> => {
  const byInstance = new Map<UnityFileId, Map<UnityFileId, UnityFileId>>()
  for (const doc of documents) {
    if (!doc.stripped) {
      continue
    }
    const instanceId = referenceFileId(findProperty(doc.properties, 'm_PrefabInstance'))
    const sourceId = referenceFileId(
      findProperty(doc.properties, 'm_CorrespondingSourceObject')
    )
    if (instanceId === undefined || sourceId === undefined) {
      continue
    }
    const inner = byInstance.get(instanceId) ?? new Map<UnityFileId, UnityFileId>()
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
  depth: number = 0
): ReadonlyArray<IUnitySerializedDocument> => {
  if (depth >= maxExpansionDepth) {
    return documents
  }

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

  for (const instance of documents) {
    if (instance.classId !== prefabInstanceClassId) {
      continue
    }
    const source = findProperty(instance.properties, 'm_SourcePrefab')
    const guid =
      source !== undefined && source.kind === 'reference' ? source.reference.guid : undefined
    if (guid === undefined) {
      continue
    }
    const sourceDocs = resolveSource(guid)
    if (sourceDocs === null) {
      continue
    }

    const expandedSource = expandPrefabInstances(
      sourceDocs,
      resolveSource,
      resolveSourceName,
      undefined,
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

    const simpleOverrides = new Map<UnityFileId, Map<string, string>>()
    for (const mod of modificationsOf(instance)) {
      if (mod.propertyPath.includes('.') || mod.propertyPath.includes('[')) {
        continue
      }
      const id = remap(mod.targetFileId)
      const byKey = simpleOverrides.get(id) ?? new Map<string, string>()
      byKey.set(mod.propertyPath, mod.value)
      simpleOverrides.set(id, byKey)
    }

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

      const overrides = simpleOverrides.get(newId)
      if (overrides !== undefined) {
        let properties = cloned.properties
        for (const [key, value] of overrides) {
          properties = setProperty(properties, key, { kind: 'scalar', value })
        }
        cloned = { ...cloned, properties }
      }

      out.set(newId, cloned)
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
        ? referenceFileId(findProperty(modification.entries, 'm_TransformParent'))
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
        const gameObjectId = referenceFileId(findProperty(doc.properties, 'm_GameObject'))
        const gameObject =
          gameObjectId !== undefined ? expandedSourceById?.get(gameObjectId) : undefined
        return gameObject !== undefined
          ? scalarOf(findProperty(gameObject.properties, 'm_Name')) ?? prefabName
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
        findProperty(strippedTransform.properties, 'm_CorrespondingSourceObject')
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
                    { key: 'component', value: { kind: 'reference', reference: { fileId: transformId, propertyPath: 'component' } } },
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
          { key: 'm_GameObject', value: { kind: 'reference', reference: { fileId: gameObjectId, propertyPath: 'm_GameObject' } } },
          { key: 'm_Father', value: { kind: 'reference', reference: { fileId: father, propertyPath: 'm_Father' } } },
          { key: 'm_Children', value: { kind: 'sequence', items: [] } },
        ],
      })

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

  return Array.from(out.values())
}
