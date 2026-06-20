/**
 * Synthesizes serialized documents for an imported model (FBX/OBJ/etc.) from
 * its `.meta` file's `internalIDToNameTable`. A model prefab instantiates a
 * binary model whose object hierarchy lives in the (binary, git-absent) model
 * file — but the `.meta` records every model object's fileID and name. We use
 * that to reconstruct the model's GameObjects and Transforms with their real
 * names so prefab/scene objects parented to them resolve and nest, rather than
 * floating to the hierarchy root.
 *
 * What git cannot provide is the model's internal parent/child nesting (it is
 * in the binary file); reconstructed model objects are therefore placed flat
 * under the model root. Names, identities, and the root are exact.
 */

import {
  IUnitySerializedDocument,
  UnityFileId,
} from '../../models/unity/serialized-asset'
import { getClassName, transformClassIds } from '../../models/unity/class-ids'

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

/**
 * Build GameObject + Transform documents for a model from its `.meta` name
 * table. `rootName` (the model's file basename) names the `//RootNode`. The
 * resulting documents are treated by the prefab expander like any other source
 * prefab.
 */
export const buildModelDocuments = (
  objects: ReadonlyArray<IModelObject>,
  rootName: string
): ReadonlyArray<IUnitySerializedDocument> => {
  const transforms = objects.filter(o => transformClassIds.has(o.classId))
  const root =
    transforms.find(t => t.name === '//RootNode') ?? transforms.at(0)
  if (root === undefined) {
    return []
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
                  { key: 'component', value: reference(transform.fileId, 'component') },
                ],
              },
            ],
          },
        },
      ],
    })

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
          value: reference(isRoot ? '0' : root.fileId, 'm_Father'),
        },
        { key: 'm_Children', value: { kind: 'sequence', items: [] } },
      ],
    })
  }
  return docs
}
