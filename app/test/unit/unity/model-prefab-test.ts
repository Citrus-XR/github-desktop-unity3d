import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  buildModelDocuments,
  isModelPath,
  parseModelNameTable,
} from '../../../src/lib/unity/model-prefab'

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
    assert.deepEqual(objects[1], { classId: 4, fileId: '400002', name: '//RootNode' })
  })
})

describe('buildModelDocuments', () => {
  it('reconstructs named GameObject/Transform pairs under the root', () => {
    const docs = buildModelDocuments(parseModelNameTable(metaTable), 'Clock')
    // Two transforms (400002 root, 400004) → 4 docs (GO + Transform each).
    const rootGo = docs.find(d => d.fileId === '100002')
    assert.ok(rootGo && rootGo.classId === 1)
    assert.equal(
      rootGo.properties.find(p => p.key === 'm_Name')?.value.kind === 'scalar' &&
        (rootGo.properties.find(p => p.key === 'm_Name')!.value as any).value,
      'Clock'
    )

    const handTransform = docs.find(d => d.fileId === '400004')
    assert.ok(handTransform && handTransform.classId === 4)
    const father = handTransform.properties.find(p => p.key === 'm_Father')?.value
    assert.ok(father && father.kind === 'reference' && father.reference.fileId === '400002')

    const handGo = docs.find(d => d.fileId === '100004')
    assert.equal(
      handGo?.properties.find(p => p.key === 'm_Name')?.value.kind === 'scalar' &&
        (handGo!.properties.find(p => p.key === 'm_Name')!.value as any).value,
      'HourHand'
    )
  })
})
