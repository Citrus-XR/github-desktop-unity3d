import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import { diffAnimationClips } from '../../../src/lib/unity/animation-clip-diff'

const clipWithFloat = (
  keys: ReadonlyArray<{ readonly time: number; readonly value: number }>,
  opts: { readonly stopTime?: number } = {}
) => {
  const inner = keys
    .flatMap(k => [
      '      - serializedVersion: 3',
      `        time: ${k.time}`,
      `        value: ${k.value}`,
      '        inSlope: 0',
      '        outSlope: 0',
      '        tangentMode: 0',
      '        weightedMode: 0',
      '        inWeight: 0',
      '        outWeight: 0',
    ])
    .join('\n')
  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!74 &7400000',
    'AnimationClip:',
    '  m_ObjectHideFlags: 0',
    '  m_Name: DiffFixture',
    '  serializedVersion: 7',
    '  m_Legacy: 0',
    '  m_Compressed: 0',
    '  m_RotationCurves: []',
    '  m_CompressedRotationCurves: []',
    '  m_EulerCurves: []',
    '  m_PositionCurves: []',
    '  m_ScaleCurves: []',
    '  m_FloatCurves:',
    '  - serializedVersion: 2',
    '    curve:',
    '      serializedVersion: 2',
    '      m_Curve:',
    inner,
    '      m_PreInfinity: 2',
    '      m_PostInfinity: 2',
    '      m_RotationOrder: 4',
    '    attribute: m_IsActive',
    '    path: Panel',
    '    classID: 1',
    '    script: {fileID: 0}',
    '    flags: 0',
    '  m_PPtrCurves: []',
    '  m_SampleRate: 60',
    '  m_WrapMode: 0',
    '  m_Bounds:',
    '    m_Center: {x: 0, y: 0, z: 0}',
    '    m_Extent: {x: 0, y: 0, z: 0}',
    '  m_ClipBindingConstant:',
    '    genericBindings: []',
    '    pptrCurveMapping: []',
    '  m_AnimationClipSettings:',
    '    serializedVersion: 2',
    '    m_StartTime: 0',
    `    m_StopTime: ${opts.stopTime ?? 1}`,
    '    m_LoopTime: 0',
    '  m_EditorCurves: []',
    '  m_EulerEditorCurves: []',
  ].join('\n')
}

describe('diffAnimationClips', () => {
  it('reports an unchanged clip when both sides are identical', () => {
    const source = clipWithFloat([
      { time: 0, value: 1 },
      { time: 0.5, value: 0 },
    ])
    const before = parseUnityYaml(source).documents
    const after = parseUnityYaml(source).documents
    const [diff] = diffAnimationClips(before, after)
    assert.equal(diff.status, 'unchanged')
    assert.equal(diff.curves[0].status, 'unchanged')
    for (const k of diff.curves[0].keyDiffs) {
      assert.equal(k.status, 'unchanged')
    }
  })

  it('flags a modified keyframe with a value delta', () => {
    const before = parseUnityYaml(
      clipWithFloat([
        { time: 0, value: 1 },
        { time: 0.5, value: 0 },
      ])
    ).documents
    const after = parseUnityYaml(
      clipWithFloat([
        { time: 0, value: 1 },
        { time: 0.5, value: 1 },
      ])
    ).documents
    const [diff] = diffAnimationClips(before, after)
    assert.equal(diff.status, 'modified')
    const curve = diff.curves[0]
    assert.equal(curve.status, 'modified')
    assert.equal(curve.keyDiffs.length, 2)
    assert.equal(curve.keyDiffs[0].status, 'unchanged')
    assert.equal(curve.keyDiffs[1].status, 'modified')
    assert.equal(curve.keyDiffs[1].valueDelta, 1)
  })

  it('detects an added keyframe inserted between existing keys', () => {
    const before = parseUnityYaml(
      clipWithFloat([
        { time: 0, value: 1 },
        { time: 1, value: 0 },
      ])
    ).documents
    const after = parseUnityYaml(
      clipWithFloat([
        { time: 0, value: 1 },
        { time: 0.5, value: 0.5 },
        { time: 1, value: 0 },
      ])
    ).documents
    const curve = diffAnimationClips(before, after)[0].curves[0]
    const added = curve.keyDiffs.find(k => k.status === 'added')
    assert.ok(added !== undefined, 'expected an added key')
    assert.equal(added?.afterIndex, 1)
    // The surrounding keys should still be matched (unchanged), not shifted.
    const unchanged = curve.keyDiffs.filter(k => k.status === 'unchanged')
    assert.equal(unchanged.length, 2)
  })

  it('detects a removed keyframe', () => {
    const before = parseUnityYaml(
      clipWithFloat([
        { time: 0, value: 1 },
        { time: 0.25, value: 0.5 },
        { time: 0.5, value: 0 },
      ])
    ).documents
    const after = parseUnityYaml(
      clipWithFloat([
        { time: 0, value: 1 },
        { time: 0.5, value: 0 },
      ])
    ).documents
    const removed = diffAnimationClips(before, after)[0].curves[0].keyDiffs.find(
      k => k.status === 'removed'
    )
    assert.ok(removed !== undefined, 'expected a removed key')
    assert.equal(removed?.beforeIndex, 1)
  })

  it('records a header change when stopTime shifts', () => {
    const before = parseUnityYaml(clipWithFloat([{ time: 0, value: 1 }])).documents
    const after = parseUnityYaml(
      clipWithFloat([{ time: 0, value: 1 }], { stopTime: 2 })
    ).documents
    const [diff] = diffAnimationClips(before, after)
    assert.equal(diff.status, 'modified')
    assert.deepEqual(diff.headerChanges, ['stopTime'])
  })

  it('reports the clip as added when the before side is empty', () => {
    const after = parseUnityYaml(clipWithFloat([{ time: 0, value: 1 }])).documents
    const [diff] = diffAnimationClips([], after)
    assert.equal(diff.status, 'added')
    assert.equal(diff.before, undefined)
    assert.equal(diff.after?.name, 'DiffFixture')
    assert.equal(diff.curves[0].status, 'added')
    assert.equal(diff.curves[0].keyDiffs.length, 1)
    assert.equal(diff.curves[0].keyDiffs[0].status, 'added')
  })

  it('reports the clip as removed when the after side is empty', () => {
    const before = parseUnityYaml(clipWithFloat([{ time: 0, value: 1 }])).documents
    const [diff] = diffAnimationClips(before, [])
    assert.equal(diff.status, 'removed')
    assert.equal(diff.curves[0].status, 'removed')
  })

  it('ignores non-AnimationClip documents', () => {
    const docs = parseUnityYaml(
      ['--- !u!1 &1', 'GameObject:', '  m_Name: Plain'].join('\n')
    ).documents
    assert.equal(diffAnimationClips(docs, docs).length, 0)
  })
})
