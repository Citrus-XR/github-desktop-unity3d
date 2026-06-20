import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import { diffPrefabInstances } from '../../../src/lib/unity/prefab-diff'

const instance = (posX: string, extra: string = '') =>
  [
    '--- !u!1001 &11866470',
    'PrefabInstance:',
    '  m_ObjectHideFlags: 0',
    '  serializedVersion: 2',
    '  m_Modification:',
    '    serializedVersion: 3',
    '    m_TransformParent: {fileID: 1122852772}',
    '    m_Modifications:',
    '    - target: {fileID: 599465214307944399, guid: abcd, type: 3}',
    '      propertyPath: m_LocalPosition.x',
    `      value: ${posX}`,
    '      objectReference: {fileID: 0}',
    '    - target: {fileID: 8354524949365800270, guid: abcd, type: 3}',
    '      propertyPath: m_Name',
    '      value: Chair (1)',
    '      objectReference: {fileID: 0}',
    extra,
    '    m_RemovedComponents: []',
    '    m_RemovedGameObjects: []',
    '    m_AddedGameObjects: []',
    '    m_AddedComponents: []',
    '  m_SourcePrefab: {fileID: 100100000, guid: abcd, type: 3}',
  ]
    .filter(line => line.length > 0)
    .join('\n')

describe('diffPrefabInstances', () => {
  it('diffs a changed override entry by target and propertyPath', () => {
    const before = parseUnityYaml(instance('10')).documents
    const after = parseUnityYaml(instance('25')).documents

    const diffs = diffPrefabInstances(before, after)
    assert.equal(diffs.length, 1)
    const inst = diffs[0]
    assert.equal(inst.fileId, '11866470')
    assert.equal(inst.status, 'modified')
    assert.equal(inst.sourcePrefabGuid, 'abcd')
    assert.equal(inst.name, 'Chair (1)')

    const pos = inst.overrides.find(o => o.propertyPath === 'm_LocalPosition.x')
    assert.equal(pos?.status, 'modified')
    assert.equal(pos?.before, '10')
    assert.equal(pos?.after, '25')

    const name = inst.overrides.find(o => o.propertyPath === 'm_Name')
    assert.equal(name?.status, 'unchanged')
  })

  it('detects an added override', () => {
    const before = parseUnityYaml(instance('10')).documents
    const after = parseUnityYaml(
      instance(
        '10',
        ['    - target: {fileID: 599465214307944399, guid: abcd, type: 3}',
         '      propertyPath: m_LocalPosition.y',
         '      value: 7',
         '      objectReference: {fileID: 0}'].join('\n')
      )
    ).documents

    const added = diffPrefabInstances(before, after)[0].overrides.find(
      o => o.propertyPath === 'm_LocalPosition.y'
    )
    assert.equal(added?.status, 'added')
    assert.equal(added?.after, '7')
  })

  it('reports no prefab instances for a plain asset', () => {
    const docs = parseUnityYaml(
      ['--- !u!1 &1', 'GameObject:', '  m_Name: Plain'].join('\n')
    ).documents
    assert.equal(diffPrefabInstances(docs, docs).length, 0)
  })
})
