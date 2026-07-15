/**
 * Two-sided AnimatorController diff. Matches controllers by fileId; layers
 * positionally so a rename at the same index reads as a modify, not a
 * delete+add; parameters by name; states / transitions / state-machines by
 * fileId (all Unity-assigned and stable across saves).
 */

import { IUnitySerializedDocument } from '../../models/unity/serialized-asset'
import {
  IUnityAnimatorController,
  IUnityAnimatorControllerDiff,
  IUnityAnimCondition,
  IUnityAnimLayer,
  IUnityAnimLayerDiff,
  IUnityAnimParameter,
  IUnityAnimParamDiff,
  IUnityAnimPosition,
  IUnityAnimState,
  IUnityAnimStateDiff,
  IUnityAnimStateMachine,
  IUnityAnimStateMachineDiff,
  IUnityAnimTransition,
  IUnityAnimTransitionDiff,
  UnityAnimEntityStatus,
} from '../../models/unity/animator-controller'
import { parseAnimatorController } from './animator-controller'

const EPS = 1e-6

const numbersEqual = (a: number, b: number): boolean =>
  Math.abs(a - b) <= EPS

const positionsEqual = (a: IUnityAnimPosition, b: IUnityAnimPosition): boolean =>
  numbersEqual(a.x, b.x) && numbersEqual(a.y, b.y)

const arraysEqual = <T>(
  a: ReadonlyArray<T>,
  b: ReadonlyArray<T>,
  eq: (x: T, y: T) => boolean = (x, y) => x === y
): boolean => {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i], b[i])) {
      return false
    }
  }
  return true
}

const conditionsEqual = (a: IUnityAnimCondition, b: IUnityAnimCondition): boolean =>
  a.mode === b.mode && a.parameter === b.parameter && numbersEqual(a.threshold, b.threshold)

const parameterEqual = (a: IUnityAnimParameter, b: IUnityAnimParameter): boolean =>
  a.name === b.name &&
  a.type === b.type &&
  numbersEqual(a.defaultFloat, b.defaultFloat) &&
  a.defaultInt === b.defaultInt &&
  a.defaultBool === b.defaultBool

const layerEqual = (a: IUnityAnimLayer, b: IUnityAnimLayer): boolean =>
  a.name === b.name &&
  a.stateMachineFileId === b.stateMachineFileId &&
  (a.maskGuid ?? '') === (b.maskGuid ?? '') &&
  a.blendingMode === b.blendingMode &&
  numbersEqual(a.defaultWeight, b.defaultWeight) &&
  a.syncedLayerIndex === b.syncedLayerIndex

const stateEqual = (a: IUnityAnimState, b: IUnityAnimState): boolean =>
  a.name === b.name &&
  positionsEqual(a.position, b.position) &&
  numbersEqual(a.speed, b.speed) &&
  numbersEqual(a.cycleOffset, b.cycleOffset) &&
  a.writeDefaultValues === b.writeDefaultValues &&
  a.tag === b.tag &&
  a.motionFileId === b.motionFileId &&
  (a.motionGuid ?? '') === (b.motionGuid ?? '') &&
  arraysEqual(a.transitionFileIds, b.transitionFileIds) &&
  arraysEqual(a.behaviourFileIds, b.behaviourFileIds)

const transitionEqual = (a: IUnityAnimTransition, b: IUnityAnimTransition): boolean =>
  a.ownerFileId === b.ownerFileId &&
  a.kind === b.kind &&
  (a.dstStateFileId ?? '') === (b.dstStateFileId ?? '') &&
  (a.dstStateMachineFileId ?? '') === (b.dstStateMachineFileId ?? '') &&
  a.isExit === b.isExit &&
  a.solo === b.solo &&
  a.mute === b.mute &&
  a.hasExitTime === b.hasExitTime &&
  numbersEqual(a.exitTime, b.exitTime) &&
  numbersEqual(a.duration, b.duration) &&
  numbersEqual(a.offset, b.offset) &&
  arraysEqual(a.conditions, b.conditions, conditionsEqual)

const stateMachineEqual = (
  a: IUnityAnimStateMachine,
  b: IUnityAnimStateMachine
): boolean =>
  a.name === b.name &&
  (a.defaultStateFileId ?? '0') === (b.defaultStateFileId ?? '0') &&
  positionsEqual(a.anyStatePos, b.anyStatePos) &&
  positionsEqual(a.entryPos, b.entryPos) &&
  positionsEqual(a.exitPos, b.exitPos) &&
  positionsEqual(a.parentPos, b.parentPos) &&
  arraysEqual(a.stateFileIds, b.stateFileIds) &&
  arraysEqual(
    a.childStateMachines,
    b.childStateMachines,
    (x, y) => x.fileId === y.fileId && positionsEqual(x.position, y.position)
  ) &&
  arraysEqual(a.anyStateTransitionFileIds, b.anyStateTransitionFileIds) &&
  arraysEqual(a.entryTransitionFileIds, b.entryTransitionFileIds)

const diffLayers = (
  before: ReadonlyArray<IUnityAnimLayer>,
  after: ReadonlyArray<IUnityAnimLayer>
): ReadonlyArray<IUnityAnimLayerDiff> => {
  const max = Math.max(before.length, after.length)
  const out: IUnityAnimLayerDiff[] = []
  for (let i = 0; i < max; i++) {
    const b = before[i]
    const a = after[i]
    if (b !== undefined && a !== undefined) {
      out.push({
        index: i,
        status: layerEqual(b, a) ? 'unchanged' : 'modified',
        before: b,
        after: a,
      })
    } else if (a !== undefined) {
      out.push({ index: i, status: 'added', after: a })
    } else if (b !== undefined) {
      out.push({ index: i, status: 'removed', before: b })
    }
  }
  return out
}

const diffParameters = (
  before: ReadonlyArray<IUnityAnimParameter>,
  after: ReadonlyArray<IUnityAnimParameter>
): ReadonlyArray<IUnityAnimParamDiff> => {
  const byNameBefore = new Map<string, IUnityAnimParameter>()
  for (const p of before) byNameBefore.set(p.name, p)
  const byNameAfter = new Map<string, IUnityAnimParameter>()
  for (const p of after) byNameAfter.set(p.name, p)
  const seen = new Set<string>()
  const out: IUnityAnimParamDiff[] = []
  const push = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    const b = byNameBefore.get(name)
    const a = byNameAfter.get(name)
    if (b !== undefined && a !== undefined) {
      out.push({
        name,
        status: parameterEqual(b, a) ? 'unchanged' : 'modified',
        before: b,
        after: a,
      })
    } else if (a !== undefined) {
      out.push({ name, status: 'added', after: a })
    } else if (b !== undefined) {
      out.push({ name, status: 'removed', before: b })
    }
  }
  for (const p of after) push(p.name)
  for (const p of before) push(p.name)
  return out
}

interface IByFileId<TDiff> {
  readonly diffs: ReadonlyArray<TDiff>
  readonly anyChanged: boolean
}

const diffByFileId = <TDomain, TDiff extends { readonly status: UnityAnimEntityStatus }>(
  before: ReadonlyMap<string, TDomain>,
  after: ReadonlyMap<string, TDomain>,
  eq: (a: TDomain, b: TDomain) => boolean,
  make: (
    fileId: string,
    status: UnityAnimEntityStatus,
    before: TDomain | undefined,
    after: TDomain | undefined
  ) => TDiff
): IByFileId<TDiff> => {
  const seen = new Set<string>()
  const diffs: TDiff[] = []
  let anyChanged = false
  const push = (fileId: string) => {
    if (seen.has(fileId)) return
    seen.add(fileId)
    const b = before.get(fileId)
    const a = after.get(fileId)
    let status: UnityAnimEntityStatus
    if (b !== undefined && a !== undefined) {
      status = eq(b, a) ? 'unchanged' : 'modified'
    } else if (a !== undefined) {
      status = 'added'
    } else {
      status = 'removed'
    }
    if (status !== 'unchanged') {
      anyChanged = true
    }
    diffs.push(make(fileId, status, b, a))
  }
  for (const id of after.keys()) push(id)
  for (const id of before.keys()) push(id)
  return { diffs, anyChanged }
}

const emptyController = (): IUnityAnimatorController | undefined => undefined

const controllerStatus = (
  before: IUnityAnimatorController | undefined,
  after: IUnityAnimatorController | undefined,
  layers: ReadonlyArray<IUnityAnimLayerDiff>,
  parameters: ReadonlyArray<IUnityAnimParamDiff>,
  anyStateChanged: boolean,
  anyTransitionChanged: boolean,
  anySMChanged: boolean
): UnityAnimEntityStatus => {
  if (before === undefined) return 'added'
  if (after === undefined) return 'removed'
  const layersChanged = layers.some(l => l.status !== 'unchanged')
  const paramsChanged = parameters.some(p => p.status !== 'unchanged')
  return layersChanged || paramsChanged || anyStateChanged || anyTransitionChanged || anySMChanged
    ? 'modified'
    : 'unchanged'
}

const diffOneController = (
  fileId: string,
  before: IUnityAnimatorController | undefined,
  after: IUnityAnimatorController | undefined
): IUnityAnimatorControllerDiff => {
  const b = before
  const a = after
  const layers = diffLayers(b?.layers ?? [], a?.layers ?? [])
  const parameters = diffParameters(b?.parameters ?? [], a?.parameters ?? [])
  const states = diffByFileId<IUnityAnimState, IUnityAnimStateDiff>(
    b?.states ?? new Map(),
    a?.states ?? new Map(),
    stateEqual,
    (fid, status, bef, aft) => ({ fileId: fid, status, before: bef, after: aft })
  )
  const transitions = diffByFileId<IUnityAnimTransition, IUnityAnimTransitionDiff>(
    b?.transitions ?? new Map(),
    a?.transitions ?? new Map(),
    transitionEqual,
    (fid, status, bef, aft) => ({ fileId: fid, status, before: bef, after: aft })
  )
  const stateMachines = diffByFileId<IUnityAnimStateMachine, IUnityAnimStateMachineDiff>(
    b?.stateMachines ?? new Map(),
    a?.stateMachines ?? new Map(),
    stateMachineEqual,
    (fid, status, bef, aft) => ({ fileId: fid, status, before: bef, after: aft })
  )
  return {
    fileId,
    status: controllerStatus(
      b,
      a,
      layers,
      parameters,
      states.anyChanged,
      transitions.anyChanged,
      stateMachines.anyChanged
    ),
    before: b,
    after: a,
    layers,
    parameters,
    states: states.diffs,
    transitions: transitions.diffs,
    stateMachines: stateMachines.diffs,
  }
}

/** Diff every AnimatorController across two sides. Currently expects at most one per file. */
export const diffAnimatorControllers = (
  before: ReadonlyArray<IUnitySerializedDocument>,
  after: ReadonlyArray<IUnitySerializedDocument>
): ReadonlyArray<IUnityAnimatorControllerDiff> => {
  const b = parseAnimatorController(before)
  const a = parseAnimatorController(after)
  if (b === undefined && a === undefined) {
    // no-op, silence linter
    emptyController()
    return []
  }
  const fileId = a?.fileId ?? b?.fileId ?? '0'
  return [diffOneController(fileId, b, a)]
}
