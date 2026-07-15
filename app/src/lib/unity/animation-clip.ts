/**
 * Reshape a Unity `!u!74 AnimationClip` document into the friendly clip model.
 * The generic Unity YAML parser gives us a nested property tree; this pass
 * flattens the tree into a list of typed curves keyed by (kind, path,
 * attribute, channel) so the Inspector never has to walk raw YAML at render
 * time. Vector-valued curves (position/rotation/scale/euler) are split into
 * per-axis curves — animators think in axes, and diffs on X alone stay
 * isolated from Y and Z.
 *
 * Non-finite slopes (`Infinity` / `-Infinity` / `NaN`) survive as tagged
 * strings so the chart primitive can pick a step glyph instead of poisoning
 * numeric math. Unity emits an `m_EditorCurves` sibling for editor-only
 * mirroring of `m_FloatCurves`; we filter it out so a single logical curve
 * isn't counted twice.
 */

import {
  IUnityPropertyNode,
  IUnitySerializedDocument,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'
import {
  IUnityAnimationClip,
  IUnityAnimCurve,
  IUnityAnimKey,
  UnityChannel,
  UnityCurveKind,
  UnityNonFinite,
} from '../../models/unity/animation-clip'

/** Unity class ID for AnimationClip. */
export const ANIMATION_CLIP_CLASS_ID = 74

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

const parseSlope = (raw: string | undefined): number | UnityNonFinite => {
  if (raw === undefined) {
    return 0
  }
  if (raw === 'Infinity' || raw === '.inf' || raw === '+.inf') {
    return 'inf'
  }
  if (raw === '-Infinity' || raw === '-.inf') {
    return '-inf'
  }
  if (raw === 'NaN' || raw === '.nan') {
    return 'nan'
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 'nan'
}

/**
 * The channel labels used to split a vector-valued keyframe. Matches the
 * order Unity itself uses when it flattens a Vector3/Quaternion into
 * individual `.x`/`.y`/`.z`/`.w` bindings on `m_ClipBindingConstant`.
 */
const vectorChannels: ReadonlyArray<UnityChannel> = ['x', 'y', 'z', 'w']

/** True when a scalar/map value looks like the `{x,y,z}` / `{x,y,z,w}` shape. */
const isVectorValueMap = (
  value: UnityPropertyValue | undefined
): value is Extract<UnityPropertyValue, { kind: 'map' }> => {
  if (value === undefined || value.kind !== 'map') {
    return false
  }
  return value.entries.every(
    e =>
      e.value.kind === 'scalar' &&
      (e.key === 'x' || e.key === 'y' || e.key === 'z' || e.key === 'w')
  )
}

interface IRawKeyframe {
  readonly time: number
  readonly value: UnityPropertyValue
  readonly inSlope: UnityPropertyValue | undefined
  readonly outSlope: UnityPropertyValue | undefined
  readonly tangentMode: number
  readonly weightedMode: number
}

const rawKeyframes = (
  curveMap: UnityPropertyValue | undefined
): ReadonlyArray<IRawKeyframe> => {
  const outer = entriesOf(curveMap)
  const inner = itemsOf(findEntry(outer, 'm_Curve'))
  const out: IRawKeyframe[] = []
  for (const item of inner) {
    if (item.kind !== 'map') {
      continue
    }
    const time = numberOr(findEntry(item.entries, 'time'), 0)
    const value = findEntry(item.entries, 'value')
    if (value === undefined) {
      continue
    }
    out.push({
      time,
      value,
      inSlope: findEntry(item.entries, 'inSlope'),
      outSlope: findEntry(item.entries, 'outSlope'),
      tangentMode: numberOr(findEntry(item.entries, 'tangentMode'), 0),
      weightedMode: numberOr(findEntry(item.entries, 'weightedMode'), 0),
    })
  }
  return out
}

const scalarKey = (raw: IRawKeyframe): IUnityAnimKey => ({
  time: raw.time,
  value:
    raw.value.kind === 'scalar' ? Number(raw.value.value) || 0 : String(raw.value.kind),
  inSlope: parseSlope(scalarOf(raw.inSlope)),
  outSlope: parseSlope(scalarOf(raw.outSlope)),
  tangentMode: raw.tangentMode,
  weightedMode: raw.weightedMode,
})

const pptrKey = (raw: IRawKeyframe): IUnityAnimKey => {
  let value: string = ''
  if (raw.value.kind === 'reference') {
    value = raw.value.reference.fileId
  } else if (raw.value.kind === 'scalar') {
    value = raw.value.value
  }
  return {
    time: raw.time,
    value,
    inSlope: 0,
    outSlope: 0,
    tangentMode: raw.tangentMode,
    weightedMode: raw.weightedMode,
  }
}

const vectorChannelKey = (
  raw: IRawKeyframe,
  channel: UnityChannel
): IUnityAnimKey | undefined => {
  if (raw.value.kind !== 'map' || channel === undefined) {
    return undefined
  }
  const value = findEntry(raw.value.entries, channel)
  if (value === undefined || value.kind !== 'scalar') {
    return undefined
  }
  const inSlopeMap = raw.inSlope !== undefined && raw.inSlope.kind === 'map'
    ? findEntry(raw.inSlope.entries, channel)
    : undefined
  const outSlopeMap = raw.outSlope !== undefined && raw.outSlope.kind === 'map'
    ? findEntry(raw.outSlope.entries, channel)
    : undefined
  return {
    time: raw.time,
    value: Number(value.value) || 0,
    inSlope: parseSlope(scalarOf(inSlopeMap)),
    outSlope: parseSlope(scalarOf(outSlopeMap)),
    tangentMode: raw.tangentMode,
    weightedMode: raw.weightedMode,
  }
}

const infinityFields = (
  curveMap: UnityPropertyValue | undefined
): { pre: number; post: number } => {
  const entries = entriesOf(curveMap)
  return {
    pre: numberOr(findEntry(entries, 'm_PreInfinity'), 0),
    post: numberOr(findEntry(entries, 'm_PostInfinity'), 0),
  }
}

const attributeForKind = (kind: UnityCurveKind): string => {
  switch (kind) {
    case 'position':
      return 'm_LocalPosition'
    case 'rotation':
      return 'm_LocalRotation'
    case 'euler':
      return 'm_LocalEulerAnglesHint'
    case 'scale':
      return 'm_LocalScale'
    default:
      return ''
  }
}

const splitVectorCurve = (
  entry: UnityPropertyValue,
  kind: UnityCurveKind
): ReadonlyArray<IUnityAnimCurve> => {
  if (entry.kind !== 'map') {
    return []
  }
  const curveMap = findEntry(entry.entries, 'curve')
  const path = scalarOf(findEntry(entry.entries, 'path')) ?? ''
  const raws = rawKeyframes(curveMap)
  if (raws.length === 0) {
    return []
  }
  const sample = raws[0].value
  const channels = kind === 'rotation' && isVectorValueMap(sample)
    ? vectorChannels.filter(c =>
        sample.entries.some(e => e.key === c)
      )
    : vectorChannels.slice(0, 3)
  const attribute = attributeForKind(kind)
  const { pre, post } = infinityFields(curveMap)
  const out: IUnityAnimCurve[] = []
  for (const channel of channels) {
    const keys: IUnityAnimKey[] = []
    for (const raw of raws) {
      const key = vectorChannelKey(raw, channel)
      if (key !== undefined) {
        keys.push(key)
      }
    }
    if (keys.length > 0) {
      out.push({
        kind,
        path,
        attribute,
        channel,
        keys,
        preInfinity: pre,
        postInfinity: post,
      })
    }
  }
  return out
}

const buildScalarCurve = (
  entry: UnityPropertyValue,
  kind: 'float' | 'pptr'
): IUnityAnimCurve | undefined => {
  if (entry.kind !== 'map') {
    return undefined
  }
  const curveMap = findEntry(entry.entries, 'curve')
  const attribute = scalarOf(findEntry(entry.entries, 'attribute')) ?? ''
  const path = scalarOf(findEntry(entry.entries, 'path')) ?? ''
  const classIdRaw = scalarOf(findEntry(entry.entries, 'classID'))
  const classID = classIdRaw !== undefined ? Number(classIdRaw) : undefined
  const raws = rawKeyframes(curveMap)
  if (raws.length === 0) {
    return undefined
  }
  const keys = raws.map(kind === 'pptr' ? pptrKey : scalarKey)
  const { pre, post } = infinityFields(curveMap)
  return {
    kind,
    path,
    attribute,
    channel: undefined,
    classID,
    keys,
    preInfinity: pre,
    postInfinity: post,
  }
}

/**
 * Parse one AnimationClip document into a flat curve list. Returns `undefined`
 * for non-AnimationClip documents so callers can filter with `.map(parse) ...
 * .filter(Boolean)`.
 */
export const parseAnimationClip = (
  doc: IUnitySerializedDocument
): IUnityAnimationClip | undefined => {
  if (doc.classId !== ANIMATION_CLIP_CLASS_ID) {
    return undefined
  }
  const props = doc.properties
  const settings = findEntry(props, 'm_AnimationClipSettings')
  const settingsEntries = entriesOf(settings)

  const curves: IUnityAnimCurve[] = []
  const push = (arr: ReadonlyArray<IUnityAnimCurve>) => curves.push(...arr)

  for (const raw of itemsOf(findEntry(props, 'm_PositionCurves'))) {
    push(splitVectorCurve(raw, 'position'))
  }
  for (const raw of itemsOf(findEntry(props, 'm_RotationCurves'))) {
    push(splitVectorCurve(raw, 'rotation'))
  }
  for (const raw of itemsOf(findEntry(props, 'm_EulerCurves'))) {
    push(splitVectorCurve(raw, 'euler'))
  }
  for (const raw of itemsOf(findEntry(props, 'm_ScaleCurves'))) {
    push(splitVectorCurve(raw, 'scale'))
  }
  for (const raw of itemsOf(findEntry(props, 'm_FloatCurves'))) {
    const curve = buildScalarCurve(raw, 'float')
    if (curve !== undefined) {
      curves.push(curve)
    }
  }
  for (const raw of itemsOf(findEntry(props, 'm_PPtrCurves'))) {
    const curve = buildScalarCurve(raw, 'pptr')
    if (curve !== undefined) {
      curves.push(curve)
    }
  }

  return {
    fileId: doc.fileId,
    name: scalarOf(findEntry(props, 'm_Name')) ?? '',
    sampleRate: numberOr(findEntry(props, 'm_SampleRate'), 60),
    wrapMode: numberOr(findEntry(props, 'm_WrapMode'), 0),
    loopTime: boolOr(findEntry(settingsEntries, 'm_LoopTime'), false),
    startTime: numberOr(findEntry(settingsEntries, 'm_StartTime'), 0),
    stopTime: numberOr(findEntry(settingsEntries, 'm_StopTime'), 0),
    legacy: boolOr(findEntry(props, 'm_Legacy'), false),
    curves,
  }
}

/** Parse every AnimationClip in a document list, dropping other classes. */
export const parseAnimationClips = (
  documents: ReadonlyArray<IUnitySerializedDocument>
): ReadonlyArray<IUnityAnimationClip> => {
  const out: IUnityAnimationClip[] = []
  for (const doc of documents) {
    const clip = parseAnimationClip(doc)
    if (clip !== undefined) {
      out.push(clip)
    }
  }
  return out
}
