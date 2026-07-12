import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import { buildPrefabTargetIndex } from '../../../src/lib/unity/prefab-target-index'
import { computeUnityAssetDiff } from '../../../src/lib/unity/asset-diff'
import { collectReferencedGuids } from '../../../src/lib/unity/reference-collector'

const sourcePrefab = [
  '--- !u!1 &100',
  'GameObject:',
  '  m_ObjectHideFlags: 0',
  '  m_Component:',
  '  - component: {fileID: 101}',
  '  - component: {fileID: 102}',
  '  m_Name: Root',
  '--- !u!4 &101',
  'Transform:',
  '  m_GameObject: {fileID: 100}',
  '  m_Father: {fileID: 0}',
  '  m_Children:',
  '  - {fileID: 201}',
  '--- !u!114 &102',
  'MonoBehaviour:',
  '  m_GameObject: {fileID: 100}',
  '  m_Enabled: 1',
  '  m_Script: {fileID: 11500000, guid: scriptguid, type: 3}',
  '--- !u!1 &200',
  'GameObject:',
  '  m_Component:',
  '  - component: {fileID: 201}',
  '  m_Name: Child',
  '--- !u!4 &201',
  'Transform:',
  '  m_GameObject: {fileID: 200}',
  '  m_Father: {fileID: 101}',
  '  m_Children: []',
].join('\n')

describe('buildPrefabTargetIndex', () => {
  it('labels a GameObject target with its name and hierarchy path', () => {
    const documents = parseUnityYaml(sourcePrefab).documents
    const index = buildPrefabTargetIndex(documents, () => undefined)
    const child = index.get('200')
    assert.equal(child?.kind, 'GameObject')
    assert.equal(child?.ownerGameObjectFileId, '200')
    assert.equal(child?.ownerName, 'Child')
    assert.equal(child?.ownerPath, 'Root/Child')
  })

  it('resolves a Transform component to its owning GameObject', () => {
    const documents = parseUnityYaml(sourcePrefab).documents
    const index = buildPrefabTargetIndex(documents, () => undefined)
    const childTransform = index.get('201')
    assert.equal(childTransform?.kind, 'Component')
    assert.equal(childTransform?.componentType, 'Transform')
    assert.equal(childTransform?.ownerName, 'Child')
    assert.equal(childTransform?.ownerPath, 'Root/Child')
  })

  it('uses the resolved script basename for a MonoBehaviour component', () => {
    const documents = parseUnityYaml(sourcePrefab).documents
    const index = buildPrefabTargetIndex(documents, guid =>
      guid === 'scriptguid' ? 'PlayerController' : undefined
    )
    const script = index.get('102')
    assert.equal(script?.kind, 'Component')
    assert.equal(script?.componentType, 'PlayerController')
    assert.equal(script?.ownerPath, 'Root')
  })
})

const scenePrefabInstance = (posX: string) =>
  [
    '--- !u!1001 &900',
    'PrefabInstance:',
    '  m_ObjectHideFlags: 0',
    '  serializedVersion: 2',
    '  m_Modification:',
    '    serializedVersion: 3',
    '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:',
    '    - target: {fileID: 201, guid: sourceguid, type: 3}',
    '      propertyPath: m_LocalPosition.x',
    `      value: ${posX}`,
    '      objectReference: {fileID: 0}',
    '    - target: {fileID: 200, guid: sourceguid, type: 3}',
    '      propertyPath: m_Name',
    '      value: Renamed',
    '      objectReference: {fileID: 0}',
    '    m_RemovedComponents: []',
    '    m_RemovedGameObjects: []',
    '    m_AddedGameObjects: []',
    '    m_AddedComponents: []',
    '  m_SourcePrefab: {fileID: 100100000, guid: sourceguid, type: 3}',
  ].join('\n')

const parseSide = (content: string) => {
  const parsed = parseUnityYaml(content)
  return {
    present: true,
    documents: parsed.documents,
    roots: [],
    status: parsed.status,
    warnings: [...parsed.warnings],
    referencedGuids: Array.from(collectReferencedGuids(parsed.documents)),
  }
}

describe('computeUnityAssetDiff enrichment', () => {
  it('fills GameObject path and component type on each override', () => {
    const before = parseSide(scenePrefabInstance('1'))
    const after = parseSide(scenePrefabInstance('2'))
    const sources = new Map([
      ['sourceguid', parseUnityYaml(sourcePrefab).documents],
    ])
    const pathForGuid = (guid: string) =>
      guid === 'sourceguid' ? 'Assets/Src.prefab' : undefined

    const { result } = computeUnityAssetDiff(
      before,
      after,
      sources,
      pathForGuid
    )
    const instance = result.prefabInstances.find(i => i.fileId === '900')
    assert.ok(instance !== undefined)

    const pos = instance.overrides.find(
      o => o.propertyPath === 'm_LocalPosition.x'
    )
    assert.equal(pos?.targetKind, 'Component')
    assert.equal(pos?.targetComponentType, 'Transform')
    assert.equal(pos?.targetGameObjectName, 'Child')
    assert.equal(pos?.targetGameObjectPath, 'Root/Child')
    assert.equal(pos?.targetGameObjectFileId, '200')

    const rename = instance.overrides.find(o => o.propertyPath === 'm_Name')
    assert.equal(rename?.targetKind, 'GameObject')
    assert.equal(rename?.targetGameObjectName, 'Child')
    assert.equal(rename?.targetGameObjectPath, 'Root/Child')
  })

  it('flags floating-point drift and leaves semantic changes alone', () => {
    // Two overrides on the same axis with wildly different magnitudes of change:
    // 0.24135046 → 0.24135065 is Unity's quaternion re-serialization wobble
    // (relative delta ~8e-7), whereas 1 → 2 is a real edit.
    const withValue = (a: string, b: string) =>
      [
        '--- !u!1001 &900',
        'PrefabInstance:',
        '  m_ObjectHideFlags: 0',
        '  serializedVersion: 2',
        '  m_Modification:',
        '    serializedVersion: 3',
        '    m_TransformParent: {fileID: 0}',
        '    m_Modifications:',
        '    - target: {fileID: 201, guid: sourceguid, type: 3}',
        '      propertyPath: m_LocalRotation.w',
        `      value: ${a}`,
        '      objectReference: {fileID: 0}',
        '    - target: {fileID: 201, guid: sourceguid, type: 3}',
        '      propertyPath: m_LocalPosition.x',
        `      value: ${b}`,
        '      objectReference: {fileID: 0}',
        '    m_RemovedComponents: []',
        '    m_RemovedGameObjects: []',
        '    m_AddedGameObjects: []',
        '    m_AddedComponents: []',
        '  m_SourcePrefab: {fileID: 100100000, guid: sourceguid, type: 3}',
      ].join('\n')
    const before = parseSide(withValue('0.24135046', '1'))
    const after = parseSide(withValue('0.24135065', '2'))
    const sources = new Map([
      ['sourceguid', parseUnityYaml(sourcePrefab).documents],
    ])
    const { result } = computeUnityAssetDiff(
      before,
      after,
      sources,
      () => undefined
    )
    const instance = result.prefabInstances.find(i => i.fileId === '900')
    assert.ok(instance !== undefined)
    const drift = instance.overrides.find(
      o => o.propertyPath === 'm_LocalRotation.w'
    )
    const real = instance.overrides.find(
      o => o.propertyPath === 'm_LocalPosition.x'
    )
    assert.equal(drift?.trivialFloatDrift, true)
    assert.equal(real?.trivialFloatDrift, undefined)
  })
})
