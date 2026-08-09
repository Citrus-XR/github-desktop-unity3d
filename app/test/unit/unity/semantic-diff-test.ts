import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import { buildHierarchy } from '../../../src/lib/unity/hierarchy-builder'
import {
  computeSemanticDiff,
  diffPropertySequence,
  diffProperties,
  valueEquals,
} from '../../../src/lib/unity/semantic-diff'
import { UnityPropertyValue } from '../../../src/models/unity/serialized-asset'

const side = (text: string) => {
  const { documents } = parseUnityYaml(text)
  return { documents, roots: buildHierarchy(documents) }
}

const before = side(
  [
    '--- !u!1 &100',
    'GameObject:',
    '  m_Name: Player',
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
    '  m_RotationSpeed: 30',
    '--- !u!1 &200',
    'GameObject:',
    '  m_Name: Cube',
    '  m_Component:',
    '  - component: {fileID: 201}',
    '--- !u!4 &201',
    'Transform:',
    '  m_GameObject: {fileID: 200}',
    '  m_Father: {fileID: 101}',
    '  m_Children: []',
  ].join('\n')
)

const after = side(
  [
    '--- !u!1 &100',
    'GameObject:',
    '  m_Name: Player',
    '  m_Component:',
    '  - component: {fileID: 101}',
    '  - component: {fileID: 102}',
    '--- !u!4 &101',
    'Transform:',
    '  m_GameObject: {fileID: 100}',
    '  m_Father: {fileID: 0}',
    '  m_Children:',
    '  - {fileID: 301}',
    '--- !u!114 &102',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 100}',
    '  m_RotationSpeed: 45',
    '--- !u!1 &300',
    'GameObject:',
    '  m_Name: Sphere',
    '  m_Component:',
    '  - component: {fileID: 301}',
    '--- !u!4 &301',
    'Transform:',
    '  m_GameObject: {fileID: 300}',
    '  m_Father: {fileID: 101}',
    '  m_Children: []',
  ].join('\n')
)

describe('computeSemanticDiff', () => {
  it('marks a GameObject modified when a component property changes', () => {
    const diff = computeSemanticDiff(before, after)
    assert.equal(diff.roots.length, 1)
    assert.equal(diff.roots[0].name, 'Player')
    assert.equal(diff.roots[0].status, 'modified')
  })

  it('reports added and removed children in the merged tree', () => {
    const diff = computeSemanticDiff(before, after)
    const children = diff.roots[0].children
    const sphere = children.find(c => c.name === 'Sphere')
    const cube = children.find(c => c.name === 'Cube')
    assert.equal(sphere?.status, 'added')
    assert.equal(cube?.status, 'removed')
  })

  it('produces a property diff with before and after values', () => {
    const diff = computeSemanticDiff(before, after)
    const monoBehaviour = diff.documents.find(d => d.fileId === '102')
    assert.equal(monoBehaviour?.status, 'modified')
    const speed = monoBehaviour?.properties.find(
      p => p.key === 'm_RotationSpeed'
    )
    assert.equal(speed?.status, 'modified')
    assert.ok(speed?.before?.kind === 'scalar' && speed.before.value === '30')
    assert.ok(speed?.after?.kind === 'scalar' && speed.after.value === '45')
  })

  it('treats an unchanged asset as having no modifications', () => {
    const diff = computeSemanticDiff(before, before)
    assert.equal(diff.roots[0].status, 'unchanged')
    assert.ok(diff.documents.every(d => d.status === 'unchanged'))
  })
})

describe('diffProperties', () => {
  it('classifies added, removed, modified, and unchanged', () => {
    const beforeProps = parseUnityYaml(
      ['--- !u!1 &1', 'X:', '  keep: 1', '  change: 2', '  gone: 3'].join('\n')
    ).documents[0].properties
    const afterProps = parseUnityYaml(
      ['--- !u!1 &1', 'X:', '  keep: 1', '  change: 9', '  fresh: 4'].join('\n')
    ).documents[0].properties

    const diffs = diffProperties(beforeProps, afterProps)
    const byKey = new Map(diffs.map(d => [d.key, d.status]))
    assert.equal(byKey.get('keep'), 'unchanged')
    assert.equal(byKey.get('change'), 'modified')
    assert.equal(byKey.get('gone'), 'removed')
    assert.equal(byKey.get('fresh'), 'added')
  })
})

const sequenceValue = (value: string): UnityPropertyValue => ({
  kind: 'scalar',
  value,
})

describe('diffPropertySequence', () => {
  it('同じ位置の置換を一つの modified 行にまとめる', () => {
    const rows = diffPropertySequence(
      [sequenceValue('before')],
      [sequenceValue('after')]
    )

    assert.deepEqual(rows, [
      {
        index: 0,
        before: sequenceValue('before'),
        after: sequenceValue('after'),
        status: 'modified',
      },
    ])
  })

  it('等しい要素の間にある挿入と削除を独立した行として保つ', () => {
    const inserted = diffPropertySequence(
      [sequenceValue('a'), sequenceValue('c')],
      [sequenceValue('a'), sequenceValue('b'), sequenceValue('c')]
    )
    const removed = diffPropertySequence(
      [sequenceValue('a'), sequenceValue('b'), sequenceValue('c')],
      [sequenceValue('a'), sequenceValue('c')]
    )

    assert.deepEqual(
      inserted.map(row => row.status),
      ['unchanged', 'added', 'unchanged']
    )
    assert.deepEqual(
      removed.map(row => row.status),
      ['unchanged', 'removed', 'unchanged']
    )
  })

  it('連続した複数要素の置換を位置ごとにまとめる', () => {
    const rows = diffPropertySequence(
      [sequenceValue('a'), sequenceValue('b')],
      [sequenceValue('c'), sequenceValue('d')]
    )

    assert.deepEqual(
      rows.map(row => row.status),
      ['modified', 'modified']
    )
    assert.deepEqual(
      rows.map(row => [row.index, row.before, row.after]),
      [
        [0, sequenceValue('a'), sequenceValue('c')],
        [1, sequenceValue('b'), sequenceValue('d')],
      ]
    )
  })
})

describe('valueEquals', () => {
  it('compares references by fileId, guid and type', () => {
    const a = {
      kind: 'reference' as const,
      reference: {
        fileId: '5',
        guid: 'g',
        referenceType: 2,
        propertyPath: 'p',
      },
    }
    const b = {
      kind: 'reference' as const,
      reference: {
        fileId: '5',
        guid: 'g',
        referenceType: 2,
        propertyPath: 'other',
      },
    }
    const c = {
      kind: 'reference' as const,
      reference: {
        fileId: '6',
        guid: 'g',
        referenceType: 2,
        propertyPath: 'p',
      },
    }
    assert.equal(valueEquals(a, b), true)
    assert.equal(valueEquals(a, c), false)
  })
})
