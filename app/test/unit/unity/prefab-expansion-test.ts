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
  value !== undefined && value.kind === 'reference'
    ? value.reference.fileId
    : undefined

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
    assert.equal(
      expanded.some(d => d.classId === 1001),
      false
    )
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

  it('grafts m_AddedComponents onto the target GameObject', () => {
    // A prefab variant adds a MonoBehaviour (fileID 900) to the source
    // GameObject (source fileID 100). The expansion must extend that
    // GameObject's m_Component list so the hierarchy walk finds the added
    // component rather than leaving it orphaned.
    const docs = parseUnityYaml(
      [
        '--- !u!1001 &5000',
        'PrefabInstance:',
        '  m_Modification:',
        '    m_TransformParent: {fileID: 0}',
        '    m_Modifications: []',
        '    m_AddedComponents:',
        '    - targetCorrespondingSourceObject: {fileID: 100, guid: srcguid, type: 3}',
        '      insertIndex: -1',
        '      addedObject: {fileID: 900}',
        '  m_SourcePrefab: {fileID: 100100000, guid: srcguid, type: 3}',
        '--- !u!114 &900',
        'MonoBehaviour:',
        '  m_GameObject: {fileID: 0}',
        '  m_Enabled: 1',
        '  m_Script: {fileID: 11500000, guid: extra, type: 3}',
        '  m_Name: Extra',
      ].join('\n')
    ).documents
    const expanded = expandPrefabInstances(docs, resolve)
    const goId = remapFileId('5000', '100')
    const go = byId(expanded, goId)
    assert.ok(go, 'cloned GameObject should exist')
    const components = prop(go.properties, 'm_Component')
    assert.equal(components?.kind, 'sequence')
    if (components?.kind !== 'sequence') {
      return
    }
    const referencedIds = components.items
      .map(item =>
        item.kind === 'map' ? refId(prop(item.entries, 'component')) : undefined
      )
      .filter((id): id is string => id !== undefined)
    // Original source component (Transform → id 101, cloned to remapped id)
    // plus the newly grafted MonoBehaviour at its own id 900.
    assert.ok(
      referencedIds.includes('900'),
      'the added component fileID should appear on the target GameObject'
    )
  })

  it('bakes a nested-path override into the cloned property tree', () => {
    // `m_LocalPosition.x` targets a scalar deep inside a map — the value
    // must land on the actual field, not on a fresh top-level `m_LocalPosition.x`
    // key. Vector3s in Unity's tree parse as a map of x/y/z scalars, so this
    // exercises the path walker on the same shape production data uses.
    const withPositionSource = parseUnityYaml(
      [
        '--- !u!1 &100',
        'GameObject:',
        '  m_Name: Base',
        '  m_Component:',
        '  - component: {fileID: 101}',
        '--- !u!4 &101',
        'Transform:',
        '  m_GameObject: {fileID: 100}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_Father: {fileID: 0}',
        '  m_Children: []',
      ].join('\n')
    ).documents
    const docs = parseUnityYaml(
      [
        '--- !u!1001 &5000',
        'PrefabInstance:',
        '  m_Modification:',
        '    m_TransformParent: {fileID: 0}',
        '    m_Modifications:',
        '    - target: {fileID: 101, guid: srcguid, type: 3}',
        '      propertyPath: m_LocalPosition.x',
        '      value: 1.5',
        '      objectReference: {fileID: 0}',
        '  m_SourcePrefab: {fileID: 100100000, guid: srcguid, type: 3}',
      ].join('\n')
    ).documents
    const expanded = expandPrefabInstances(docs, guid =>
      guid === 'srcguid' ? withPositionSource : null
    )
    const tr = byId(expanded, remapFileId('5000', '101'))!
    const pos = prop(tr.properties, 'm_LocalPosition')
    assert.equal(pos?.kind, 'map')
    if (pos?.kind !== 'map') {
      return
    }
    assert.equal(scalar(prop(pos.entries, 'x')), '1.5')
    // Unchanged siblings are untouched.
    assert.equal(scalar(prop(pos.entries, 'y')), '0')
  })

  it('applies an objectReference override to a reference field', () => {
    // When an override's `value:` is empty and `objectReference:` points
    // somewhere, the object-typed field on the clone must swap to that
    // reference — not to a stringified representation.
    const withScriptSource = parseUnityYaml(
      ['--- !u!114 &200', 'MonoBehaviour:', '  m_Target: {fileID: 0}'].join(
        '\n'
      )
    ).documents
    const docs = parseUnityYaml(
      [
        '--- !u!1001 &5000',
        'PrefabInstance:',
        '  m_Modification:',
        '    m_TransformParent: {fileID: 0}',
        '    m_Modifications:',
        '    - target: {fileID: 200, guid: refguid, type: 3}',
        '      propertyPath: m_Target',
        '      value:',
        '      objectReference: {fileID: 12345}',
        '  m_SourcePrefab: {fileID: 100100000, guid: refguid, type: 3}',
      ].join('\n')
    ).documents
    const expanded = expandPrefabInstances(docs, guid =>
      guid === 'refguid' ? withScriptSource : null
    )
    const mb = byId(expanded, remapFileId('5000', '200'))!
    const target = prop(mb.properties, 'm_Target')
    assert.equal(target?.kind, 'reference')
    if (target?.kind !== 'reference') {
      return
    }
    assert.equal(target.reference.fileId, '12345')
  })

  it('reshapes an array via Array.size and writes indexed values', () => {
    const withArraySource = parseUnityYaml(
      ['--- !u!114 &300', 'MonoBehaviour:', '  m_Items: []'].join('\n')
    ).documents
    const docs = parseUnityYaml(
      [
        '--- !u!1001 &5000',
        'PrefabInstance:',
        '  m_Modification:',
        '    m_TransformParent: {fileID: 0}',
        '    m_Modifications:',
        '    - target: {fileID: 300, guid: arrguid, type: 3}',
        '      propertyPath: m_Items.Array.size',
        '      value: 2',
        '      objectReference: {fileID: 0}',
        '    - target: {fileID: 300, guid: arrguid, type: 3}',
        '      propertyPath: m_Items.Array.data[0]',
        '      value: hello',
        '      objectReference: {fileID: 0}',
        '  m_SourcePrefab: {fileID: 100100000, guid: arrguid, type: 3}',
      ].join('\n')
    ).documents
    const expanded = expandPrefabInstances(docs, guid =>
      guid === 'arrguid' ? withArraySource : null
    )
    const mb = byId(expanded, remapFileId('5000', '300'))!
    const items = prop(mb.properties, 'm_Items')
    assert.equal(items?.kind, 'sequence')
    if (items?.kind !== 'sequence') {
      return
    }
    assert.equal(items.items.length, 2)
    assert.equal(scalar(items.items[0]), 'hello')
  })

  it('reports override keys via the applied out-parameter', () => {
    const applied = new Set<string>()
    expandPrefabInstances(
      instanceDocs,
      resolve,
      undefined,
      undefined,
      undefined,
      undefined,
      applied
    )
    assert.ok(
      Array.from(applied).some(k => k.endsWith('::m_Name')),
      'm_Name override should have been recorded as applied'
    )
  })
})

describe('remapFileId', () => {
  it('is XOR of the two ids masked to 63 bits', () => {
    assert.equal(
      remapFileId('5000', '100'),
      ((5000n ^ 100n) & 0x7fffffffffffffffn).toString()
    )
  })
})
