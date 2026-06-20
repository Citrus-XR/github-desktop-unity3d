import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import { buildHierarchy } from '../../../src/lib/unity/hierarchy-builder'

const scene = [
  '--- !u!1 &100',
  'GameObject:',
  '  m_Name: Root',
  '  m_IsActive: 1',
  '  m_Layer: 5',
  '  m_TagString: Player',
  '  m_Component:',
  '  - component: {fileID: 101}',
  '  - component: {fileID: 102}',
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
  '  m_Script: {fileID: 11500000, guid: abc, type: 3}',
  '--- !u!1 &200',
  'GameObject:',
  '  m_Name: Child',
  '  m_IsActive: 0',
  '  m_Component:',
  '  - component: {fileID: 201}',
  '--- !u!4 &201',
  'Transform:',
  '  m_GameObject: {fileID: 200}',
  '  m_Father: {fileID: 101}',
  '  m_Children: []',
].join('\n')

describe('buildHierarchy', () => {
  it('rebuilds the GameObject tree with parent/child links', () => {
    const { documents } = parseUnityYaml(scene)
    const roots = buildHierarchy(documents)

    assert.equal(roots.length, 1)
    const root = roots[0]
    assert.equal(root.name, 'Root')
    assert.equal(root.fileId, '100')
    assert.equal(root.active, true)
    assert.equal(root.layer, 5)
    assert.equal(root.tag, 'Player')
    assert.equal(root.parentFileId, undefined)

    assert.equal(root.children.length, 1)
    const child = root.children[0]
    assert.equal(child.name, 'Child')
    assert.equal(child.active, false)
    assert.equal(child.parentFileId, '100')
    assert.equal(child.children.length, 0)
  })

  it('lists components in serialized order, including the transform', () => {
    const { documents } = parseUnityYaml(scene)
    const root = buildHierarchy(documents)[0]

    assert.equal(root.components.length, 2)
    assert.equal(root.components[0].typeName, 'Transform')
    assert.equal(root.components[1].typeName, 'MonoBehaviour')
    assert.equal(root.components[1].enabled, true)
  })

  it('reconstructs parent/child from m_Father even when m_Children omits the child', () => {
    // The parent transform's m_Children is empty, but the child's m_Father
    // points at it. Trusting m_Children alone would drop the child or float it
    // to the top level; grouping by m_Father keeps the tree correct.
    const orphanScene = [
      '--- !u!1 &100',
      'GameObject:',
      '  m_Name: Root',
      '  m_Component:',
      '  - component: {fileID: 101}',
      '--- !u!4 &101',
      'Transform:',
      '  m_GameObject: {fileID: 100}',
      '  m_Father: {fileID: 0}',
      '  m_Children: []',
      '--- !u!1 &200',
      'GameObject:',
      '  m_Name: Child',
      '  m_Component:',
      '  - component: {fileID: 201}',
      '--- !u!4 &201',
      'Transform:',
      '  m_GameObject: {fileID: 200}',
      '  m_Father: {fileID: 101}',
      '  m_Children: []',
    ].join('\n')
    const roots = buildHierarchy(parseUnityYaml(orphanScene).documents)

    assert.equal(roots.length, 1)
    assert.equal(roots[0].name, 'Root')
    assert.equal(roots[0].children.length, 1)
    assert.equal(roots[0].children[0].name, 'Child')
  })

  it('promotes a GameObject parented under a stripped transform to a root', () => {
    // Prefab-variant content parents under a stripped base-prefab transform
    // (which carries no m_GameObject). Such objects must still appear rather
    // than being dropped because their parent produces no node.
    const variant = [
      '--- !u!4 &10 stripped',
      'Transform:',
      '  m_CorrespondingSourceObject: {fileID: 999, guid: abc, type: 3}',
      '  m_PrefabInstance: {fileID: 5}',
      '  m_PrefabAsset: {fileID: 0}',
      '--- !u!1 &100',
      'GameObject:',
      '  m_Name: VariantChild',
      '  m_Component:',
      '  - component: {fileID: 101}',
      '--- !u!4 &101',
      'Transform:',
      '  m_GameObject: {fileID: 100}',
      '  m_Father: {fileID: 10}',
      '  m_Children: []',
    ].join('\n')
    const roots = buildHierarchy(parseUnityYaml(variant).documents)
    assert.equal(roots.length, 1)
    assert.equal(roots[0].name, 'VariantChild')
  })

  it('produces a Missing component for an unresolved fileID', () => {
    const broken = [
      '--- !u!1 &1',
      'GameObject:',
      '  m_Name: Lonely',
      '  m_Component:',
      '  - component: {fileID: 999}',
      '--- !u!4 &2',
      'Transform:',
      '  m_GameObject: {fileID: 1}',
      '  m_Father: {fileID: 0}',
      '  m_Children: []',
    ].join('\n')
    const { documents } = parseUnityYaml(broken)
    const root = buildHierarchy(documents)[0]
    // The GameObject references components 999 (missing) — but its real
    // transform (2) is what roots it. Component 999 resolves to Missing.
    const missing = root.components.find(c => c.fileId === '999')
    assert.ok(missing)
    assert.equal(missing.typeName, 'Missing')
  })
})
