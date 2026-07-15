/**
 * Domain model for Unity's AnimatorController (`!u!91`) and its supporting
 * documents (state machines, states, transitions). Reshaped from the generic
 * property tree so the graph viewer never walks raw YAML at render time.
 *
 * Coordinates come straight from Unity's YAML (`m_Position`, `m_AnyStatePosition`,
 * etc.), so the layout on screen matches the Animator window one-for-one.
 */

import { UnityFileId } from './serialized-asset'

/** 1 = Float, 3 = Int, 4 = Bool, 9 = Trigger. */
export type UnityAnimParamType = 1 | 3 | 4 | 9

export interface IUnityAnimParameter {
  readonly name: string
  readonly type: UnityAnimParamType
  readonly defaultFloat: number
  readonly defaultInt: number
  readonly defaultBool: boolean
}

/**
 * Unity's `m_Conditions[]` entry. `mode` is the AnimatorConditionMode enum
 * (1 = If, 2 = IfNot, 3 = Greater, 4 = Less, 6 = Equals, 7 = NotEqual).
 * `parameter` is the source YAML field `m_ConditionEvent`. `threshold` is
 * `m_EventTreshold` (Unity's own typo, preserved in the file format).
 */
export interface IUnityAnimCondition {
  readonly mode: number
  readonly parameter: string
  readonly threshold: number
}

/** Which collection a transition was found on. */
export type UnityAnimTransitionKind =
  | 'state'      // AnimatorState.m_Transitions
  | 'anystate'   // AnimatorStateMachine.m_AnyStateTransitions
  | 'entry'      // AnimatorStateMachine.m_EntryTransitions
  | 'exit'       // an AnimatorStateTransition on a state whose m_IsExit = 1

export interface IUnityAnimTransition {
  readonly fileId: UnityFileId
  /** The AnimatorState (kind=state|exit) or AnimatorStateMachine (kind=anystate|entry) that owns it. */
  readonly ownerFileId: UnityFileId
  readonly kind: UnityAnimTransitionKind
  readonly dstStateFileId?: UnityFileId
  readonly dstStateMachineFileId?: UnityFileId
  readonly isExit: boolean
  readonly solo: boolean
  readonly mute: boolean
  readonly hasExitTime: boolean
  readonly exitTime: number
  readonly duration: number
  readonly offset: number
  readonly conditions: ReadonlyArray<IUnityAnimCondition>
}

export interface IUnityAnimPosition {
  readonly x: number
  readonly y: number
}

export interface IUnityAnimState {
  readonly fileId: UnityFileId
  readonly name: string
  /** Node coordinates from the parent state machine's `m_ChildStates[i].m_Position`. */
  readonly position: IUnityAnimPosition
  readonly speed: number
  readonly cycleOffset: number
  readonly writeDefaultValues: boolean
  readonly tag: string
  /** '0' when no motion is assigned. */
  readonly motionFileId: UnityFileId
  /** Set only when the motion is a cross-asset reference (AnimationClip / BlendTree in another file). */
  readonly motionGuid?: string
  readonly transitionFileIds: ReadonlyArray<UnityFileId>
  readonly behaviourFileIds: ReadonlyArray<UnityFileId>
}

export interface IUnityAnimChildStateMachineRef {
  readonly fileId: UnityFileId
  readonly position: IUnityAnimPosition
}

export interface IUnityAnimStateMachine {
  readonly fileId: UnityFileId
  readonly name: string
  readonly defaultStateFileId?: UnityFileId
  readonly anyStatePos: IUnityAnimPosition
  readonly entryPos: IUnityAnimPosition
  readonly exitPos: IUnityAnimPosition
  readonly parentPos: IUnityAnimPosition
  readonly stateFileIds: ReadonlyArray<UnityFileId>
  readonly childStateMachines: ReadonlyArray<IUnityAnimChildStateMachineRef>
  readonly anyStateTransitionFileIds: ReadonlyArray<UnityFileId>
  readonly entryTransitionFileIds: ReadonlyArray<UnityFileId>
}

export interface IUnityAnimLayer {
  readonly name: string
  readonly stateMachineFileId: UnityFileId
  readonly maskGuid?: string
  readonly blendingMode: number
  readonly defaultWeight: number
  readonly syncedLayerIndex: number
}

export interface IUnityAnimatorController {
  readonly fileId: UnityFileId
  readonly name: string
  readonly parameters: ReadonlyArray<IUnityAnimParameter>
  readonly layers: ReadonlyArray<IUnityAnimLayer>
  readonly stateMachines: ReadonlyMap<UnityFileId, IUnityAnimStateMachine>
  readonly states: ReadonlyMap<UnityFileId, IUnityAnimState>
  readonly transitions: ReadonlyMap<UnityFileId, IUnityAnimTransition>
}

// Diff types follow the AnimationClip pattern.

export type UnityAnimEntityStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'unchanged'

export interface IUnityAnimStateDiff {
  readonly fileId: UnityFileId
  readonly status: UnityAnimEntityStatus
  readonly before?: IUnityAnimState
  readonly after?: IUnityAnimState
}

export interface IUnityAnimTransitionDiff {
  readonly fileId: UnityFileId
  readonly status: UnityAnimEntityStatus
  readonly before?: IUnityAnimTransition
  readonly after?: IUnityAnimTransition
}

export interface IUnityAnimStateMachineDiff {
  readonly fileId: UnityFileId
  readonly status: UnityAnimEntityStatus
  readonly before?: IUnityAnimStateMachine
  readonly after?: IUnityAnimStateMachine
}

/** Layers are matched positionally so a rename at the same index is a modify, not a delete+add. */
export interface IUnityAnimLayerDiff {
  readonly index: number
  readonly status: UnityAnimEntityStatus
  readonly before?: IUnityAnimLayer
  readonly after?: IUnityAnimLayer
}

export interface IUnityAnimParamDiff {
  readonly name: string
  readonly status: UnityAnimEntityStatus
  readonly before?: IUnityAnimParameter
  readonly after?: IUnityAnimParameter
}

export interface IUnityAnimatorControllerDiff {
  readonly fileId: UnityFileId
  readonly status: UnityAnimEntityStatus
  readonly before?: IUnityAnimatorController
  readonly after?: IUnityAnimatorController
  readonly layers: ReadonlyArray<IUnityAnimLayerDiff>
  readonly parameters: ReadonlyArray<IUnityAnimParamDiff>
  readonly states: ReadonlyArray<IUnityAnimStateDiff>
  readonly transitions: ReadonlyArray<IUnityAnimTransitionDiff>
  readonly stateMachines: ReadonlyArray<IUnityAnimStateMachineDiff>
}
