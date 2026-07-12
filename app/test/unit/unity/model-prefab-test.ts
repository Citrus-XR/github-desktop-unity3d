import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  buildModelDocuments,
  isModelPath,
  parseModelNameTable,
} from '../../../src/lib/unity/model-prefab'
import { parseFbxHierarchy } from '../../../src/lib/unity/fbx-hierarchy'
import {
  IUnityPropertyNode,
  UnityFileId,
} from '../../../src/models/unity/serialized-asset'

const metaTable = [
  '  internalIDToNameTable:',
  '  - first:',
  '      1: 100002',
  '    second: //RootNode',
  '  - first:',
  '      4: 400002',
  '    second: //RootNode',
  '  - first:',
  '      1: 100004',
  '    second: HourHand',
  '  - first:',
  '      4: 400004',
  '    second: HourHand',
].join('\n')

describe('isModelPath', () => {
  it('recognizes model file extensions', () => {
    assert.equal(isModelPath('Assets/Models/Clock.fbx'), true)
    assert.equal(isModelPath('Assets/Models/Clock.FBX'), true)
    assert.equal(isModelPath('Assets/Prefabs/Clock.prefab'), false)
  })
})

describe('parseModelNameTable', () => {
  it('parses classId/fileId/name triples', () => {
    const objects = parseModelNameTable(metaTable)
    assert.equal(objects.length, 4)
    assert.deepEqual(objects[1], {
      classId: 4,
      fileId: '400002',
      name: '//RootNode',
    })
  })
})

const scalar = (props: ReadonlyArray<IUnityPropertyNode>, key: string) => {
  const v = props.find(p => p.key === key)?.value
  return v && v.kind === 'scalar' ? v.value : undefined
}

const reference = (props: ReadonlyArray<IUnityPropertyNode>, key: string) => {
  const v = props.find(p => p.key === key)?.value
  return v && v.kind === 'reference' ? v.reference.fileId : undefined
}

const childFileIds = (
  props: ReadonlyArray<IUnityPropertyNode>
): UnityFileId[] => {
  const v = props.find(p => p.key === 'm_Children')?.value
  if (!v || v.kind !== 'sequence') {
    return []
  }
  return v.items.flatMap(item =>
    item.kind === 'reference' ? [item.reference.fileId] : []
  )
}

describe('buildModelDocuments', () => {
  it('reconstructs named GameObject/Transform pairs under the root', () => {
    const docs = buildModelDocuments(parseModelNameTable(metaTable), 'Clock')
    // Two transforms (400002 root, 400004) → 4 docs (GO + Transform each).
    const rootGo = docs.find(d => d.fileId === '100002')
    assert.ok(rootGo && rootGo.classId === 1)
    assert.equal(scalar(rootGo.properties, 'm_Name'), 'Clock')

    const handTransform = docs.find(d => d.fileId === '400004')
    assert.ok(handTransform && handTransform.classId === 4)
    assert.equal(reference(handTransform.properties, 'm_Father'), '400002')

    const handGo = docs.find(d => d.fileId === '100004')
    assert.equal(scalar(handGo!.properties, 'm_Name'), 'HourHand')
  })

  it('flattens every non-root Transform under the root when no FBX is given', () => {
    // The chain Armature -> Hips -> Spine is present in the .meta but the FBX
    // is unknown. Without a hierarchy source we must keep the historic flat
    // layout — everyone reports the root as father — so the diff engine at
    // least sees a valid, non-cyclic tree.
    const flatMeta = [
      '  internalIDToNameTable:',
      '  - first:',
      '      1: 100002',
      '    second: //RootNode',
      '  - first:',
      '      4: 400002',
      '    second: //RootNode',
      '  - first:',
      '      1: 100004',
      '    second: Armature',
      '  - first:',
      '      4: 400004',
      '    second: Armature',
      '  - first:',
      '      1: 100006',
      '    second: Hips',
      '  - first:',
      '      4: 400006',
      '    second: Hips',
      '  - first:',
      '      1: 100008',
      '    second: Spine',
      '  - first:',
      '      4: 400008',
      '    second: Spine',
    ].join('\n')

    const docs = buildModelDocuments(parseModelNameTable(flatMeta), 'Char')
    const father = (fileId: string) =>
      reference(docs.find(d => d.fileId === fileId)!.properties, 'm_Father')

    assert.equal(father('400004'), '400002', 'Armature falls back to root')
    assert.equal(father('400006'), '400002', 'Hips falls back to root')
    assert.equal(father('400008'), '400002', 'Spine falls back to root')

    // Root reports every non-root Transform as its immediate children.
    const rootTransform = docs.find(d => d.fileId === '400002')!
    assert.deepEqual([...childFileIds(rootTransform.properties)].sort(), [
      '400004',
      '400006',
      '400008',
    ])
  })

  it('re-parents Transforms according to the FBX hierarchy when supplied', () => {
    // The .meta table lists every bone as a peer of the root — that is the bug
    // the FBX-driven pass fixes. The FBX below encodes the real nesting
    // Armature → Hips → Spine → Chest, and buildModelDocuments should now use
    // it verbatim. This is the end-to-end proof that the fbx-parser
    // integration actually flows through to the emitted Unity documents.
    const nestedMeta = [
      '  internalIDToNameTable:',
      '  - first:',
      '      1: 100002',
      '    second: //RootNode',
      '  - first:',
      '      4: 400002',
      '    second: //RootNode',
      '  - first:',
      '      1: 100004',
      '    second: Armature',
      '  - first:',
      '      4: 400004',
      '    second: Armature',
      '  - first:',
      '      1: 100006',
      '    second: Hips',
      '  - first:',
      '      4: 400006',
      '    second: Hips',
      '  - first:',
      '      1: 100008',
      '    second: Spine',
      '  - first:',
      '      4: 400008',
      '    second: Spine',
      '  - first:',
      '      1: 100010',
      '    second: Chest',
      '  - first:',
      '      4: 400010',
      '    second: Chest',
    ].join('\n')

    const fbx = [
      'Objects:  {',
      '  Model: 4001, "Model::Armature", "Null" { Version: 232 }',
      '  Model: 4002, "Model::Hips", "LimbNode" { Version: 232 }',
      '  Model: 4003, "Model::Spine", "LimbNode" { Version: 232 }',
      '  Model: 4004, "Model::Chest", "LimbNode" { Version: 232 }',
      '}',
      'Connections:  {',
      '  C: "OO",4001,0',
      '  C: "OO",4002,4001',
      '  C: "OO",4003,4002',
      '  C: "OO",4004,4003',
      '}',
    ].join('\n')

    const hierarchy = parseFbxHierarchy(new TextEncoder().encode(fbx))
    const docs = buildModelDocuments(
      parseModelNameTable(nestedMeta),
      'Char',
      hierarchy
    )
    const father = (fileId: string) =>
      reference(docs.find(d => d.fileId === fileId)!.properties, 'm_Father')
    const children = (fileId: string) =>
      childFileIds(docs.find(d => d.fileId === fileId)!.properties)

    // Armature has no FBX parent → falls back to the model root.
    assert.equal(father('400004'), '400002')
    assert.equal(father('400006'), '400004', 'Hips is under Armature')
    assert.equal(father('400008'), '400006', 'Spine is under Hips')
    assert.equal(father('400010'), '400008', 'Chest is under Spine')

    assert.deepEqual(children('400002'), ['400004'])
    assert.deepEqual(children('400004'), ['400006'])
    assert.deepEqual(children('400006'), ['400008'])
    assert.deepEqual(children('400008'), ['400010'])
  })

  it('walks past FBX Null nodes that Unity omitted from its name table', () => {
    // The FBX has an intermediate `Rig` Null that Unity's importer collapsed
    // (no entry in internalIDToNameTable). The walk should keep climbing FBX
    // ancestors until it finds one Unity does expose.
    const partialMeta = [
      '  internalIDToNameTable:',
      '  - first:',
      '      1: 100002',
      '    second: //RootNode',
      '  - first:',
      '      4: 400002',
      '    second: //RootNode',
      '  - first:',
      '      1: 100004',
      '    second: Armature',
      '  - first:',
      '      4: 400004',
      '    second: Armature',
      '  - first:',
      '      1: 100006',
      '    second: Hips',
      '  - first:',
      '      4: 400006',
      '    second: Hips',
    ].join('\n')

    const fbx = [
      'Objects:  {',
      '  Model: 4001, "Model::Armature", "Null" { Version: 232 }',
      '  Model: 4900, "Model::Rig", "Null" { Version: 232 }',
      '  Model: 4002, "Model::Hips", "LimbNode" { Version: 232 }',
      '}',
      'Connections:  {',
      '  C: "OO",4001,0',
      '  C: "OO",4900,4001',
      '  C: "OO",4002,4900',
      '}',
    ].join('\n')

    const docs = buildModelDocuments(
      parseModelNameTable(partialMeta),
      'Char',
      parseFbxHierarchy(new TextEncoder().encode(fbx))
    )
    assert.equal(
      reference(docs.find(d => d.fileId === '400006')!.properties, 'm_Father'),
      '400004',
      'Hips should skip the collapsed Rig node and land on Armature'
    )
  })

  it('keeps ambiguously-named Transforms parented to the model root', () => {
    // Two Wrist bones in the FBX collide by leaf name. We refuse to guess and
    // leave them under the root — the historic flat behavior. The unambiguous
    // Head bone still gets its FBX parent.
    const meta = [
      '  internalIDToNameTable:',
      '  - first:',
      '      1: 100002',
      '    second: //RootNode',
      '  - first:',
      '      4: 400002',
      '    second: //RootNode',
      '  - first:',
      '      1: 100004',
      '    second: Neck',
      '  - first:',
      '      4: 400004',
      '    second: Neck',
      '  - first:',
      '      1: 100006',
      '    second: Head',
      '  - first:',
      '      4: 400006',
      '    second: Head',
      '  - first:',
      '      1: 100008',
      '    second: Wrist',
      '  - first:',
      '      4: 400008',
      '    second: Wrist',
      '  - first:',
      '      1: 100010',
      '    second: Wrist',
      '  - first:',
      '      4: 400010',
      '    second: Wrist',
    ].join('\n')

    const fbx = [
      'Objects:  {',
      '  Model: 4004, "Model::Neck", "LimbNode" { Version: 232 }',
      '  Model: 4006, "Model::Head", "LimbNode" { Version: 232 }',
      '  Model: 4008, "Model::Wrist", "LimbNode" { Version: 232 }',
      '  Model: 4010, "Model::Wrist", "LimbNode" { Version: 232 }',
      '}',
      'Connections:  {',
      '  C: "OO",4004,0',
      '  C: "OO",4006,4004',
      '  C: "OO",4008,4004',
      '  C: "OO",4010,4004',
      '}',
    ].join('\n')

    const docs = buildModelDocuments(
      parseModelNameTable(meta),
      'Char',
      parseFbxHierarchy(new TextEncoder().encode(fbx))
    )
    const father = (fileId: string) =>
      reference(docs.find(d => d.fileId === fileId)!.properties, 'm_Father')
    assert.equal(father('400006'), '400004', 'Unique Head keeps its FBX parent')
    assert.equal(father('400008'), '400002', 'Ambiguous Wrist stays under root')
    assert.equal(father('400010'), '400002', 'Ambiguous Wrist stays under root')
  })

  it('synthesizes documents from the FBX alone when the meta table is empty', () => {
    // Unity 2022 does not populate internalIDToNameTable by default — the
    // stable-ID hash algorithm produces the fileIDs, and the meta only records
    // deliberate user overrides. Verify that with no meta entries we still
    // build a full tree from the FBX, using the same hashed fileIDs Unity
    // would generate. `-8679921383154817045` is the observed root Transform
    // from mouse_booth.prefab (three top-level FBX Models → no root fold).
    const fbx = [
      'Objects:  {',
      '  Model: 4001, "Model::tube", "Null" {',
      '    Version: 232',
      '  }',
      '  Model: 4002, "Model::hachimaki", "Null" {',
      '    Version: 232',
      '  }',
      '  Model: 4003, "Model::base", "Null" {',
      '    Version: 232',
      '  }',
      '  Model: 4100, "Model::pCylinder12", "Mesh" {',
      '    Version: 232',
      '  }',
      '}',
      'Connections:  {',
      '  C: "OO",4001,0',
      '  C: "OO",4002,0',
      '  C: "OO",4003,0',
      '  C: "OO",4100,4001',
      '}',
    ].join('\n')

    const docs = buildModelDocuments(
      [],
      'mouse_booth',
      parseFbxHierarchy(new TextEncoder().encode(fbx))
    )

    // Root GameObject + Transform present with the expected hashed fileIDs.
    const rootGo = docs.find(d => d.fileId === '919132149155446097')
    assert.ok(rootGo, 'synthetic root GameObject exists')
    assert.equal(scalar(rootGo.properties, 'm_Name'), 'mouse_booth')

    const rootTransform = docs.find(d => d.fileId === '-8679921383154817045')
    assert.ok(rootTransform, 'synthetic root Transform exists')

    // pCylinder12 sits under tube under the synthetic root.
    const p12Transform = docs.find(d => d.fileId === '3070783425072336940')
    assert.ok(p12Transform, 'pCylinder12 Transform exists')
    assert.equal(
      reference(p12Transform.properties, 'm_Father'),
      '-347287514121497074',
      'pCylinder12 is parented to tube'
    )

    // Mesh kinds get MeshFilter and MeshRenderer alongside Transform.
    assert.ok(
      docs.find(d => d.fileId === '-7834930373403656032'),
      'pCylinder12 MeshRenderer exists'
    )
  })

  it('returns no documents when neither meta table nor FBX is available', () => {
    assert.deepEqual(buildModelDocuments([], 'Empty'), [])
  })
})
