/**
 * Resolve a Prefab override's target — a raw `(guid, fileID)` pair pointing
 * into a specific source prefab — to the GameObject / Component the Inspector
 * needs to group it under. Given the parsed documents of a source prefab, the
 * index answers "what is fileID X inside this file?" with its kind, the
 * GameObject that owns it, that GameObject's hierarchy path in the source, and
 * (for components) the component's friendly type name.
 *
 * The index is built once per source prefab; the enrichment pass in
 * `asset-diff` memoizes per GUID because many overrides usually share the
 * same source and re-walking the docs for each would repeat work.
 */

import { getClassName, transformClassIds } from '../../models/unity/class-ids'
import {
  IUnityPropertyNode,
  IUnitySerializedDocument,
  UnityFileId,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'

const gameObjectClassId = 1
const monoBehaviourClassId = 114

const findProperty = (
  properties: ReadonlyArray<IUnityPropertyNode>,
  key: string
): UnityPropertyValue | undefined => properties.find(n => n.key === key)?.value

const scalarOf = (value: UnityPropertyValue | undefined): string | undefined =>
  value !== undefined && value.kind === 'scalar' ? value.value : undefined

const referenceFileId = (
  value: UnityPropertyValue | undefined
): UnityFileId | undefined =>
  value !== undefined && value.kind === 'reference'
    ? value.reference.fileId
    : undefined

const referenceGuid = (
  value: UnityPropertyValue | undefined
): string | undefined =>
  value !== undefined && value.kind === 'reference'
    ? value.reference.guid
    : undefined

export type UnityPrefabTargetKind = 'GameObject' | 'Component'

export interface IUnityPrefabTargetInfo {
  readonly kind: UnityPrefabTargetKind
  /** fileID of the owning GameObject (equals `fileId` when kind is GameObject). */
  readonly ownerGameObjectFileId: UnityFileId
  readonly ownerName: string
  readonly ownerPath: string
  /** Component type name (script basename for MonoBehaviour). */
  readonly componentType?: string
}

/**
 * Build the fileID → target-info index for a source prefab's parsed documents.
 * `scriptNameForGuid` resolves a MonoBehaviour's `m_Script` GUID to a friendly
 * name (typically the script's file basename) so components read as
 * `PlayerController` instead of `MonoBehaviour`.
 */
export const buildPrefabTargetIndex = (
  documents: ReadonlyArray<IUnitySerializedDocument>,
  scriptNameForGuid: (guid: string) => string | undefined
): ReadonlyMap<UnityFileId, IUnityPrefabTargetInfo> => {
  const byId = new Map<UnityFileId, IUnitySerializedDocument>()
  for (const doc of documents) {
    byId.set(doc.fileId, doc)
  }

  // Reverse lookup: GameObject fileID → its Transform fileID. Needed to walk
  // `m_Father` upward when computing the hierarchy path — a GameObject itself
  // has no parent reference; the parent link lives on its Transform.
  const transformByGameObject = new Map<UnityFileId, UnityFileId>()
  for (const doc of documents) {
    if (!transformClassIds.has(doc.classId)) {
      continue
    }
    const goId = referenceFileId(findProperty(doc.properties, 'm_GameObject'))
    if (goId !== undefined) {
      transformByGameObject.set(goId, doc.fileId)
    }
  }

  const nameOf = (goId: UnityFileId): string => {
    const go = byId.get(goId)
    if (go === undefined || go.classId !== gameObjectClassId) {
      return ''
    }
    return scalarOf(findProperty(go.properties, 'm_Name')) ?? ''
  }

  const pathCache = new Map<UnityFileId, string>()
  const pathOf = (goId: UnityFileId, seen: Set<UnityFileId>): string => {
    const cached = pathCache.get(goId)
    if (cached !== undefined) {
      return cached
    }
    if (seen.has(goId)) {
      return ''
    }
    seen.add(goId)
    const name = nameOf(goId)
    let parentPath = ''
    const transformId = transformByGameObject.get(goId)
    if (transformId !== undefined) {
      const transform = byId.get(transformId)
      const fatherId =
        transform !== undefined
          ? referenceFileId(findProperty(transform.properties, 'm_Father'))
          : undefined
      if (fatherId !== undefined && fatherId !== '0') {
        const fatherTransform = byId.get(fatherId)
        if (fatherTransform !== undefined) {
          const fatherGoId = referenceFileId(
            findProperty(fatherTransform.properties, 'm_GameObject')
          )
          if (fatherGoId !== undefined) {
            parentPath = pathOf(fatherGoId, seen)
          }
        }
      }
    }
    const path = parentPath.length > 0 ? `${parentPath}/${name}` : name
    pathCache.set(goId, path)
    return path
  }

  const componentTypeOf = (doc: IUnitySerializedDocument): string => {
    if (doc.classId === monoBehaviourClassId) {
      const guid = referenceGuid(findProperty(doc.properties, 'm_Script'))
      if (guid !== undefined) {
        const scriptName = scriptNameForGuid(guid)
        if (scriptName !== undefined && scriptName.length > 0) {
          return scriptName
        }
      }
    }
    return doc.typeName ?? getClassName(doc.classId)
  }

  const index = new Map<UnityFileId, IUnityPrefabTargetInfo>()
  for (const doc of documents) {
    if (doc.stripped) {
      // A stripped placeholder proxies an object from a deeper source; the
      // enrichment pass follows `target.guid` to that source directly, so we
      // don't index placeholders here.
      continue
    }
    if (doc.classId === gameObjectClassId) {
      const path = pathOf(doc.fileId, new Set())
      index.set(doc.fileId, {
        kind: 'GameObject',
        ownerGameObjectFileId: doc.fileId,
        ownerName: nameOf(doc.fileId),
        ownerPath: path,
      })
      continue
    }
    const goId = referenceFileId(findProperty(doc.properties, 'm_GameObject'))
    if (goId === undefined) {
      continue
    }
    index.set(doc.fileId, {
      kind: 'Component',
      ownerGameObjectFileId: goId,
      ownerName: nameOf(goId),
      ownerPath: pathOf(goId, new Set()),
      componentType: componentTypeOf(doc),
    })
  }
  return index
}
