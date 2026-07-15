import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import { diffAnimatorControllers } from '../../../src/lib/unity/animator-controller-diff'

// A tiny variant builder — mirrors the parser test's approach but tuned for
// diff scenarios (parameter add, layer rename, transition destination change,
// state motion swap).

const controllerYaml = (
  opts: {
    readonly stateAMotion?: string
    readonly transitionDst?: string
    readonly transitionDuration?: number
    readonly layerName?: string
    readonly params?: ReadonlyArray<{ readonly name: string; readonly type: number }>
    readonly stateBName?: string
    readonly conditions?: ReadonlyArray<{ readonly mode: number; readonly event: string }>
  } = {}
) => {
  const stateAMotion = opts.stateAMotion ?? '{fileID: 0}'
  const dst = opts.transitionDst ?? '{fileID: 202}'
  const duration = opts.transitionDuration ?? 0.25
  const layerName = opts.layerName ?? 'Base Layer'
  const params = opts.params ?? [{ name: 'Trigger1', type: 9 }]
  const stateBName = opts.stateBName ?? 'StateB'
  const conditions = opts.conditions ?? [{ mode: 1, event: 'Trigger1' }]

  const conditionsBlock = conditions
    .map(c =>
      [
        '  - m_ConditionMode: ' + c.mode,
        '    m_ConditionEvent: ' + c.event,
        '    m_EventTreshold: 0',
      ].join('\n')
    )
    .join('\n')

  const paramsBlock = params
    .map(p =>
      [
        `  - m_Name: ${p.name}`,
        `    m_Type: ${p.type}`,
        '    m_DefaultFloat: 0',
        '    m_DefaultInt: 0',
        '    m_DefaultBool: 0',
        '    m_Controller: {fileID: 9100000}',
      ].join('\n')
    )
    .join('\n')

  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!1102 &201',
    'AnimatorState:',
    '  serializedVersion: 6',
    '  m_Name: StateA',
    '  m_Speed: 1',
    '  m_CycleOffset: 0',
    '  m_Transitions:',
    '  - {fileID: 301}',
    '  m_StateMachineBehaviours: []',
    '  m_Position: {x: 50, y: 50, z: 0}',
    '  m_IKOnFeet: 0',
    '  m_WriteDefaultValues: 1',
    '  m_Mirror: 0',
    `  m_Motion: ${stateAMotion}`,
    '  m_Tag: ',
    '--- !u!1102 &202',
    'AnimatorState:',
    '  serializedVersion: 6',
    `  m_Name: ${stateBName}`,
    '  m_Speed: 1',
    '  m_CycleOffset: 0',
    '  m_Transitions: []',
    '  m_StateMachineBehaviours: []',
    '  m_Position: {x: 50, y: 50, z: 0}',
    '  m_IKOnFeet: 0',
    '  m_WriteDefaultValues: 1',
    '  m_Mirror: 0',
    '  m_Motion: {fileID: 0}',
    '  m_Tag: ',
    '--- !u!1101 &301',
    'AnimatorStateTransition:',
    '  m_Name: ',
    '  m_Conditions:',
    conditionsBlock,
    '  m_DstStateMachine: {fileID: 0}',
    `  m_DstState: ${dst}`,
    '  m_Solo: 0',
    '  m_Mute: 0',
    '  m_IsExit: 0',
    '  serializedVersion: 3',
    `  m_TransitionDuration: ${duration}`,
    '  m_TransitionOffset: 0',
    '  m_ExitTime: 0.75',
    '  m_HasExitTime: 0',
    '  m_HasFixedDuration: 1',
    '  m_InterruptionSource: 0',
    '  m_OrderedInterruption: 1',
    '  m_CanTransitionToSelf: 1',
    '--- !u!1107 &100',
    'AnimatorStateMachine:',
    '  serializedVersion: 6',
    '  m_Name: Base Layer',
    '  m_ChildStates:',
    '  - serializedVersion: 1',
    '    m_State: {fileID: 201}',
    '    m_Position: {x: 100, y: 100, z: 0}',
    '  - serializedVersion: 1',
    '    m_State: {fileID: 202}',
    '    m_Position: {x: 250, y: 200, z: 0}',
    '  m_ChildStateMachines: []',
    '  m_AnyStateTransitions: []',
    '  m_EntryTransitions: []',
    '  m_StateMachineTransitions: {}',
    '  m_StateMachineBehaviours: []',
    '  m_AnyStatePosition: {x: 50, y: 20, z: 0}',
    '  m_EntryPosition: {x: 50, y: 120, z: 0}',
    '  m_ExitPosition: {x: 800, y: 120, z: 0}',
    '  m_ParentStateMachinePosition: {x: 800, y: 20, z: 0}',
    '  m_DefaultState: {fileID: 201}',
    '--- !u!91 &9100000',
    'AnimatorController:',
    '  m_Name: Fixture',
    '  serializedVersion: 5',
    '  m_AnimatorParameters:',
    paramsBlock,
    '  m_AnimatorLayers:',
    '  - serializedVersion: 5',
    `    m_Name: ${layerName}`,
    '    m_StateMachine: {fileID: 100}',
    '    m_Mask: {fileID: 0}',
    '    m_Motions: []',
    '    m_Behaviours: []',
    '    m_BlendingMode: 0',
    '    m_SyncedLayerIndex: -1',
    '    m_DefaultWeight: 1',
    '    m_IKPass: 0',
    '    m_SyncedLayerAffectsTiming: 0',
    '    m_Controller: {fileID: 9100000}',
  ].join('\n')
}

describe('diffAnimatorControllers', () => {
  it('reports unchanged when both sides are identical', () => {
    const before = parseUnityYaml(controllerYaml()).documents
    const after = parseUnityYaml(controllerYaml()).documents
    const [diff] = diffAnimatorControllers(before, after)
    assert.equal(diff.status, 'unchanged')
    assert.ok(diff.states.every(s => s.status === 'unchanged'))
    assert.ok(diff.transitions.every(t => t.status === 'unchanged'))
  })

  it('flags a modified state when its motion changes', () => {
    const before = parseUnityYaml(controllerYaml()).documents
    const after = parseUnityYaml(
      controllerYaml({ stateAMotion: '{fileID: 7400000, guid: aaa, type: 2}' })
    ).documents
    const [diff] = diffAnimatorControllers(before, after)
    assert.equal(diff.status, 'modified')
    const stateA = diff.states.find(s => s.fileId === '201')!
    assert.equal(stateA.status, 'modified')
    assert.equal(stateA.after?.motionGuid, 'aaa')
  })

  it('flags a modified transition when its duration changes', () => {
    const before = parseUnityYaml(controllerYaml({ transitionDuration: 0.25 })).documents
    const after = parseUnityYaml(controllerYaml({ transitionDuration: 0.5 })).documents
    const [diff] = diffAnimatorControllers(before, after)
    const t = diff.transitions.find(t => t.fileId === '301')!
    assert.equal(t.status, 'modified')
  })

  it('flags a modified transition when conditions change', () => {
    const before = parseUnityYaml(controllerYaml()).documents
    const after = parseUnityYaml(
      controllerYaml({ conditions: [{ mode: 1, event: 'DifferentTrigger' }] })
    ).documents
    const [diff] = diffAnimatorControllers(before, after)
    const t = diff.transitions.find(t => t.fileId === '301')!
    assert.equal(t.status, 'modified')
  })

  it('records a parameter add', () => {
    const before = parseUnityYaml(controllerYaml()).documents
    const after = parseUnityYaml(
      controllerYaml({
        params: [
          { name: 'Trigger1', type: 9 },
          { name: 'Speed', type: 1 },
        ],
      })
    ).documents
    const [diff] = diffAnimatorControllers(before, after)
    const added = diff.parameters.find(p => p.name === 'Speed')!
    assert.equal(added.status, 'added')
    assert.equal(added.after?.type, 1)
  })

  it('detects a layer rename at the same index as a modify', () => {
    const before = parseUnityYaml(controllerYaml({ layerName: 'Old' })).documents
    const after = parseUnityYaml(controllerYaml({ layerName: 'New' })).documents
    const [diff] = diffAnimatorControllers(before, after)
    assert.equal(diff.layers.length, 1)
    assert.equal(diff.layers[0].status, 'modified')
    assert.equal(diff.layers[0].before?.name, 'Old')
    assert.equal(diff.layers[0].after?.name, 'New')
  })

  it('reports the controller as added when the before side is empty', () => {
    const after = parseUnityYaml(controllerYaml()).documents
    const [diff] = diffAnimatorControllers([], after)
    assert.equal(diff.status, 'added')
    assert.equal(diff.before, undefined)
    assert.equal(diff.after?.name, 'Fixture')
    assert.ok(diff.states.every(s => s.status === 'added'))
  })

  it('reports the controller as removed when the after side is empty', () => {
    const before = parseUnityYaml(controllerYaml()).documents
    const [diff] = diffAnimatorControllers(before, [])
    assert.equal(diff.status, 'removed')
    assert.ok(diff.states.every(s => s.status === 'removed'))
  })

  it('returns an empty list for non-controller documents', () => {
    const docs = parseUnityYaml(
      ['--- !u!1 &1', 'GameObject:', '  m_Name: Plain'].join('\n')
    ).documents
    assert.equal(diffAnimatorControllers(docs, docs).length, 0)
  })
})
