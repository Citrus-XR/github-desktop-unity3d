import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import {
  parseAnimationClips,
  ANIMATION_CLIP_CLASS_ID,
} from '../../../src/lib/unity/animation-clip'
import { IUnityAnimCurve } from '../../../src/models/unity/animation-clip'

const clip = (
  overrides: {
    readonly position?: string
    readonly float?: string
    readonly pptr?: string
    readonly settings?: string
  } = {}
) =>
  [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    `--- !u!${ANIMATION_CLIP_CLASS_ID} &7400000`,
    'AnimationClip:',
    '  m_ObjectHideFlags: 0',
    '  m_Name: Fixture',
    '  serializedVersion: 7',
    '  m_Legacy: 0',
    '  m_Compressed: 0',
    '  m_RotationCurves: []',
    '  m_CompressedRotationCurves: []',
    '  m_EulerCurves: []',
    overrides.position ?? '  m_PositionCurves: []',
    '  m_ScaleCurves: []',
    overrides.float ?? '  m_FloatCurves: []',
    overrides.pptr ?? '  m_PPtrCurves: []',
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
    overrides.settings ?? '    m_StopTime: 1',
    '    m_LoopTime: 0',
    '    m_HasAdditiveReferencePose: 0',
    '  m_EditorCurves: []',
    '  m_EulerEditorCurves: []',
  ].join('\n')

const positionCurve = (
  path: string,
  keys: ReadonlyArray<{
    readonly time: number
    readonly value: [number, number, number]
    readonly inSlope?: string
  }>
): string => {
  const inner = keys
    .flatMap(k => [
      '      - serializedVersion: 3',
      `        time: ${k.time}`,
      `        value: {x: ${k.value[0]}, y: ${k.value[1]}, z: ${k.value[2]}}`,
      `        inSlope: {x: ${k.inSlope ?? 0}, y: 0, z: 0}`,
      '        outSlope: {x: 0, y: 0, z: 0}',
      '        tangentMode: 0',
      '        weightedMode: 0',
      '        inWeight: {x: 0.33, y: 0.33, z: 0.33}',
      '        outWeight: {x: 0.33, y: 0.33, z: 0.33}',
    ])
    .join('\n')
  return [
    '  m_PositionCurves:',
    '  - curve:',
    '      serializedVersion: 2',
    '      m_Curve:',
    inner,
    '      m_PreInfinity: 2',
    '      m_PostInfinity: 2',
    '      m_RotationOrder: 4',
    `    path: ${path}`,
  ].join('\n')
}

const floatCurve = (
  path: string,
  attribute: string,
  keys: ReadonlyArray<{ readonly time: number; readonly value: number | string; readonly inSlope?: string }>
): string => {
  const inner = keys
    .flatMap(k => [
      '      - serializedVersion: 3',
      `        time: ${k.time}`,
      `        value: ${k.value}`,
      `        inSlope: ${k.inSlope ?? 0}`,
      '        outSlope: 0',
      '        tangentMode: 0',
      '        weightedMode: 0',
      '        inWeight: 0',
      '        outWeight: 0',
    ])
    .join('\n')
  return [
    '  m_FloatCurves:',
    '  - serializedVersion: 2',
    '    curve:',
    '      serializedVersion: 2',
    '      m_Curve:',
    inner,
    '      m_PreInfinity: 2',
    '      m_PostInfinity: 2',
    '      m_RotationOrder: 4',
    `    attribute: ${attribute}`,
    `    path: ${path}`,
    '    classID: 1',
    '    script: {fileID: 0}',
    '    flags: 0',
  ].join('\n')
}

describe('parseAnimationClip', () => {
  it('parses metadata and empty curve buckets', () => {
    const docs = parseUnityYaml(clip()).documents
    const clips = parseAnimationClips(docs)
    assert.equal(clips.length, 1)
    const c = clips[0]
    assert.equal(c.name, 'Fixture')
    assert.equal(c.fileId, '7400000')
    assert.equal(c.sampleRate, 60)
    assert.equal(c.stopTime, 1)
    assert.equal(c.loopTime, false)
    assert.equal(c.legacy, false)
    assert.equal(c.curves.length, 0)
  })

  it('splits a Vector3 position curve into per-axis channels', () => {
    const docs = parseUnityYaml(
      clip({
        position: positionCurve('Rig/Head', [
          { time: 0, value: [1, 2, 3] },
          { time: 0.5, value: [4, 5, 6] },
        ]),
      })
    ).documents
    const c = parseAnimationClips(docs)[0]
    const byChannel = new Map<string, IUnityAnimCurve>()
    for (const cu of c.curves) {
      if (cu.channel !== undefined) {
        byChannel.set(cu.channel, cu)
      }
    }
    assert.deepEqual([...byChannel.keys()].sort(), ['x', 'y', 'z'])
    const x = byChannel.get('x')!
    assert.equal(x.kind, 'position')
    assert.equal(x.path, 'Rig/Head')
    assert.equal(x.attribute, 'm_LocalPosition')
    assert.equal(x.keys.length, 2)
    assert.equal(x.keys[0].value, 1)
    assert.equal(x.keys[1].value, 4)
    assert.equal(byChannel.get('y')!.keys[1].value, 5)
    assert.equal(byChannel.get('z')!.keys[0].value, 3)
  })

  it('tags Infinity as a non-finite slope', () => {
    const docs = parseUnityYaml(
      clip({
        float: floatCurve('Root', 'm_IsActive', [
          { time: 0, value: 1, inSlope: 'Infinity' },
          { time: 0.5, value: 0 },
        ]),
      })
    ).documents
    const c = parseAnimationClips(docs)[0]
    assert.equal(c.curves.length, 1)
    assert.equal(c.curves[0].keys[0].inSlope, 'inf')
    assert.equal(c.curves[0].keys[1].inSlope, 0)
  })

  it('carries classID and attribute for float curves', () => {
    const docs = parseUnityYaml(
      clip({
        float: floatCurve('Rig/Panel', 'm_IsActive', [
          { time: 0, value: 1 },
        ]),
      })
    ).documents
    const c = parseAnimationClips(docs)[0]
    assert.equal(c.curves[0].kind, 'float')
    assert.equal(c.curves[0].classID, 1)
    assert.equal(c.curves[0].attribute, 'm_IsActive')
    assert.equal(c.curves[0].path, 'Rig/Panel')
  })
})
