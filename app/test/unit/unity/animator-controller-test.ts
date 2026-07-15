import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import {
  parseAnimatorController,
  ANIMATOR_CONTROLLER_CLASS_ID,
} from '../../../src/lib/unity/animator-controller'

// A minimal but realistic AnimatorController: one layer, one state machine,
// two states with a transition, one parameter. Positions are baked in so the
// parser can verify them. All fileIds are small distinct numbers so a test
// can eyeball who's who.

const controllerYaml = (
  opts: {
    readonly stateAMotion?: string
    readonly transitionCondition?: string
    readonly parameterName?: string
    readonly stateAPosition?: string
    readonly withChildSM?: boolean
    readonly withAnyStateTransition?: boolean
  } = {}
) => {
  const stateAMotion = opts.stateAMotion ?? '{fileID: 0}'
  const condition = opts.transitionCondition ?? 'Trigger1'
  const paramName = opts.parameterName ?? 'Trigger1'
  const stateAPos = opts.stateAPosition ?? '{x: 100, y: 100, z: 0}'

  const anyState = opts.withAnyStateTransition
    ? [
        '--- !u!1101 &400',
        'AnimatorStateTransition:',
        '  m_ObjectHideFlags: 1',
        '  m_Name: ',
        '  m_Conditions: []',
        '  m_DstStateMachine: {fileID: 0}',
        '  m_DstState: {fileID: 202}',
        '  m_Solo: 0',
        '  m_Mute: 0',
        '  m_IsExit: 0',
        '  serializedVersion: 3',
        '  m_TransitionDuration: 0',
        '  m_TransitionOffset: 0',
        '  m_ExitTime: 0',
        '  m_HasExitTime: 0',
        '  m_HasFixedDuration: 1',
        '  m_InterruptionSource: 0',
        '  m_OrderedInterruption: 1',
        '  m_CanTransitionToSelf: 1',
      ].join('\n')
    : ''

  const childSMBlock = opts.withChildSM
    ? [
        '  - serializedVersion: 1',
        '    m_StateMachine: {fileID: 500}',
        '    m_Position: {x: 250, y: 50, z: 0}',
      ].join('\n')
    : ''

  const childSMDoc = opts.withChildSM
    ? [
        '--- !u!1107 &500',
        'AnimatorStateMachine:',
        '  serializedVersion: 6',
        '  m_ObjectHideFlags: 1',
        '  m_Name: SubStateMachine',
        '  m_ChildStates: []',
        '  m_ChildStateMachines: []',
        '  m_AnyStateTransitions: []',
        '  m_EntryTransitions: []',
        '  m_StateMachineTransitions: {}',
        '  m_StateMachineBehaviours: []',
        '  m_AnyStatePosition: {x: 50, y: 20, z: 0}',
        '  m_EntryPosition: {x: 50, y: 120, z: 0}',
        '  m_ExitPosition: {x: 800, y: 120, z: 0}',
        '  m_ParentStateMachinePosition: {x: 800, y: 20, z: 0}',
        '  m_DefaultState: {fileID: 0}',
      ].join('\n')
    : ''

  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!1102 &201',
    'AnimatorState:',
    '  serializedVersion: 6',
    '  m_ObjectHideFlags: 1',
    '  m_Name: StateA',
    '  m_Speed: 1',
    '  m_CycleOffset: 0',
    '  m_Transitions:',
    '  - {fileID: 301}',
    '  m_StateMachineBehaviours: []',
    '  m_Position: {x: 50, y: 50, z: 0}',
    '  m_IKOnFeet: 0',
    '  m_WriteDefaultValues: 0',
    '  m_Mirror: 0',
    `  m_Motion: ${stateAMotion}`,
    '  m_Tag: ',
    '--- !u!1102 &202',
    'AnimatorState:',
    '  serializedVersion: 6',
    '  m_ObjectHideFlags: 1',
    '  m_Name: StateB',
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
    '  m_ObjectHideFlags: 1',
    '  m_Name: ',
    '  m_Conditions:',
    '  - m_ConditionMode: 1',
    `    m_ConditionEvent: ${condition}`,
    '    m_EventTreshold: 0',
    '  m_DstStateMachine: {fileID: 0}',
    '  m_DstState: {fileID: 202}',
    '  m_Solo: 0',
    '  m_Mute: 0',
    '  m_IsExit: 0',
    '  serializedVersion: 3',
    '  m_TransitionDuration: 0.25',
    '  m_TransitionOffset: 0',
    '  m_ExitTime: 0.75',
    '  m_HasExitTime: 0',
    '  m_HasFixedDuration: 1',
    '  m_InterruptionSource: 0',
    '  m_OrderedInterruption: 1',
    '  m_CanTransitionToSelf: 1',
    anyState,
    `--- !u!1107 &100`,
    'AnimatorStateMachine:',
    '  serializedVersion: 6',
    '  m_ObjectHideFlags: 1',
    '  m_Name: Base Layer',
    '  m_ChildStates:',
    '  - serializedVersion: 1',
    '    m_State: {fileID: 201}',
    `    m_Position: ${stateAPos}`,
    '  - serializedVersion: 1',
    '    m_State: {fileID: 202}',
    '    m_Position: {x: 250, y: 200, z: 0}',
    '  m_ChildStateMachines:',
    childSMBlock,
    '  m_AnyStateTransitions:' + (opts.withAnyStateTransition ? '\n  - {fileID: 400}' : ' []'),
    '  m_EntryTransitions: []',
    '  m_StateMachineTransitions: {}',
    '  m_StateMachineBehaviours: []',
    '  m_AnyStatePosition: {x: 50, y: 20, z: 0}',
    '  m_EntryPosition: {x: 50, y: 120, z: 0}',
    '  m_ExitPosition: {x: 800, y: 120, z: 0}',
    '  m_ParentStateMachinePosition: {x: 800, y: 20, z: 0}',
    '  m_DefaultState: {fileID: 201}',
    childSMDoc,
    `--- !u!${ANIMATOR_CONTROLLER_CLASS_ID} &9100000`,
    'AnimatorController:',
    '  m_ObjectHideFlags: 0',
    '  m_Name: Fixture',
    '  serializedVersion: 5',
    '  m_AnimatorParameters:',
    `  - m_Name: ${paramName}`,
    '    m_Type: 9',
    '    m_DefaultFloat: 0',
    '    m_DefaultInt: 0',
    '    m_DefaultBool: 0',
    '    m_Controller: {fileID: 9100000}',
    '  m_AnimatorLayers:',
    '  - serializedVersion: 5',
    '    m_Name: Base Layer',
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
  ]
    .filter(line => line !== '')
    .join('\n')
}

describe('parseAnimatorController', () => {
  it('parses layers, parameters, and top-level fields', () => {
    const docs = parseUnityYaml(controllerYaml()).documents
    const controller = parseAnimatorController(docs)
    assert.ok(controller !== undefined)
    assert.equal(controller!.name, 'Fixture')
    assert.equal(controller!.layers.length, 1)
    assert.equal(controller!.layers[0].name, 'Base Layer')
    assert.equal(controller!.layers[0].stateMachineFileId, '100')
    assert.equal(controller!.parameters.length, 1)
    assert.equal(controller!.parameters[0].name, 'Trigger1')
    assert.equal(controller!.parameters[0].type, 9)
  })

  it('hydrates state nodes with position from the parent state machine', () => {
    const docs = parseUnityYaml(controllerYaml()).documents
    const controller = parseAnimatorController(docs)!
    const stateA = controller.states.get('201')
    assert.ok(stateA !== undefined)
    assert.equal(stateA!.name, 'StateA')
    assert.equal(stateA!.position.x, 100)
    assert.equal(stateA!.position.y, 100)
    assert.equal(stateA!.writeDefaultValues, false)
    const stateB = controller.states.get('202')!
    assert.equal(stateB.position.x, 250)
    assert.equal(stateB.position.y, 200)
    assert.equal(stateB.writeDefaultValues, true)
  })

  it('preserves cross-file motion GUID on states', () => {
    const docs = parseUnityYaml(
      controllerYaml({ stateAMotion: '{fileID: 7400000, guid: deadbeef, type: 2}' })
    ).documents
    const controller = parseAnimatorController(docs)!
    const stateA = controller.states.get('201')!
    assert.equal(stateA.motionFileId, '7400000')
    assert.equal(stateA.motionGuid, 'deadbeef')
  })

  it('derives transition ownership from state and state-machine transition lists', () => {
    const docs = parseUnityYaml(controllerYaml({ withAnyStateTransition: true })).documents
    const controller = parseAnimatorController(docs)!
    const t301 = controller.transitions.get('301')!
    assert.equal(t301.kind, 'state')
    assert.equal(t301.ownerFileId, '201')
    assert.equal(t301.dstStateFileId, '202')
    assert.equal(t301.duration, 0.25)
    const t400 = controller.transitions.get('400')!
    assert.equal(t400.kind, 'anystate')
    assert.equal(t400.ownerFileId, '100')
  })

  it('links sub-state-machines from their parent SM', () => {
    const docs = parseUnityYaml(controllerYaml({ withChildSM: true })).documents
    const controller = parseAnimatorController(docs)!
    const base = controller.stateMachines.get('100')!
    assert.equal(base.childStateMachines.length, 1)
    assert.equal(base.childStateMachines[0].fileId, '500')
    assert.equal(base.childStateMachines[0].position.x, 250)
    // The child SM is also indexed on its own.
    const sub = controller.stateMachines.get('500')!
    assert.equal(sub.name, 'SubStateMachine')
  })

  it('parses conditions with mode / parameter / threshold', () => {
    const docs = parseUnityYaml(controllerYaml()).documents
    const controller = parseAnimatorController(docs)!
    const t = controller.transitions.get('301')!
    assert.equal(t.conditions.length, 1)
    assert.equal(t.conditions[0].mode, 1)
    assert.equal(t.conditions[0].parameter, 'Trigger1')
    assert.equal(t.conditions[0].threshold, 0)
  })

  it('returns undefined for a document list without an AnimatorController', () => {
    const docs = parseUnityYaml(
      ['--- !u!1 &1', 'GameObject:', '  m_Name: Plain'].join('\n')
    ).documents
    assert.equal(parseAnimatorController(docs), undefined)
  })
})
