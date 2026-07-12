/**
 * Synthesizes serialized documents for an imported model (FBX/OBJ/etc.) so that
 * prefabs and scenes referencing objects *inside* the model resolve and nest
 * properly, rather than showing a flat pile of unresolved fileIDs.
 *
 * Two sources feed the reconstruction:
 *
 *   1. The `.meta` file's `internalIDToNameTable`. Unity writes this when a
 *      user has overridden a specific object's name from the Model Importer
 *      panel. It gives us the authoritative `(classId, fileId, name)` triples
 *      but no parenting.
 *
 *   2. The FBX file itself. In Unity 2019+ the Model Importer, when the meta
 *      table doesn't override, computes each object's fileID by hashing its
 *      *hierarchy path plus class name* — the "stable IDs" behavior. Reading
 *      the FBX and replaying the same hash lets us recover ids that the meta
 *      does not list (which is the common case for FBX in Unity 2022).
 *
 * When both are available: FBX-derived ids form the base, meta table entries
 * override matching names (Unity's precedence). When only the FBX is
 * available: we synthesize from FBX alone. When only the meta table is
 * available (no FBX on disk): the objects still land, but every non-root
 * Transform gets parented directly under the model root — no nesting.
 */

import {
  IUnitySerializedDocument,
  UnityFileId,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'
import { getClassName, transformClassIds } from '../../models/unity/class-ids'
import { IFbxHierarchy, uniqueNameIndex } from './fbx-hierarchy'
import {
  ISynthesizedModelObject,
  synthesizeModelObjects,
} from './fbx-fileid-hash'

const gameObjectClassId = 1
// The Unity model importer assigns fileIDs as classId*100000 + 2*localIndex, so
// a Transform (400000+) and its GameObject (100000+) share a local index; the
// GameObject id is the Transform id minus this offset.
const transformToGameObjectOffset = 300000n

/** Extensions whose objects come from a binary model file, not YAML. */
const modelExtensions: ReadonlySet<string> = new Set([
  '.fbx',
  '.obj',
  '.dae',
  '.blend',
  '.3ds',
  '.dxf',
  '.max',
  '.c4d',
])

/** Whether a repository path is an imported model file. */
export const isModelPath = (path: string): boolean => {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && modelExtensions.has(path.slice(dot).toLowerCase())
}

interface IModelObject {
  readonly classId: number
  readonly fileId: UnityFileId
  readonly name: string
}

const tableEntryRegex =
  /-\s*first:\s*\n\s*(\d+):\s*(-?\d+)\s*\n\s*second:\s*(.*)/g

/** Parse `internalIDToNameTable` entries from a model `.meta` file. */
export const parseModelNameTable = (
  metaContent: string
): ReadonlyArray<IModelObject> => {
  const objects = new Array<IModelObject>()
  tableEntryRegex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = tableEntryRegex.exec(metaContent)) !== null) {
    objects.push({
      classId: Number(match[1]),
      fileId: match[2],
      name: match[3].trim(),
    })
  }
  return objects
}

const reference = (fileId: UnityFileId, propertyPath: string) => ({
  kind: 'reference' as const,
  reference: { fileId, propertyPath },
})

// Unity's internalIDToNameTable stores leaf names; the same name can appear on
// multiple bones (e.g. mirrored `L_Wrist` / `R_Wrist` skeletons). We can only
// safely map an FBX ancestor onto a Unity Transform when the name is unique on
// both sides; ambiguous names fall back to the flat-under-root layout.
const buildUniqueNameIndex = <T>(
  entries: Iterable<readonly [string, T]>
): ReadonlyMap<string, T> => {
  const seenTwice = new Set<string>()
  const index = new Map<string, T>()
  for (const [name, value] of entries) {
    if (seenTwice.has(name)) {
      continue
    }
    if (index.has(name)) {
      index.delete(name)
      seenTwice.add(name)
      continue
    }
    index.set(name, value)
  }
  return index
}

const resolveFatherFromFbx = (
  transformName: string,
  fbxHierarchy: IFbxHierarchy,
  fbxUniqueByName: ReadonlyMap<string, string>,
  unityTransformByName: ReadonlyMap<string, UnityFileId>
): UnityFileId | undefined => {
  const startUid = fbxUniqueByName.get(transformName)
  if (startUid === undefined) {
    return undefined
  }
  let cursor = fbxHierarchy.nodes.get(startUid)?.parentUid ?? null
  // Walk up the FBX chain until we hit a Model whose name Unity also exposes
  // uniquely. This lets us skip any intermediate FBX Null nodes that Unity's
  // importer collapses away.
  while (cursor !== null) {
    const ancestor = fbxHierarchy.nodes.get(cursor)
    if (ancestor === undefined) {
      break
    }
    const unityAncestor = unityTransformByName.get(ancestor.name)
    if (unityAncestor !== undefined) {
      return unityAncestor
    }
    cursor = ancestor.parentUid
  }
  return undefined
}

const buildMetaTableDocuments = (
  objects: ReadonlyArray<IModelObject>,
  rootName: string,
  fbxHierarchy: IFbxHierarchy | undefined
): ReadonlyArray<IUnitySerializedDocument> => {
  const transforms = objects.filter(o => transformClassIds.has(o.classId))
  const root = transforms.find(t => t.name === '//RootNode') ?? transforms.at(0)
  if (root === undefined) {
    return []
  }

  const unityTransformByName = buildUniqueNameIndex(
    transforms
      .filter(t => t.fileId !== root.fileId && t.name !== '//RootNode')
      .map(t => [t.name, t.fileId] as const)
  )
  const fbxUniqueByName =
    fbxHierarchy === undefined
      ? new Map<string, string>()
      : uniqueNameIndex(fbxHierarchy)

  const fatherByTransform = new Map<UnityFileId, UnityFileId>()
  for (const transform of transforms) {
    if (transform.fileId === root.fileId) {
      continue
    }
    const resolvedFather =
      fbxHierarchy === undefined
        ? undefined
        : resolveFatherFromFbx(
            transform.name,
            fbxHierarchy,
            fbxUniqueByName,
            unityTransformByName
          )
    fatherByTransform.set(transform.fileId, resolvedFather ?? root.fileId)
  }

  const childrenByFather = new Map<UnityFileId, UnityFileId[]>()
  for (const transform of transforms) {
    if (transform.fileId === root.fileId) {
      continue
    }
    const father = fatherByTransform.get(transform.fileId)!
    const siblings = childrenByFather.get(father) ?? []
    siblings.push(transform.fileId)
    childrenByFather.set(father, siblings)
  }

  const docs = new Array<IUnitySerializedDocument>()
  for (const transform of transforms) {
    const gameObjectId = (
      BigInt(transform.fileId) - transformToGameObjectOffset
    ).toString()
    const isRoot = transform.fileId === root.fileId
    const name = transform.name === '//RootNode' ? rootName : transform.name

    docs.push({
      classId: gameObjectClassId,
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
                    value: reference(transform.fileId, 'component'),
                  },
                ],
              },
            ],
          },
        },
      ],
    })

    const fatherFileId = isRoot
      ? '0'
      : fatherByTransform.get(transform.fileId) ?? root.fileId
    const children = childrenByFather.get(transform.fileId) ?? []
    const childrenValue: UnityPropertyValue = {
      kind: 'sequence',
      items: children.map(
        childId =>
          ({
            kind: 'reference',
            reference: { fileId: childId, propertyPath: 'm_Children' },
          } as const)
      ),
    }

    docs.push({
      classId: transform.classId,
      fileId: transform.fileId,
      typeName: getClassName(transform.classId),
      rootKey: getClassName(transform.classId),
      stripped: false,
      rawTextRange: { start: 0, end: 0 },
      properties: [
        { key: 'm_GameObject', value: reference(gameObjectId, 'm_GameObject') },
        {
          key: 'm_Father',
          value: reference(fatherFileId, 'm_Father'),
        },
        { key: 'm_Children', value: childrenValue },
      ],
    })
  }
  return docs
}

/**
 * Sentinel scalar the synthesis path emits everywhere it doesn't know the
 * value that Unity's Model Importer would have written. The renderer picks
 * this up and shows a translated label like "Model default" instead of a
 * misleading concrete value. Diff comparisons work as normal because both
 * sides emit the identical sentinel when a property is untouched.
 *
 * Chosen to be visually distinctive AND unambiguous: Unity's own YAML never
 * contains angle-bracket scalar values, so a real value like `1.5` can't
 * collide with this sentinel by coincidence.
 */
export const MODEL_DEFAULT_MARKER = '<model default>'

const modelDefault = (): UnityPropertyValue => ({
  kind: 'scalar',
  value: MODEL_DEFAULT_MARKER,
})

const vec3Default = (): UnityPropertyValue => ({
  kind: 'map',
  entries: [
    { key: 'x', value: modelDefault() },
    { key: 'y', value: modelDefault() },
    { key: 'z', value: modelDefault() },
  ],
})

const quatDefault = (): UnityPropertyValue => ({
  kind: 'map',
  entries: [
    { key: 'x', value: modelDefault() },
    { key: 'y', value: modelDefault() },
    { key: 'z', value: modelDefault() },
    { key: 'w', value: modelDefault() },
  ],
})

// Synthetic Transform local-space properties. Unity's importer copies the
// FBX's Lcl Translation / Rotation / Scaling here, but we don't currently read
// Properties70 — so every leaf is emitted as the model-default sentinel. The
// prefab expander then path-copies real values on top for anything an
// override touched (`m_LocalPosition.x = 1.5` overwrites just that one leaf).
const identityTransformProperties = (): ReadonlyArray<{
  key: string
  value: UnityPropertyValue
}> => [
  { key: 'm_LocalRotation', value: quatDefault() },
  { key: 'm_LocalPosition', value: vec3Default() },
  { key: 'm_LocalScale', value: vec3Default() },
  { key: 'm_ConstrainProportionsScale', value: modelDefault() },
  { key: 'm_LocalEulerAnglesHint', value: vec3Default() },
]

// Same rationale for renderer / mesh components: give overrides a target
// shape, and give "show unchanged" a truthful "model default" label instead
// of a hard-coded Unity value that may or may not match the actual FBX.
const defaultPropertiesByClassName: ReadonlyMap<
  string,
  ReadonlyArray<{ key: string; value: UnityPropertyValue }>
> = new Map([
  [
    'MeshFilter',
    [
      {
        key: 'm_Mesh',
        value: {
          kind: 'reference' as const,
          reference: { fileId: '0', propertyPath: 'm_Mesh' },
        },
      },
    ],
  ],
  [
    'MeshRenderer',
    [
      { key: 'm_Enabled', value: modelDefault() },
      { key: 'm_CastShadows', value: modelDefault() },
      { key: 'm_ReceiveShadows', value: modelDefault() },
      { key: 'm_DynamicOccludee', value: modelDefault() },
      { key: 'm_StaticShadowCaster', value: modelDefault() },
      {
        key: 'm_Materials',
        value: { kind: 'sequence' as const, items: [] },
      },
      { key: 'm_ReceiveGI', value: modelDefault() },
      { key: 'm_LightProbeUsage', value: modelDefault() },
      { key: 'm_ReflectionProbeUsage', value: modelDefault() },
    ],
  ],
])

const defaultPropertiesFor = (
  className: string
): ReadonlyArray<{ key: string; value: UnityPropertyValue }> =>
  defaultPropertiesByClassName.get(className) ?? []

/**
 * Build documents from `synthesizeModelObjects`' output. Each synthesized
 * object becomes its own YAML document; GameObjects list every component in
 * `m_Component`, Transforms carry `m_Father` / `m_Children` derived from the
 * FBX parent chain, and other components (MeshFilter, MeshRenderer, etc.) get
 * a minimal `m_GameObject` back-reference so their identity survives the diff.
 */
const buildSynthesizedDocuments = (
  synthesized: ReadonlyArray<ISynthesizedModelObject>,
  rootName: string
): ReadonlyArray<IUnitySerializedDocument> => {
  // Group components by owning GameObject (identified by fbxUid + null-for-root).
  type GroupKey = string
  const keyOf = (fbxUid: string | null): GroupKey => fbxUid ?? '__root__'

  interface IGroup {
    fbxUid: string | null
    name: string
    parentFbxUid: string | null
    gameObject: ISynthesizedModelObject | null
    transform: ISynthesizedModelObject | null
    others: ISynthesizedModelObject[]
  }
  const groups = new Map<GroupKey, IGroup>()
  const groupFor = (obj: ISynthesizedModelObject): IGroup => {
    const key = keyOf(obj.fbxUid)
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        fbxUid: obj.fbxUid,
        name: obj.fbxUid === null ? rootName : obj.name,
        parentFbxUid: obj.parentFbxUid,
        gameObject: null,
        transform: null,
        others: [],
      }
      groups.set(key, group)
    }
    return group
  }
  for (const obj of synthesized) {
    const g = groupFor(obj)
    if (obj.className === 'GameObject') {
      g.gameObject = obj
    } else if (obj.className === 'Transform') {
      g.transform = obj
    } else {
      g.others.push(obj)
    }
  }

  // Second pass: children-of relationships between groups.
  const childrenByGroup = new Map<GroupKey, IGroup[]>()
  for (const g of groups.values()) {
    if (g.parentFbxUid === null && g.fbxUid !== null) {
      // Non-root FBX top-level Model: parent is the synthetic root.
      const rootKey = keyOf(null)
      const siblings = childrenByGroup.get(rootKey) ?? []
      siblings.push(g)
      childrenByGroup.set(rootKey, siblings)
    } else if (g.parentFbxUid !== null) {
      const parentKey = keyOf(g.parentFbxUid)
      const siblings = childrenByGroup.get(parentKey) ?? []
      siblings.push(g)
      childrenByGroup.set(parentKey, siblings)
    }
  }

  const docs = new Array<IUnitySerializedDocument>()
  for (const g of groups.values()) {
    if (g.gameObject === null || g.transform === null) {
      // Every group is expected to have at least a GameObject + Transform;
      // skip malformed entries rather than emit partial documents.
      continue
    }
    const components: UnityPropertyValue = {
      kind: 'sequence',
      items: [g.transform, ...g.others].map(comp => ({
        kind: 'map',
        entries: [
          {
            key: 'component',
            value: reference(comp.fileId, 'component'),
          },
        ],
      })),
    }
    docs.push({
      classId: gameObjectClassId,
      fileId: g.gameObject.fileId,
      typeName: 'GameObject',
      rootKey: 'GameObject',
      stripped: false,
      isModelDummy: true,
      rawTextRange: { start: 0, end: 0 },
      properties: [
        { key: 'm_Name', value: { kind: 'scalar', value: g.name } },
        { key: 'm_Component', value: components },
      ],
    })

    const children = childrenByGroup.get(keyOf(g.fbxUid)) ?? []
    const parentTransformFileId =
      g.fbxUid === null
        ? '0'
        : g.parentFbxUid === null
        ? groups.get(keyOf(null))?.transform?.fileId ?? '0'
        : groups.get(keyOf(g.parentFbxUid))?.transform?.fileId ?? '0'

    docs.push({
      classId: g.transform.classId,
      fileId: g.transform.fileId,
      typeName: getClassName(g.transform.classId),
      rootKey: getClassName(g.transform.classId),
      stripped: false,
      rawTextRange: { start: 0, end: 0 },
      properties: [
        {
          key: 'm_GameObject',
          value: reference(g.gameObject.fileId, 'm_GameObject'),
        },
        ...identityTransformProperties(),
        {
          key: 'm_Father',
          value: reference(parentTransformFileId, 'm_Father'),
        },
        {
          key: 'm_Children',
          value: {
            kind: 'sequence',
            items: children
              .filter(c => c.transform !== null)
              .map(c => ({
                kind: 'reference' as const,
                reference: {
                  fileId: c.transform!.fileId,
                  propertyPath: 'm_Children',
                },
              })),
          },
        },
      ],
    })

    for (const comp of g.others) {
      docs.push({
        classId: comp.classId,
        fileId: comp.fileId,
        typeName: getClassName(comp.classId),
        rootKey: getClassName(comp.classId),
        stripped: false,
        rawTextRange: { start: 0, end: 0 },
        properties: [
          {
            key: 'm_GameObject',
            value: reference(g.gameObject.fileId, 'm_GameObject'),
          },
          ...defaultPropertiesFor(comp.className),
        ],
      })
    }
  }
  return docs
}

/**
 * Build GameObject + Transform documents for a model from the best available
 * source. Precedence:
 *
 *   meta-table entries present  → use them (with optional FBX for nesting)
 *   meta empty + FBX available  → synthesize from FBX hash algorithm
 *   both absent                 → no documents
 *
 * `rootName` (the model's file basename) names the model root. The resulting
 * documents are treated by the prefab expander like any other source prefab.
 */
export const buildModelDocuments = (
  objects: ReadonlyArray<IModelObject>,
  rootName: string,
  fbxHierarchy?: IFbxHierarchy
): ReadonlyArray<IUnitySerializedDocument> => {
  if (objects.length > 0) {
    return buildMetaTableDocuments(objects, rootName, fbxHierarchy)
  }
  if (fbxHierarchy !== undefined) {
    return buildSynthesizedDocuments(
      synthesizeModelObjects(fbxHierarchy),
      rootName
    )
  }
  return []
}
