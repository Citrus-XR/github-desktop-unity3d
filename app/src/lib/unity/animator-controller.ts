/**
 * Reshape a Unity `!u!91` AnimatorController document tree into the friendly
 * graph model. Positions come from Unity's YAML unchanged, so the resulting
 * node layout matches the Animator window one-for-one and no auto-layout
 * algorithm is needed.
 *
 * The parser accepts the full document list, finds the single `!u!91`, walks
 * its layers and parameters, and hydrates the state / state-machine /
 * transition maps by iterating the `!u!1107 / 1102 / 1101 / 1109` docs.
 * State node coordinates live on the parent state machine's
 * `m_ChildStates[i].m_Position`, not on the AnimatorState doc itself — that's
 * where Unity stores them so the same clip can appear in multiple SMs at
 * different positions.
 */

import {
  IUnityPropertyNode,
  IUnitySerializedDocument,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'
import {
  IUnityAnimatorController,
  IUnityAnimChildStateMachineRef,
  IUnityAnimCondition,
  IUnityAnimLayer,
  IUnityAnimParameter,
  IUnityAnimPosition,
  IUnityAnimState,
  IUnityAnimStateMachine,
  IUnityAnimTransition,
  UnityAnimParamType,
  UnityAnimTransitionKind,
} from '../../models/unity/animator-controller'

export const ANIMATOR_CONTROLLER_CLASS_ID = 91
export const ANIMATOR_STATE_MACHINE_CLASS_ID = 1107
export const ANIMATOR_STATE_CLASS_ID = 1102
export const ANIMATOR_STATE_TRANSITION_CLASS_ID = 1101
export const ANIMATOR_TRANSITION_CLASS_ID = 1109

// The small property-tree helpers duplicated from `animation-clip.ts`. Both
// files are stable and self-contained; extracting them to a shared module is
// a mechanical refactor we'll do the third time we need them.

const entriesOf = (
  value: UnityPropertyValue | undefined
): ReadonlyArray<IUnityPropertyNode> =>
  value !== undefined && value.kind === 'map' ? value.entries : []

const itemsOf = (
  value: UnityPropertyValue | undefined
): ReadonlyArray<UnityPropertyValue> =>
  value !== undefined && value.kind === 'sequence' ? value.items : []

const scalarOf = (value: UnityPropertyValue | undefined): string | undefined =>
  value !== undefined && value.kind === 'scalar' ? value.value : undefined

const findEntry = (
  entries: ReadonlyArray<IUnityPropertyNode>,
  key: string
): UnityPropertyValue | undefined => entries.find(e => e.key === key)?.value

const numberOr = (
  value: UnityPropertyValue | undefined,
  fallback: number
): number => {
  const raw = scalarOf(value)
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const boolOr = (
  value: UnityPropertyValue | undefined,
  fallback: boolean
): boolean => {
  const raw = scalarOf(value)
  return raw === '1' ? true : raw === '0' ? false : fallback
}

const positionOf = (value: UnityPropertyValue | undefined): IUnityAnimPosition => {
  const entries = entriesOf(value)
  return {
    x: numberOr(findEntry(entries, 'x'), 0),
    y: numberOr(findEntry(entries, 'y'), 0),
  }
}

/** Pull a fileID out of a Unity `{fileID: n}` reference node, or undefined. */
const refFileId = (value: UnityPropertyValue | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (value.kind === 'reference') {
    return value.reference.fileId
  }
  if (value.kind === 'map') {
    return scalarOf(findEntry(value.entries, 'fileID'))
  }
  return undefined
}

const refFileIdOr = (value: UnityPropertyValue | undefined, fallback: string): string =>
  refFileId(value) ?? fallback

/** Pull the cross-file guid off a Unity reference, if any. */
const refGuid = (value: UnityPropertyValue | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (value.kind === 'reference') {
    return value.reference.guid
  }
  if (value.kind === 'map') {
    const g = scalarOf(findEntry(value.entries, 'guid'))
    return g !== undefined && g.length > 0 ? g : undefined
  }
  return undefined
}

const paramTypeOf = (raw: number): UnityAnimParamType => {
  // Unity emits Float=1, Int=3, Bool=4, Trigger=9. Anything unknown falls
  // back to Float so the UI still renders something coherent.
  if (raw === 1 || raw === 3 || raw === 4 || raw === 9) {
    return raw
  }
  return 1
}

const parseParameters = (
  value: UnityPropertyValue | undefined
): ReadonlyArray<IUnityAnimParameter> => {
  const out: IUnityAnimParameter[] = []
  for (const item of itemsOf(value)) {
    if (item.kind !== 'map') {
      continue
    }
    const name = scalarOf(findEntry(item.entries, 'm_Name')) ?? ''
    const typeRaw = numberOr(findEntry(item.entries, 'm_Type'), 1)
    out.push({
      name,
      type: paramTypeOf(typeRaw),
      defaultFloat: numberOr(findEntry(item.entries, 'm_DefaultFloat'), 0),
      defaultInt: numberOr(findEntry(item.entries, 'm_DefaultInt'), 0),
      defaultBool: boolOr(findEntry(item.entries, 'm_DefaultBool'), false),
    })
  }
  return out
}

const parseLayers = (
  value: UnityPropertyValue | undefined
): ReadonlyArray<IUnityAnimLayer> => {
  const out: IUnityAnimLayer[] = []
  for (const item of itemsOf(value)) {
    if (item.kind !== 'map') {
      continue
    }
    const smRef = findEntry(item.entries, 'm_StateMachine')
    const maskRef = findEntry(item.entries, 'm_Mask')
    out.push({
      name: scalarOf(findEntry(item.entries, 'm_Name')) ?? '',
      stateMachineFileId: refFileIdOr(smRef, '0'),
      maskGuid: refGuid(maskRef),
      blendingMode: numberOr(findEntry(item.entries, 'm_BlendingMode'), 0),
      defaultWeight: numberOr(findEntry(item.entries, 'm_DefaultWeight'), 1),
      syncedLayerIndex: numberOr(findEntry(item.entries, 'm_SyncedLayerIndex'), -1),
    })
  }
  return out
}

const parseConditions = (
  value: UnityPropertyValue | undefined
): ReadonlyArray<IUnityAnimCondition> => {
  const out: IUnityAnimCondition[] = []
  for (const item of itemsOf(value)) {
    if (item.kind !== 'map') {
      continue
    }
    out.push({
      mode: numberOr(findEntry(item.entries, 'm_ConditionMode'), 0),
      parameter: scalarOf(findEntry(item.entries, 'm_ConditionEvent')) ?? '',
      threshold: numberOr(findEntry(item.entries, 'm_EventTreshold'), 0),
    })
  }
  return out
}

const parseTransition = (
  doc: IUnitySerializedDocument,
  ownerFileId: string,
  kind: UnityAnimTransitionKind
): IUnityAnimTransition => {
  const props = doc.properties
  const isExit = boolOr(findEntry(props, 'm_IsExit'), false)
  return {
    fileId: doc.fileId,
    ownerFileId,
    kind: isExit && kind === 'state' ? 'exit' : kind,
    dstStateFileId: refFileId(findEntry(props, 'm_DstState')),
    dstStateMachineFileId: refFileId(findEntry(props, 'm_DstStateMachine')),
    isExit,
    solo: boolOr(findEntry(props, 'm_Solo'), false),
    mute: boolOr(findEntry(props, 'm_Mute'), false),
    hasExitTime: boolOr(findEntry(props, 'm_HasExitTime'), false),
    exitTime: numberOr(findEntry(props, 'm_ExitTime'), 0),
    duration: numberOr(findEntry(props, 'm_TransitionDuration'), 0),
    offset: numberOr(findEntry(props, 'm_TransitionOffset'), 0),
    conditions: parseConditions(findEntry(props, 'm_Conditions')),
  }
}

const parseState = (
  doc: IUnitySerializedDocument,
  position: IUnityAnimPosition
): IUnityAnimState => {
  const props = doc.properties
  const motionRef = findEntry(props, 'm_Motion')
  return {
    fileId: doc.fileId,
    name: scalarOf(findEntry(props, 'm_Name')) ?? '',
    position,
    speed: numberOr(findEntry(props, 'm_Speed'), 1),
    cycleOffset: numberOr(findEntry(props, 'm_CycleOffset'), 0),
    writeDefaultValues: boolOr(findEntry(props, 'm_WriteDefaultValues'), true),
    tag: scalarOf(findEntry(props, 'm_Tag')) ?? '',
    motionFileId: refFileIdOr(motionRef, '0'),
    motionGuid: refGuid(motionRef),
    transitionFileIds: idsFromRefList(findEntry(props, 'm_Transitions')),
    behaviourFileIds: idsFromRefList(findEntry(props, 'm_StateMachineBehaviours')),
  }
}

const idsFromRefList = (
  value: UnityPropertyValue | undefined
): ReadonlyArray<string> => {
  const out: string[] = []
  for (const item of itemsOf(value)) {
    const id = refFileId(item)
    if (id !== undefined && id !== '0') {
      out.push(id)
    }
  }
  return out
}

const parseStateMachineDoc = (
  doc: IUnitySerializedDocument
): {
  sm: IUnityAnimStateMachine
  childPositions: ReadonlyMap<string, IUnityAnimPosition>
} => {
  const props = doc.properties
  const childStates = itemsOf(findEntry(props, 'm_ChildStates'))
  const stateFileIds: string[] = []
  const childPositions = new Map<string, IUnityAnimPosition>()
  for (const entry of childStates) {
    if (entry.kind !== 'map') {
      continue
    }
    const stateRef = findEntry(entry.entries, 'm_State')
    const id = refFileId(stateRef)
    if (id === undefined) {
      continue
    }
    stateFileIds.push(id)
    childPositions.set(id, positionOf(findEntry(entry.entries, 'm_Position')))
  }

  const childSMs: IUnityAnimChildStateMachineRef[] = []
  for (const entry of itemsOf(findEntry(props, 'm_ChildStateMachines'))) {
    if (entry.kind !== 'map') {
      continue
    }
    const smRef = findEntry(entry.entries, 'm_StateMachine')
    const id = refFileId(smRef)
    if (id === undefined || id === '0') {
      continue
    }
    childSMs.push({
      fileId: id,
      position: positionOf(findEntry(entry.entries, 'm_Position')),
    })
  }

  const sm: IUnityAnimStateMachine = {
    fileId: doc.fileId,
    name: scalarOf(findEntry(props, 'm_Name')) ?? '',
    defaultStateFileId: refFileId(findEntry(props, 'm_DefaultState')),
    anyStatePos: positionOf(findEntry(props, 'm_AnyStatePosition')),
    entryPos: positionOf(findEntry(props, 'm_EntryPosition')),
    exitPos: positionOf(findEntry(props, 'm_ExitPosition')),
    parentPos: positionOf(findEntry(props, 'm_ParentStateMachinePosition')),
    stateFileIds,
    childStateMachines: childSMs,
    anyStateTransitionFileIds: idsFromRefList(findEntry(props, 'm_AnyStateTransitions')),
    entryTransitionFileIds: idsFromRefList(findEntry(props, 'm_EntryTransitions')),
  }
  return { sm, childPositions }
}

/**
 * Parse the AnimatorController that lives in a document list, plus every
 * document it owns. Returns `undefined` when no `!u!91` doc is present so
 * callers can filter.
 */
export const parseAnimatorController = (
  documents: ReadonlyArray<IUnitySerializedDocument>
): IUnityAnimatorController | undefined => {
  const controllerDoc = documents.find(
    d => d.classId === ANIMATOR_CONTROLLER_CLASS_ID
  )
  if (controllerDoc === undefined) {
    return undefined
  }
  const props = controllerDoc.properties
  const name = scalarOf(findEntry(props, 'm_Name')) ?? ''
  const parameters = parseParameters(findEntry(props, 'm_AnimatorParameters'))
  const layers = parseLayers(findEntry(props, 'm_AnimatorLayers'))

  // First pass: state machines, and the state→position map.
  const stateMachines = new Map<string, IUnityAnimStateMachine>()
  const positions = new Map<string, IUnityAnimPosition>()
  for (const doc of documents) {
    if (doc.classId !== ANIMATOR_STATE_MACHINE_CLASS_ID) {
      continue
    }
    const { sm, childPositions } = parseStateMachineDoc(doc)
    stateMachines.set(doc.fileId, sm)
    for (const [id, pos] of childPositions) {
      // If the same state is referenced from multiple SMs (rare but legal),
      // the last write wins — the graph viewer only draws one instance per
      // state anyway (Unity does the same, showing the state under its
      // primary SM).
      positions.set(id, pos)
    }
  }

  // Second pass: states.
  const states = new Map<string, IUnityAnimState>()
  for (const doc of documents) {
    if (doc.classId !== ANIMATOR_STATE_CLASS_ID) {
      continue
    }
    states.set(doc.fileId, parseState(doc, positions.get(doc.fileId) ?? { x: 0, y: 0 }))
  }

  // Third pass: transitions. Ownership is derived by scanning each state's
  // and state-machine's transition-ID lists and reverse-mapping.
  const transitionOwner = new Map<string, { owner: string; kind: UnityAnimTransitionKind }>()
  for (const state of states.values()) {
    for (const id of state.transitionFileIds) {
      transitionOwner.set(id, { owner: state.fileId, kind: 'state' })
    }
  }
  for (const sm of stateMachines.values()) {
    for (const id of sm.anyStateTransitionFileIds) {
      transitionOwner.set(id, { owner: sm.fileId, kind: 'anystate' })
    }
    for (const id of sm.entryTransitionFileIds) {
      transitionOwner.set(id, { owner: sm.fileId, kind: 'entry' })
    }
  }

  const transitions = new Map<string, IUnityAnimTransition>()
  for (const doc of documents) {
    if (
      doc.classId !== ANIMATOR_STATE_TRANSITION_CLASS_ID &&
      doc.classId !== ANIMATOR_TRANSITION_CLASS_ID
    ) {
      continue
    }
    const owner = transitionOwner.get(doc.fileId)
    transitions.set(
      doc.fileId,
      parseTransition(
        doc,
        owner?.owner ?? '0',
        owner?.kind ?? 'state'
      )
    )
  }

  return {
    fileId: controllerDoc.fileId,
    name,
    parameters,
    layers,
    stateMachines,
    states,
    transitions,
  }
}
