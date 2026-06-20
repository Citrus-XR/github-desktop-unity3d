/**
 * Reconstructs a GameObject/Transform hierarchy from the documents of a parsed
 * `.unity` or `.prefab` file. The tree is built from Transform (and
 * RectTransform) relationships: each Transform names its owning GameObject, its
 * parent, and its ordered children. Components are listed per GameObject in
 * their serialized order, including the Transform itself.
 *
 * Only same-asset fileID links are resolved here. A reference whose target is
 * absent yields a `Missing` component rather than dropping it, so the Inspector
 * can surface broken links instead of silently hiding them.
 */

import { getClassName, transformClassIds } from '../../models/unity/class-ids'
import {
  IUnityComponentNode,
  IUnityGameObjectNode,
  IUnitySerializedDocument,
  UnityFileId,
  IUnityPropertyNode,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'

const gameObjectClassId = 1

const findProperty = (
  properties: ReadonlyArray<IUnityPropertyNode>,
  key: string
): UnityPropertyValue | undefined =>
  properties.find(n => n.key === key)?.value

const scalarOf = (value: UnityPropertyValue | undefined): string | undefined =>
  value !== undefined && value.kind === 'scalar' ? value.value : undefined

const referenceFileId = (
  value: UnityPropertyValue | undefined
): UnityFileId | undefined =>
  value !== undefined && value.kind === 'reference'
    ? value.reference.fileId
    : undefined

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (value === '1') {
    return true
  }
  if (value === '0') {
    return false
  }
  return undefined
}

const parseInteger = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : undefined
}

interface ITransformInfo {
  readonly fileId: UnityFileId
  readonly gameObjectId: UnityFileId | undefined
  readonly fatherId: UnityFileId | undefined
  readonly childIds: ReadonlyArray<UnityFileId>
}

const readTransform = (doc: IUnitySerializedDocument): ITransformInfo => {
  const childrenValue = findProperty(doc.properties, 'm_Children')
  const childIds =
    childrenValue !== undefined && childrenValue.kind === 'sequence'
      ? childrenValue.items
          .map(item => (item.kind === 'reference' ? item.reference.fileId : undefined))
          .filter((id): id is UnityFileId => id !== undefined)
      : []

  return {
    fileId: doc.fileId,
    gameObjectId: referenceFileId(findProperty(doc.properties, 'm_GameObject')),
    fatherId: referenceFileId(findProperty(doc.properties, 'm_Father')),
    childIds,
  }
}

const buildComponentNode = (
  componentId: UnityFileId,
  documentsById: ReadonlyMap<UnityFileId, IUnitySerializedDocument>
): IUnityComponentNode => {
  const doc = documentsById.get(componentId)
  if (doc === undefined) {
    return {
      fileId: componentId,
      classId: 0,
      typeName: 'Missing',
      properties: [],
    }
  }
  return {
    fileId: doc.fileId,
    classId: doc.classId,
    typeName: doc.typeName ?? getClassName(doc.classId),
    enabled: parseBoolean(scalarOf(findProperty(doc.properties, 'm_Enabled'))),
    properties: doc.properties,
  }
}

const componentIdsOf = (
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
 * Build the root GameObject nodes for a parsed scene or prefab. Returns the
 * forest of roots (a prefab typically has one; a scene has many) in serialized
 * order.
 */
export const buildHierarchy = (
  documents: ReadonlyArray<IUnitySerializedDocument>
): ReadonlyArray<IUnityGameObjectNode> => {
  const documentsById = new Map<UnityFileId, IUnitySerializedDocument>()
  for (const doc of documents) {
    documentsById.set(doc.fileId, doc)
  }

  // Transform fileID -> info.
  const transforms = new Map<UnityFileId, ITransformInfo>()
  for (const doc of documents) {
    if (transformClassIds.has(doc.classId)) {
      const info = readTransform(doc)
      transforms.set(info.fileId, info)
    }
  }

  // Whether a transform yields a GameObject node. Stripped prefab-instance
  // transforms carry no m_GameObject (their data lives in the source prefab),
  // so they produce no node. A child whose father is such a transform must be
  // promoted to a root rather than dropped, otherwise prefab-variant content
  // (whose objects parent under stripped base transforms) vanishes entirely.
  const producesNode = (transformId: UnityFileId): boolean => {
    const info = transforms.get(transformId)
    if (info === undefined || info.gameObjectId === undefined) {
      return false
    }
    const gameObject = documentsById.get(info.gameObjectId)
    return gameObject !== undefined && gameObject.classId === gameObjectClassId
  }

  // The nearest ancestor that produces a node, walking up through transforms
  // that don't (e.g. an imported model's part transforms whose GameObject lives
  // in the binary model file). Such transforms are transparent: their children
  // attach to the nearest real ancestor instead of floating or duplicating.
  const effectiveFather = (
    transformId: UnityFileId
  ): UnityFileId | undefined => {
    const seen = new Set<UnityFileId>([transformId])
    let father = transforms.get(transformId)?.fatherId
    while (
      father !== undefined &&
      father !== '0' &&
      !seen.has(father) &&
      transforms.has(father)
    ) {
      if (producesNode(father)) {
        return father
      }
      seen.add(father)
      father = transforms.get(father)?.fatherId
    }
    return undefined
  }

  // Build the parent -> children map. Only node-producing transforms become
  // nodes; each attaches to its nearest node-producing ancestor. m_Children is
  // used only to order siblings.
  const childrenByFather = new Map<UnityFileId, Array<UnityFileId>>()
  for (const info of transforms.values()) {
    if (!producesNode(info.fileId)) {
      continue
    }
    const father = effectiveFather(info.fileId)
    if (father === undefined) {
      continue
    }
    const siblings = childrenByFather.get(father) ?? []
    siblings.push(info.fileId)
    childrenByFather.set(father, siblings)
  }
  for (const [fatherId, siblings] of childrenByFather) {
    const order = transforms.get(fatherId)?.childIds ?? []
    const rank = (id: UnityFileId) => {
      const index = order.indexOf(id)
      return index === -1 ? Number.MAX_SAFE_INTEGER : index
    }
    siblings.sort((a, b) => rank(a) - rank(b))
  }

  // Guards against a malformed file with cyclic father references.
  const visited = new Set<UnityFileId>()

  const buildGameObjectNode = (
    transformId: UnityFileId,
    parentGameObjectId: UnityFileId | undefined
  ): IUnityGameObjectNode | undefined => {
    if (visited.has(transformId)) {
      return undefined
    }
    visited.add(transformId)

    const transform = transforms.get(transformId)
    if (transform === undefined || transform.gameObjectId === undefined) {
      return undefined
    }
    const gameObject = documentsById.get(transform.gameObjectId)
    if (gameObject === undefined || gameObject.classId !== gameObjectClassId) {
      return undefined
    }

    const children = (childrenByFather.get(transformId) ?? [])
      .map(childId => buildGameObjectNode(childId, transform.gameObjectId))
      .filter((node): node is IUnityGameObjectNode => node !== undefined)

    return {
      fileId: gameObject.fileId,
      name: scalarOf(findProperty(gameObject.properties, 'm_Name')) ?? '',
      active: parseBoolean(scalarOf(findProperty(gameObject.properties, 'm_IsActive'))),
      layer: parseInteger(scalarOf(findProperty(gameObject.properties, 'm_Layer'))),
      tag: scalarOf(findProperty(gameObject.properties, 'm_TagString')),
      parentFileId: parentGameObjectId,
      isModel: gameObject.isModelDummy === true ? true : undefined,
      children,
      components: componentIdsOf(gameObject).map(id =>
        buildComponentNode(id, documentsById)
      ),
    }
  }

  const roots = new Array<IUnityGameObjectNode>()
  for (const doc of documents) {
    if (!transformClassIds.has(doc.classId)) {
      continue
    }
    const info = transforms.get(doc.fileId)
    if (info === undefined || !producesNode(doc.fileId)) {
      continue
    }
    // A transform roots the tree when it has no node-producing ancestor.
    if (effectiveFather(doc.fileId) === undefined) {
      const node = buildGameObjectNode(info.fileId, undefined)
      if (node !== undefined) {
        roots.push(node)
      }
    }
  }
  return roots
}
