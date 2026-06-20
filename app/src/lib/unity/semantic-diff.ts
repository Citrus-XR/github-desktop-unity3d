/**
 * The two-sided Unity semantic diff engine. Given the parsed `before` and
 * `after` views of one asset, it matches GameObjects and components by fileID
 * (stable within an asset) and properties by key, then produces a merged
 * GameObject tree annotated with change status plus per-document property
 * diffs. Matching is purely by identity here; fuzzy matching by name/path is a
 * later refinement.
 */

import {
  IUnityComponentNode,
  IUnityGameObjectNode,
  IUnitySerializedDocument,
  UnityFileId,
  IUnityPropertyNode,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'
import {
  IUnityComponentDiffRef,
  IUnityDocumentDiff,
  IUnityGameObjectDiffNode,
  IUnityPrefabInstanceDiff,
  IUnityPropertyDiff,
  UnityChangeStatus,
} from '../../models/unity/semantic-diff'
import { getClassName } from '../../models/unity/class-ids'
import { diffPrefabInstances } from './prefab-diff'

/** One parsed side of an asset. */
export interface IUnityParsedSide {
  readonly documents: ReadonlyArray<IUnitySerializedDocument>
  readonly roots: ReadonlyArray<IUnityGameObjectNode>
}

/** Deep structural equality of two property values. */
export const valueEquals = (
  a: UnityPropertyValue,
  b: UnityPropertyValue
): boolean => {
  if (a.kind !== b.kind) {
    return false
  }
  if (a.kind === 'scalar' && b.kind === 'scalar') {
    return a.value === b.value
  }
  if (a.kind === 'reference' && b.kind === 'reference') {
    return (
      a.reference.fileId === b.reference.fileId &&
      a.reference.guid === b.reference.guid &&
      a.reference.referenceType === b.reference.referenceType
    )
  }
  if (a.kind === 'map' && b.kind === 'map') {
    return (
      a.entries.length === b.entries.length &&
      a.entries.every(
        (entry, i) =>
          entry.key === b.entries[i].key &&
          valueEquals(entry.value, b.entries[i].value)
      )
    )
  }
  if (a.kind === 'sequence' && b.kind === 'sequence') {
    return (
      a.items.length === b.items.length &&
      a.items.every((item, i) => valueEquals(item, b.items[i]))
    )
  }
  return false
}

const toPropertyMap = (
  properties: ReadonlyArray<IUnityPropertyNode>
): Map<string, UnityPropertyValue> => {
  const map = new Map<string, UnityPropertyValue>()
  for (const node of properties) {
    if (!map.has(node.key)) {
      map.set(node.key, node.value)
    }
  }
  return map
}

/** Ordered union of after keys followed by before-only keys. */
const orderedKeyUnion = (
  before: ReadonlyArray<IUnityPropertyNode>,
  after: ReadonlyArray<IUnityPropertyNode>
): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const keys = new Array<string>()
  for (const node of after) {
    if (!seen.has(node.key)) {
      seen.add(node.key)
      keys.push(node.key)
    }
  }
  for (const node of before) {
    if (!seen.has(node.key)) {
      seen.add(node.key)
      keys.push(node.key)
    }
  }
  return keys
}

/** Diff two property lists, keyed by property name. */
export const diffProperties = (
  before: ReadonlyArray<IUnityPropertyNode>,
  after: ReadonlyArray<IUnityPropertyNode>
): ReadonlyArray<IUnityPropertyDiff> => {
  const beforeMap = toPropertyMap(before)
  const afterMap = toPropertyMap(after)

  return orderedKeyUnion(before, after).map(key => {
    const b = beforeMap.get(key)
    const a = afterMap.get(key)
    let status: UnityChangeStatus
    if (b === undefined) {
      status = 'added'
    } else if (a === undefined) {
      status = 'removed'
    } else {
      status = valueEquals(b, a) ? 'unchanged' : 'modified'
    }
    return { key, status, before: b ?? null, after: a ?? null }
  })
}

export const diffDocument = (
  before: IUnitySerializedDocument | null,
  after: IUnitySerializedDocument | null
): IUnityDocumentDiff => {
  const present = after ?? before
  if (present === null) {
    throw new Error('diffDocument requires at least one side')
  }
  const base = {
    fileId: present.fileId,
    classId: present.classId,
    typeName: present.typeName ?? getClassName(present.classId),
  }

  if (before === null && after !== null) {
    return {
      ...base,
      status: 'added',
      properties: diffProperties([], after.properties),
    }
  }
  if (after === null && before !== null) {
    return {
      ...base,
      status: 'removed',
      properties: diffProperties(before.properties, []),
    }
  }

  const properties = diffProperties(
    (before as IUnitySerializedDocument).properties,
    (after as IUnitySerializedDocument).properties
  )
  const status: UnityChangeStatus = properties.some(
    p => p.status !== 'unchanged'
  )
    ? 'modified'
    : 'unchanged'
  return { ...base, status, properties }
}

export const indexById = <T extends { fileId: UnityFileId }>(
  items: ReadonlyArray<T>
): Map<UnityFileId, T> => {
  const map = new Map<UnityFileId, T>()
  for (const item of items) {
    map.set(item.fileId, item)
  }
  return map
}

const flattenHierarchy = (
  roots: ReadonlyArray<IUnityGameObjectNode>
): Map<UnityFileId, IUnityGameObjectNode> => {
  const map = new Map<UnityFileId, IUnityGameObjectNode>()
  const walk = (node: IUnityGameObjectNode) => {
    map.set(node.fileId, node)
    node.children.forEach(walk)
  }
  roots.forEach(walk)
  return map
}

const componentRefs = (
  beforeGo: IUnityGameObjectNode | undefined,
  afterGo: IUnityGameObjectNode | undefined,
  statusByFileId: ReadonlyMap<UnityFileId, UnityChangeStatus>
): ReadonlyArray<IUnityComponentDiffRef> => {
  const beforeComponents = beforeGo?.components ?? []
  const afterComponents = afterGo?.components ?? []
  const byId = new Map<UnityFileId, IUnityComponentNode>()
  const order = new Array<UnityFileId>()
  for (const component of [...afterComponents, ...beforeComponents]) {
    if (!byId.has(component.fileId)) {
      byId.set(component.fileId, component)
      order.push(component.fileId)
    }
  }
  return order.map(fileId => {
    const component = byId.get(fileId) as IUnityComponentNode
    return {
      fileId,
      typeName: component.typeName,
      status: statusByFileId.get(fileId) ?? 'unchanged',
    }
  })
}

/** Compute the full semantic diff for one asset's two parsed sides. */
export const computeSemanticDiff = (
  before: IUnityParsedSide,
  after: IUnityParsedSide
): {
  roots: ReadonlyArray<IUnityGameObjectDiffNode>
  documents: ReadonlyArray<IUnityDocumentDiff>
  prefabInstances: ReadonlyArray<IUnityPrefabInstanceDiff>
} => {
  const beforeDocs = indexById(before.documents)
  const afterDocs = indexById(after.documents)

  const allDocIds = new Set<UnityFileId>([
    ...beforeDocs.keys(),
    ...afterDocs.keys(),
  ])
  const documentDiffs = new Array<IUnityDocumentDiff>()
  const statusByFileId = new Map<UnityFileId, UnityChangeStatus>()
  for (const id of allDocIds) {
    const diff = diffDocument(
      beforeDocs.get(id) ?? null,
      afterDocs.get(id) ?? null
    )
    documentDiffs.push(diff)
    statusByFileId.set(id, diff.status)
  }

  const beforeGos = flattenHierarchy(before.roots)
  const afterGos = flattenHierarchy(after.roots)

  const effectiveParent = (id: UnityFileId): UnityFileId | undefined =>
    afterGos.get(id)?.parentFileId ?? beforeGos.get(id)?.parentFileId

  const childOrder = (id: UnityFileId): ReadonlyArray<UnityFileId> => {
    const seen = new Set<UnityFileId>()
    const ordered = new Array<UnityFileId>()
    const push = (childId: UnityFileId) => {
      if (!seen.has(childId)) {
        seen.add(childId)
        ordered.push(childId)
      }
    }
    afterGos.get(id)?.children.forEach(c => push(c.fileId))
    beforeGos.get(id)?.children.forEach(c => push(c.fileId))
    return ordered
  }

  const built = new Set<UnityFileId>()
  const buildNode = (id: UnityFileId): IUnityGameObjectDiffNode | null => {
    if (built.has(id)) {
      return null
    }
    built.add(id)
    const beforeGo = beforeGos.get(id)
    const afterGo = afterGos.get(id)
    if (beforeGo === undefined && afterGo === undefined) {
      return null
    }

    const components = componentRefs(beforeGo, afterGo, statusByFileId)
    let status: UnityChangeStatus
    if (beforeGo === undefined) {
      status = 'added'
    } else if (afterGo === undefined) {
      status = 'removed'
    } else {
      const selfChanged = statusByFileId.get(id) === 'modified'
      const componentChanged = components.some(c => c.status !== 'unchanged')
      status = selfChanged || componentChanged ? 'modified' : 'unchanged'
    }

    const children = childOrder(id)
      .map(buildNode)
      .filter((n): n is IUnityGameObjectDiffNode => n !== null)

    return {
      fileId: id,
      name: afterGo?.name ?? beforeGo?.name ?? '',
      status,
      isModel: afterGo?.isModel ?? beforeGo?.isModel,
      components,
      children,
    }
  }

  const allGoIds = new Set<UnityFileId>([
    ...afterGos.keys(),
    ...beforeGos.keys(),
  ])
  const roots = new Array<IUnityGameObjectDiffNode>()
  for (const id of allGoIds) {
    const parent = effectiveParent(id)
    const isRoot = parent === undefined || !allGoIds.has(parent)
    if (isRoot) {
      const node = buildNode(id)
      if (node !== null) {
        roots.push(node)
      }
    }
  }

  // For an asset with a hierarchy, the tree colours itself from per-node and
  // per-component status, and the Inspector pulls a single node's document diff
  // on demand — so only the changed documents need to travel eagerly. A large
  // scene expands to >100k documents whose full before/after property trees are
  // hundreds of megabytes to serialize; emitting only the changed ones keeps the
  // result small. A hierarchy-less asset (material, ScriptableObject) is tiny and
  // is listed document-by-document, so it keeps every document.
  const documents =
    roots.length > 0
      ? documentDiffs.filter(d => d.status !== 'unchanged')
      : documentDiffs

  return {
    roots,
    documents,
    prefabInstances: diffPrefabInstances(before.documents, after.documents),
  }
}
