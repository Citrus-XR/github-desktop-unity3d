import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  normalizeFileId,
  parseUnityYaml,
} from '../../../src/lib/unity/unity-yaml-parser'
import {
  IUnityPropertyNode,
  UnityPropertyValue,
} from '../../../src/models/unity/serialized-asset'

const prop = (
  nodes: ReadonlyArray<IUnityPropertyNode>,
  key: string
): UnityPropertyValue | undefined => nodes.find(n => n.key === key)?.value

const scalar = (value: UnityPropertyValue | undefined): string => {
  assert.ok(
    value && value.kind === 'scalar',
    `expected scalar, got ${value?.kind}`
  )
  return value.value
}

describe('parseUnityYaml', () => {
  it('parses a document header into classId, fileId and friendly type', () => {
    const result = parseUnityYaml(
      ['--- !u!1 &105849213', 'GameObject:', '  m_Name: Player'].join('\n')
    )

    assert.equal(result.status, 'parsed')
    assert.equal(result.documents.length, 1)
    const doc = result.documents[0]
    assert.equal(doc.classId, 1)
    assert.equal(doc.fileId, '105849213')
    assert.equal(doc.typeName, 'GameObject')
    assert.equal(doc.rootKey, 'GameObject')
    assert.equal(doc.stripped, false)
    assert.equal(scalar(prop(doc.properties, 'm_Name')), 'Player')
  })

  it('preserves negative and very large fileIDs as exact decimal strings', () => {
    const result = parseUnityYaml(
      [
        '--- !u!4 &-8200000123456789',
        'Transform:',
        '--- !u!114 &9999999999999999999',
        'MonoBehaviour:',
      ].join('\n')
    )

    assert.equal(result.documents[0].fileId, '-8200000123456789')
    // Beyond Number.MAX_SAFE_INTEGER — must survive without precision loss.
    assert.equal(result.documents[1].fileId, '9999999999999999999')
  })

  it('keeps unknown class IDs with a placeholder name instead of dropping them', () => {
    const result = parseUnityYaml(
      ['--- !u!123456 &1', 'SomeFutureType:', '  m_Value: 3'].join('\n')
    )

    assert.equal(result.documents.length, 1)
    assert.equal(result.documents[0].classId, 123456)
    assert.equal(result.documents[0].typeName, 'Class123456')
    assert.equal(result.documents[0].rootKey, 'SomeFutureType')
  })

  it('marks stripped prefab-instance documents', () => {
    const result = parseUnityYaml(
      ['--- !u!1 &42 stripped', 'GameObject:'].join('\n')
    )
    assert.equal(result.documents[0].stripped, true)
  })

  it('parses an inline flow mapping as a nested map of scalars', () => {
    const result = parseUnityYaml(
      [
        '--- !u!4 &1',
        'Transform:',
        '  m_LocalPosition: {x: 1, y: 2.5, z: -3}',
      ].join('\n')
    )
    const pos = prop(result.documents[0].properties, 'm_LocalPosition')
    assert.ok(pos && pos.kind === 'map')
    assert.equal(scalar(prop(pos.entries, 'x')), '1')
    assert.equal(scalar(prop(pos.entries, 'y')), '2.5')
    assert.equal(scalar(prop(pos.entries, 'z')), '-3')
  })

  it('recognizes an internal (same-asset) object reference', () => {
    const result = parseUnityYaml(
      ['--- !u!4 &1', 'Transform:', '  m_GameObject: {fileID: 105849213}'].join(
        '\n'
      )
    )
    const ref = prop(result.documents[0].properties, 'm_GameObject')
    assert.ok(ref && ref.kind === 'reference')
    assert.equal(ref.reference.fileId, '105849213')
    assert.equal(ref.reference.guid, undefined)
    assert.equal(ref.reference.propertyPath, 'm_GameObject')
  })

  it('recognizes a cross-asset reference with guid and type', () => {
    const result = parseUnityYaml(
      [
        '--- !u!114 &1',
        'MonoBehaviour:',
        '  m_Script: {fileID: 11500000, guid: abcdef1234567890, type: 3}',
      ].join('\n')
    )
    const ref = prop(result.documents[0].properties, 'm_Script')
    assert.ok(ref && ref.kind === 'reference')
    assert.equal(ref.reference.fileId, '11500000')
    assert.equal(ref.reference.guid, 'abcdef1234567890')
    assert.equal(ref.reference.referenceType, 3)
  })

  it('parses a block sequence of single-key mapping items (m_Component)', () => {
    const result = parseUnityYaml(
      [
        '--- !u!1 &1',
        'GameObject:',
        '  m_Component:',
        '  - component: {fileID: 446}',
        '  - component: {fileID: 447}',
        '  m_Layer: 0',
      ].join('\n')
    )
    const comps = prop(result.documents[0].properties, 'm_Component')
    assert.ok(comps && comps.kind === 'sequence')
    assert.equal(comps.items.length, 2)
    const first = comps.items[0]
    assert.ok(first.kind === 'map')
    const ref = prop(first.entries, 'component')
    assert.ok(ref && ref.kind === 'reference')
    assert.equal(ref.reference.fileId, '446')
    // The sibling after the sequence must still be parsed.
    assert.equal(scalar(prop(result.documents[0].properties, 'm_Layer')), '0')
  })

  it('parses multi-line mapping items in a sequence (PropertyModification)', () => {
    const result = parseUnityYaml(
      [
        '--- !u!1001 &1',
        'PrefabInstance:',
        '  m_Modification:',
        '    m_Modifications:',
        '    - target: {fileID: 100, guid: aaa, type: 3}',
        '      propertyPath: m_Name',
        '      value: Renamed',
        '      objectReference: {fileID: 0}',
      ].join('\n')
    )
    const mod = prop(result.documents[0].properties, 'm_Modification')
    assert.ok(mod && mod.kind === 'map')
    const mods = prop(mod.entries, 'm_Modifications')
    assert.ok(mods && mods.kind === 'sequence')
    assert.equal(mods.items.length, 1)
    const item = mods.items[0]
    assert.ok(item.kind === 'map')
    assert.equal(scalar(prop(item.entries, 'propertyPath')), 'm_Name')
    assert.equal(scalar(prop(item.entries, 'value')), 'Renamed')
    const target = prop(item.entries, 'target')
    assert.ok(target && target.kind === 'reference')
    assert.equal(target.reference.guid, 'aaa')
  })

  it('parses an empty inline array', () => {
    const result = parseUnityYaml(
      ['--- !u!1 &1', 'GameObject:', '  m_Component: []'].join('\n')
    )
    const comps = prop(result.documents[0].properties, 'm_Component')
    assert.ok(comps && comps.kind === 'sequence')
    assert.equal(comps.items.length, 0)
  })

  it('handles CRLF line endings', () => {
    const result = parseUnityYaml(
      ['--- !u!1 &1', 'GameObject:', '  m_Name: Player'].join('\r\n')
    )
    assert.equal(result.status, 'parsed')
    assert.equal(
      scalar(prop(result.documents[0].properties, 'm_Name')),
      'Player'
    )
  })

  it('handles non-ASCII object names', () => {
    const result = parseUnityYaml(
      ['--- !u!1 &1', 'GameObject:', '  m_Name: プレイヤー'].join('\n')
    )
    assert.equal(
      scalar(prop(result.documents[0].properties, 'm_Name')),
      'プレイヤー'
    )
  })

  it('decodes \\uXXXX escapes in double-quoted scalars (Unity non-ASCII)', () => {
    const result = parseUnityYaml(
      ['--- !u!1 &1', 'GameObject:', '  m_Name: "\\u666F\\u8272"'].join('\n')
    )
    assert.equal(scalar(prop(result.documents[0].properties, 'm_Name')), '景色')
  })

  it('detects a git-lfs pointer', () => {
    const result = parseUnityYaml(
      [
        'version https://git-lfs.github.com/spec/v1',
        'oid sha256:abc123',
        'size 12345',
      ].join('\n')
    )
    assert.equal(result.status, 'git-lfs-pointer')
    assert.equal(result.documents.length, 0)
  })

  it('reports invalid-yaml when no Unity headers are present', () => {
    const result = parseUnityYaml('just some text\nwith no headers\n')
    assert.equal(result.status, 'invalid-yaml')
    assert.equal(result.documents.length, 0)
  })

  it('parses multiple documents and records their text ranges', () => {
    const text = [
      '--- !u!1 &100',
      'GameObject:',
      '  m_Name: A',
      '--- !u!4 &200',
      'Transform:',
      '  m_GameObject: {fileID: 100}',
    ].join('\n')
    const result = parseUnityYaml(text)
    assert.equal(result.documents.length, 2)
    assert.equal(result.documents[0].rawTextRange.start, 0)
    assert.equal(
      result.documents[0].rawTextRange.end,
      result.documents[1].rawTextRange.start
    )
    assert.equal(result.documents[1].rawTextRange.end, text.length)
  })
  it('merges a flow mapping that Unity wrapped across two lines', () => {
    const result = parseUnityYaml(
      [
        '--- !u!1001 &1',
        'PrefabInstance:',
        '  m_Modification:',
        '    m_Modifications:',
        '    - target: {fileID: 5021052286390222091, guid: b28212317aad84e4392cbdb9f1452fbb,',
        '        type: 3}',
        '      propertyPath: m_SizeDelta.x',
        '      value: 100',
        '      objectReference: {fileID: 0}',
      ].join('\n')
    )
    const mod = prop(result.documents[0].properties, 'm_Modification')
    assert.ok(mod && mod.kind === 'map')
    const mods = prop(mod.entries, 'm_Modifications')
    assert.ok(mods && mods.kind === 'sequence')
    assert.equal(mods.items.length, 1)
    const item = mods.items[0]
    assert.ok(item.kind === 'map')
    const target = prop(item.entries, 'target')
    assert.ok(target && target.kind === 'reference')
    assert.equal(target.reference.fileId, '5021052286390222091')
    assert.equal(target.reference.guid, 'b28212317aad84e4392cbdb9f1452fbb')
    assert.equal(scalar(prop(item.entries, 'propertyPath')), 'm_SizeDelta.x')
  })
})

describe('normalizeFileId', () => {
  it('trims surrounding whitespace and preserves the sign', () => {
    assert.equal(normalizeFileId(' -42 '), '-42')
    assert.equal(normalizeFileId('9999999999999999999'), '9999999999999999999')
  })
})
