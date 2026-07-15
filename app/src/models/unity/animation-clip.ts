/**
 * Domain model for Unity's AnimationClip (`!u!74`) shown by the friendly clip
 * viewer. Kept separate from the generic serialized-asset tree because a clip
 * is dominated by huge curve arrays whose readable form is a per-binding curve
 * — not a nested property mapping.
 *
 * All numeric fields are already parsed at this layer. Non-finite slopes and
 * PPtr values are tagged so downstream renderers can pick a step glyph vs a
 * smooth segment without re-inspecting raw strings.
 */

import { UnityFileId } from './serialized-asset'

/** What Unity binding family a curve targets. */
export type UnityCurveKind =
  | 'position'
  | 'rotation'
  | 'euler'
  | 'scale'
  | 'float'
  | 'pptr'

/**
 * Per-channel axis for vector-valued curves. `undefined` for scalar curves
 * (float / PPtr) and quaternion `.w`.
 */
export type UnityChannel =
  | 'x'
  | 'y'
  | 'z'
  | 'w'
  | 'r'
  | 'g'
  | 'b'
  | 'a'
  | undefined

/** Non-finite marker for Unity's Infinity / -Infinity / NaN slope values. */
export type UnityNonFinite = 'inf' | '-inf' | 'nan'

/** One keyframe on a numeric curve. PPtr keys carry a `string` value. */
export interface IUnityAnimKey {
  readonly time: number
  readonly value: number | string
  readonly inSlope: number | UnityNonFinite
  readonly outSlope: number | UnityNonFinite
  readonly tangentMode: number
  readonly weightedMode: number
}

/**
 * One curve. Vector-valued clips (`m_PositionCurves` etc.) are split into
 * per-axis curves so a change on X alone stays isolated from Y and Z.
 */
export interface IUnityAnimCurve {
  readonly kind: UnityCurveKind
  /** GameObject path from the AnimationClip's binding, e.g. `Body/Head`. */
  readonly path: string
  /** Unity attribute name — e.g. `m_LocalPosition`, `m_IsActive`. */
  readonly attribute: string
  readonly channel: UnityChannel
  /** For float / PPtr curves — the target component's class ID. */
  readonly classID?: number
  readonly keys: ReadonlyArray<IUnityAnimKey>
  readonly preInfinity: number
  readonly postInfinity: number
}

/** A single reshaped AnimationClip. */
export interface IUnityAnimationClip {
  readonly fileId: UnityFileId
  readonly name: string
  readonly sampleRate: number
  readonly wrapMode: number
  readonly loopTime: boolean
  readonly startTime: number
  readonly stopTime: number
  readonly legacy: boolean
  readonly curves: ReadonlyArray<IUnityAnimCurve>
}

export type UnityAnimCurveStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'unchanged'

/**
 * Diff status for one keyframe within a curve pair, matched by `time` within
 * epsilon. Indexes are into the corresponding side's `keys` array.
 */
export interface IUnityAnimKeyDiff {
  readonly beforeIndex?: number
  readonly afterIndex?: number
  readonly status: UnityAnimCurveStatus
  /** `|after.value - before.value|` when both sides are numeric. */
  readonly valueDelta?: number
}

/** Diff of one curve identified by `${kind}|${path}|${attribute}|${channel}`. */
export interface IUnityAnimCurveDiff {
  readonly key: string
  readonly status: UnityAnimCurveStatus
  readonly before?: IUnityAnimCurve
  readonly after?: IUnityAnimCurve
  readonly keyDiffs: ReadonlyArray<IUnityAnimKeyDiff>
  readonly changed: {
    readonly keys: boolean
    readonly preInfinity: boolean
    readonly postInfinity: boolean
  }
}

/** Header fields the diff tracks for a summary banner. */
export type UnityAnimHeaderField =
  | 'sampleRate'
  | 'wrapMode'
  | 'loopTime'
  | 'startTime'
  | 'stopTime'
  | 'legacy'

/** Diff of one AnimationClip document, matched across sides by fileId. */
export interface IUnityAnimationClipDiff {
  readonly fileId: UnityFileId
  readonly status: UnityAnimCurveStatus
  readonly before?: IUnityAnimationClip
  readonly after?: IUnityAnimationClip
  readonly curves: ReadonlyArray<IUnityAnimCurveDiff>
  readonly headerChanges: ReadonlyArray<UnityAnimHeaderField>
}
