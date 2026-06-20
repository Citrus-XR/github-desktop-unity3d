import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import {
  expandPrefabInstances,
  remapFileId,
} from '../../../src/lib/unity/prefab-expansion'
import {
  IUnitySerializedDocument,
  IUnityPropertyNode,
  UnityPropertyValue,
} from '../../../src/models/unity/serialized-asset'

const prop = (
  nodes: ReadonlyArray<IUnityPropertyNode>,
  key: string
): UnityPropertyValue | undefined => nodes.find(n => n.key === key)?.value

const refId = (value: UnityPropertyValue | undefined): string | undefined =>
  value !== undefined && value.kind === 'reference' ? value.reference.fileId : undefined

const scalar = (value: UnityPropertyValue | undefined): string | undefined =>
  value !== undefined && value.kind === 'scalar' ? value.value : undefined

const sourceDocs = parseUnityYaml(
  [
    '--- !u!1 &100',
    'GameObject:',
    '  m_Name: Base',
    '  m_Component:',
    '  - component: {fileID: 101}',
    '--- !u!4 &101',
    'Transform:',
    '  m_GameObject: {fileID: 100}',
    '  m_Father: {fileID: 0}',
    '  m_Children: []',
  ].join('\n')
).documents

const instanceDocs = parseUnityYaml(
  [
    '--- !u!1001 &5000',
    'PrefabInstance:',
    '  m_Modification:',
    '    m_TransformParent: {fileID: 9999}',
    '    m_Modifications:',
    '    - target: {fileID: 100, guid: srcguid, type: 3}',
    '      propertyPath: m_Name',
    '      value: RenamedInstance',
    '      objectReference: {fileID: 0}',
    '    m_RemovedComponents: []',
    '  m_SourcePrefab: {fileID: 100100000, guid: srcguid, type: 3}',
  ].join('\n')
).documents

const resolve = (guid: string) => (guid === 'srcguid' ? sourceDocs : null)

const byId = (
  docs: ReadonlyArray<IUnitySerializedDocument>,
  id: string
): IUnitySerializedDocument | undefined => docs.find(d => d.fileId === id)

describe('expandPrefabInstances', () => {
  it('clones source objects into the instance id space', () => {
    const expanded = expandPrefabInstances(instanceDocs, resolve)
    const goId = remapFileId('5000', '100')
    const trId = remapFileId('5000', '101')

    const go = byId(expanded, goId)
    assert.ok(go, 'cloned GameObject should exist at the remapped id')
    assert.equal(go.classId, 1)

    const tr = byId(expanded, trId)
    assert.ok(tr, 'cloned Transform should exist at the remapped id')
    // Internal reference remapped: the transform points at the cloned GO.
    assert.equal(refId(prop(tr.properties, 'm_GameObject')), goId)
  })

  it('reparents the instance root via m_TransformParent', () => {
    const expanded = expandPrefabInstances(instanceDocs, resolve)
    const tr = byId(expanded, remapFileId('5000', '101'))
    assert.equal(refId(prop(tr!.properties, 'm_Father')), '9999')
  })

  it('applies an m_Name override to the cloned object', () => {
    const expanded = expandPrefabInstances(instanceDocs, resolve)
    const go = byId(expanded, remapFileId('5000', '100'))
    assert.equal(scalar(prop(go!.properties, 'm_Name')), 'RenamedInstance')
  })

  it('drops the PrefabInstance document after expansion', () => {
    const expanded = expandPrefabInstances(instanceDocs, resolve)
    assert.equal(expanded.some(d => d.classId === 1001), false)
  })

  it('leaves documents unchanged when the source cannot be resolved', () => {
    const expanded = expandPrefabInstances(instanceDocs, () => null)
    // No source → nothing to graft; the 1001 is dropped, result is empty.
    assert.equal(expanded.length, 0)
  })

  it('clones to the stripped placeholder scene id so references resolve', () => {
    // The scene references the instance's transform by the stripped placeholder
    // id (777), which is NOT the XOR-derived id. The clone must adopt 777.
    const docs = parseUnityYaml(
      [
        '--- !u!1001 &5000',
        'PrefabInstance:',
        '  m_Modification:',
        '    m_TransformParent: {fileID: 0}',
        '    m_Modifications: []',
        '  m_SourcePrefab: {fileID: 100100000, guid: srcguid, type: 3}',
        '--- !u!4 &777 stripped',
        'Transform:',
        '  m_CorrespondingSourceObject: {fileID: 101, guid: srcguid, type: 3}',
        '  m_PrefabInstance: {fileID: 5000}',
        '  m_PrefabAsset: {fileID: 0}',
      ].join('\n')
    ).documents
    const expanded = expandPrefabInstances(docs, resolve)
    assert.ok(
      byId(expanded, '777'),
      'the source transform should be cloned at the placeholder id 777'
    )
    assert.notEqual(remapFileId('5000', '101'), '777')
  })
})

describe('remapFileId', () => {
  it('is XOR of the two ids masked to 63 bits', () => {
    assert.equal(remapFileId('5000', '100'), ((5000n ^ 100n) & 0x7fffffffffffffffn).toString())
  })
})
