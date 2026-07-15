/**
 * Two-sided AnimationClip diff. Matches clips across sides by fileId, curves
 * within a clip by their composite `(kind, path, attribute, channel)` key, and
 * keyframes within a curve pair by `time` within an epsilon derived from the
 * clip's sample rate. Every matching level is content-addressed rather than
 * positional, so a keyframe inserted in the middle of a curve isn't reported
 * as "every subsequent key changed".
 */

import { IUnitySerializedDocument } from '../../models/unity/serialized-asset'
import {
  IUnityAnimationClip,
  IUnityAnimationClipDiff,
  IUnityAnimCurve,
  IUnityAnimCurveDiff,
  IUnityAnimKey,
  IUnityAnimKeyDiff,
  UnityAnimCurveStatus,
  UnityAnimHeaderField,
} from '../../models/unity/animation-clip'
import { parseAnimationClips } from './animation-clip'

const VALUE_EPSILON = 1e-6
const DEFAULT_TIME_EPSILON = 1e-4

const composedCurveKey = (curve: IUnityAnimCurve): string =>
  `${curve.kind}|${curve.path}|${curve.attribute}|${curve.channel ?? ''}`

const keysEqualNumeric = (
  a: number | string,
  b: number | string
): boolean => {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= VALUE_EPSILON
  }
  return a === b
}

const numericValue = (value: number | string): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const slopesEqual = (
  a: number | 'inf' | '-inf' | 'nan',
  b: number | 'inf' | '-inf' | 'nan'
): boolean => {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= VALUE_EPSILON
  }
  return a === b
}

const keyBodyEqual = (a: IUnityAnimKey, b: IUnityAnimKey): boolean =>
  keysEqualNumeric(a.value, b.value) &&
  slopesEqual(a.inSlope, b.inSlope) &&
  slopesEqual(a.outSlope, b.outSlope) &&
  a.tangentMode === b.tangentMode &&
  a.weightedMode === b.weightedMode

const timeEpsilonFor = (
  before: IUnityAnimationClip | undefined,
  after: IUnityAnimationClip | undefined
): number => {
  const rate = Math.max(
    before?.sampleRate ?? 0,
    after?.sampleRate ?? 0
  )
  return rate > 0 ? 0.5 / rate : DEFAULT_TIME_EPSILON
}

/**
 * Match keyframes across two sorted-by-time curves. Walks both arrays with a
 * two-pointer sweep: within `timeEpsilon`, consume both; otherwise consume the
 * side with the smaller `time` and mark it added/removed accordingly.
 */
const matchKeys = (
  before: ReadonlyArray<IUnityAnimKey>,
  after: ReadonlyArray<IUnityAnimKey>,
  timeEpsilon: number
): ReadonlyArray<IUnityAnimKeyDiff> => {
  const out: IUnityAnimKeyDiff[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    const b = before[i]
    const a = after[j]
    const dt = a.time - b.time
    if (Math.abs(dt) <= timeEpsilon) {
      const equal = keyBodyEqual(b, a)
      const beforeVal = numericValue(b.value)
      const afterVal = numericValue(a.value)
      const delta = beforeVal !== undefined && afterVal !== undefined
        ? Math.abs(afterVal - beforeVal)
        : undefined
      out.push({
        beforeIndex: i,
        afterIndex: j,
        status: equal ? 'unchanged' : 'modified',
        valueDelta: equal ? undefined : delta,
      })
      i++
      j++
    } else if (dt > 0) {
      out.push({ beforeIndex: i, status: 'removed' })
      i++
    } else {
      out.push({ afterIndex: j, status: 'added' })
      j++
    }
  }
  while (i < before.length) {
    out.push({ beforeIndex: i, status: 'removed' })
    i++
  }
  while (j < after.length) {
    out.push({ afterIndex: j, status: 'added' })
    j++
  }
  return out
}

const rollupStatus = (
  keyDiffs: ReadonlyArray<IUnityAnimKeyDiff>,
  extraChanged: boolean
): UnityAnimCurveStatus => {
  const anyChanged =
    extraChanged || keyDiffs.some(k => k.status !== 'unchanged')
  return anyChanged ? 'modified' : 'unchanged'
}

const soloCurve = (
  curve: IUnityAnimCurve,
  status: 'added' | 'removed'
): IUnityAnimCurveDiff => ({
  key: composedCurveKey(curve),
  status,
  before: status === 'removed' ? curve : undefined,
  after: status === 'added' ? curve : undefined,
  keyDiffs: curve.keys.map((_, index) =>
    status === 'added'
      ? { afterIndex: index, status: 'added' as const }
      : { beforeIndex: index, status: 'removed' as const }
  ),
  changed: {
    keys: curve.keys.length > 0,
    preInfinity: true,
    postInfinity: true,
  },
})

const diffCurvePair = (
  before: IUnityAnimCurve,
  after: IUnityAnimCurve,
  timeEpsilon: number
): IUnityAnimCurveDiff => {
  const keyDiffs = matchKeys(before.keys, after.keys, timeEpsilon)
  const preInfinity = before.preInfinity !== after.preInfinity
  const postInfinity = before.postInfinity !== after.postInfinity
  const keysChanged = keyDiffs.some(k => k.status !== 'unchanged')
  return {
    key: composedCurveKey(before),
    status: rollupStatus(keyDiffs, preInfinity || postInfinity),
    before,
    after,
    keyDiffs,
    changed: {
      keys: keysChanged,
      preInfinity,
      postInfinity,
    },
  }
}

const HEADER_FIELDS: ReadonlyArray<UnityAnimHeaderField> = [
  'sampleRate',
  'wrapMode',
  'loopTime',
  'startTime',
  'stopTime',
  'legacy',
]

const headerChangesOf = (
  before: IUnityAnimationClip,
  after: IUnityAnimationClip
): ReadonlyArray<UnityAnimHeaderField> => {
  const changed: UnityAnimHeaderField[] = []
  for (const field of HEADER_FIELDS) {
    const a = before[field]
    const b = after[field]
    const equal = typeof a === 'number' && typeof b === 'number'
      ? Math.abs(a - b) <= VALUE_EPSILON
      : a === b
    if (!equal) {
      changed.push(field)
    }
  }
  return changed
}

const clipCurves = (
  before: IUnityAnimationClip | undefined,
  after: IUnityAnimationClip | undefined,
  timeEpsilon: number
): ReadonlyArray<IUnityAnimCurveDiff> => {
  const beforeCurves = new Map<string, IUnityAnimCurve>()
  for (const c of before?.curves ?? []) {
    beforeCurves.set(composedCurveKey(c), c)
  }
  const afterCurves = new Map<string, IUnityAnimCurve>()
  for (const c of after?.curves ?? []) {
    afterCurves.set(composedCurveKey(c), c)
  }
  // Iteration in the union order — after-side first (so added curves keep
  // their natural top-down order), then before-only survivors.
  const keys: string[] = []
  const seen = new Set<string>()
  const collect = (map: Map<string, IUnityAnimCurve>) => {
    for (const key of map.keys()) {
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }
  collect(afterCurves)
  collect(beforeCurves)

  const out: IUnityAnimCurveDiff[] = []
  for (const key of keys) {
    const b = beforeCurves.get(key)
    const a = afterCurves.get(key)
    if (b !== undefined && a !== undefined) {
      out.push(diffCurvePair(b, a, timeEpsilon))
    } else if (a !== undefined) {
      out.push(soloCurve(a, 'added'))
    } else if (b !== undefined) {
      out.push(soloCurve(b, 'removed'))
    }
  }
  return out
}

const clipStatus = (
  before: IUnityAnimationClip | undefined,
  after: IUnityAnimationClip | undefined,
  headerChanges: ReadonlyArray<UnityAnimHeaderField>,
  curves: ReadonlyArray<IUnityAnimCurveDiff>
): UnityAnimCurveStatus => {
  if (before === undefined) {
    return 'added'
  }
  if (after === undefined) {
    return 'removed'
  }
  if (headerChanges.length > 0 || curves.some(c => c.status !== 'unchanged')) {
    return 'modified'
  }
  return 'unchanged'
}

/**
 * Diff every AnimationClip document across two sides. Matches by fileId; clips
 * on one side only are reported as added / removed. Non-AnimationClip
 * documents in either side are ignored (they diff through the generic
 * document-level pipeline instead).
 */
export const diffAnimationClips = (
  before: ReadonlyArray<IUnitySerializedDocument>,
  after: ReadonlyArray<IUnitySerializedDocument>
): ReadonlyArray<IUnityAnimationClipDiff> => {
  const beforeClips = new Map<string, IUnityAnimationClip>()
  for (const clip of parseAnimationClips(before)) {
    beforeClips.set(clip.fileId, clip)
  }
  const afterClips = new Map<string, IUnityAnimationClip>()
  for (const clip of parseAnimationClips(after)) {
    afterClips.set(clip.fileId, clip)
  }

  const out: IUnityAnimationClipDiff[] = []
  const seen = new Set<string>()
  const push = (fileId: string) => {
    if (seen.has(fileId)) {
      return
    }
    seen.add(fileId)
    const b = beforeClips.get(fileId)
    const a = afterClips.get(fileId)
    const timeEpsilon = timeEpsilonFor(b, a)
    const headerChanges = b !== undefined && a !== undefined
      ? headerChangesOf(b, a)
      : []
    const curves = clipCurves(b, a, timeEpsilon)
    out.push({
      fileId,
      status: clipStatus(b, a, headerChanges, curves),
      before: b,
      after: a,
      curves,
      headerChanges,
    })
  }
  for (const fileId of afterClips.keys()) {
    push(fileId)
  }
  for (const fileId of beforeClips.keys()) {
    push(fileId)
  }
  return out
}
