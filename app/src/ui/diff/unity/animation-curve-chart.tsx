/**
 * Dopesheet lane and curve sparkline — pure SVG primitives for the friendly
 * AnimationClip viewer. Every visual is driven by a `keyDiffs` array so both
 * primitives colour keyframes by add / remove / modify / unchanged status.
 *
 * The dopesheet lane draws each keyframe as a diamond at its time along a
 * shared horizontal axis (the axis domain is decided by the parent so lanes
 * line up across the whole clip). Each diamond carries a native SVG `<title>`
 * so hovering shows the (path, attribute, time, value) — and clicking hands
 * the same info to the parent for clipboard copy.
 *
 * The curve sparkline draws a Hermite-interpolated line between adjacent keys,
 * with a step segment where either slope is non-finite (Unity's constant /
 * step interpolation). Dots at each key are colored per keyDiff. When both a
 * before curve and an after curve are provided the two lines are overlaid.
 *
 * When `playheadTime` is set (a time in the shared domain), each primitive
 * renders a vertical line at that x — matching Unity's playhead — so the user
 * has one visual anchor spanning every lane.
 */

import * as React from 'react'
import {
  IUnityAnimCurve,
  IUnityAnimKey,
  IUnityAnimKeyDiff,
} from '../../../models/unity/animation-clip'

const DIAMOND_HALF = 4
const CURVE_HEIGHT = 40
const CURVE_WIDTH = 200
const CURVE_PAD = 4
const CURVE_HERMITE_STEPS = 12
const RULER_HEIGHT = 22
const RULER_TARGET_TICK_PX = 80

/** Turn a numeric-or-symbolic slope into a number for chart math. */
const slopeAsNumber = (slope: IUnityAnimKey['inSlope']): number | undefined =>
  typeof slope === 'number' ? slope : undefined

const keyStatusClass = (status: IUnityAnimKeyDiff['status']): string =>
  `unity-anim-key unity-anim-key-${status}`

/** Which side to source a keyframe from, given a diff entry. */
export type KeySide = 'before' | 'after'

/** Payload the lane hands back when the user clicks a diamond. */
export interface IKeyClickInfo {
  readonly diffIndex: number
  readonly side: KeySide
  readonly time: number
  readonly value: IUnityAnimKey['value']
  readonly status: IUnityAnimKeyDiff['status']
}

interface IDopesheetLaneProps {
  readonly domainStart: number
  readonly domainEnd: number
  readonly beforeKeys?: ReadonlyArray<IUnityAnimKey>
  readonly afterKeys?: ReadonlyArray<IUnityAnimKey>
  readonly keyDiffs: ReadonlyArray<IUnityAnimKeyDiff>
  readonly curveStatus: IUnityAnimKeyDiff['status']
  /** Human-readable prefix passed to the native tooltip, e.g. `Rig/Head · m_LocalPosition.x`. */
  readonly tooltipPrefix: string
  /**
   * A stable identifier for the row this lane belongs to. Forwarded verbatim
   * to `onKeyClick` so the parent can look the curve up without capturing it
   * in a per-render closure (which would defeat PureComponent's shallow-prop
   * skip and force every lane to re-render on every state change).
   */
  readonly rowKey: string
  readonly onKeyClick?: (rowKey: string, info: IKeyClickInfo) => void
  readonly height?: number
  readonly width?: number
}

const timeToXFor = (
  t: number,
  domainStart: number,
  domainEnd: number,
  width: number
): number => {
  const span = Math.max(domainEnd - domainStart, 1e-9)
  return CURVE_PAD + ((t - domainStart) / span) * (width - CURVE_PAD * 2)
}

const formatKeyValue = (v: IUnityAnimKey['value']): string =>
  typeof v === 'number' ? String(+v.toFixed(6)) : v

/** A dopesheet lane: horizontal time axis with a diamond at each keyframe. */
export class DopesheetLane extends React.PureComponent<IDopesheetLaneProps, {}> {
  private onDiamondClick = (
    diffIndex: number,
    side: KeySide,
    key: IUnityAnimKey,
    status: IUnityAnimKeyDiff['status']
  ) => {
    this.props.onKeyClick?.(this.props.rowKey, {
      diffIndex,
      side,
      time: key.time,
      value: key.value,
      status,
    })
  }

  public render() {
    const width = this.props.width ?? CURVE_WIDTH
    const height = this.props.height ?? 20
    const {
      domainStart,
      domainEnd,
      keyDiffs,
      beforeKeys,
      afterKeys,
      tooltipPrefix,
    } = this.props
    const midY = height / 2
    const timeToX = (t: number): number =>
      timeToXFor(t, domainStart, domainEnd, width)

    // Cull keys well outside the current viewport — even though the SVG's
    // viewBox clips them visually, React still creates and reconciles a DOM
    // element per key. On a 1000-key curve zoomed into 5% of the clip that's
    // ~50 diamonds rendered instead of 1000.
    const span = Math.max(domainEnd - domainStart, 1e-9)
    const cullPad = span * 0.1
    const cullLo = domainStart - cullPad
    const cullHi = domainEnd + cullPad
    const inWindow = (k: IUnityAnimKey | undefined): boolean =>
      k !== undefined && k.time >= cullLo && k.time <= cullHi

    const renderDiamond = (
      key: IUnityAnimKey,
      side: KeySide,
      diffIndex: number,
      status: IUnityAnimKeyDiff['status'],
      filled: boolean
    ) => {
      const x = timeToX(key.time)
      const d = `M ${x} ${midY - DIAMOND_HALF} L ${x + DIAMOND_HALF} ${midY} L ${x} ${midY + DIAMOND_HALF} L ${x - DIAMOND_HALF} ${midY} Z`
      const className = keyStatusClass(status)
      const label = `${tooltipPrefix}\nt=${key.time.toFixed(4)}s · ${side}=${formatKeyValue(key.value)}\n(click to copy)`
      return (
        <path
          key={`${side}-${diffIndex}`}
          className={`${className} unity-anim-key-hit`}
          d={d}
          fill={filled ? 'currentColor' : 'none'}
          stroke="currentColor"
          onClick={() => this.onDiamondClick(diffIndex, side, key, status)}
        >
          <title>{label}</title>
        </path>
      )
    }

    const glyphs: React.ReactNode[] = []
    keyDiffs.forEach((diff, index) => {
      const beforeKey =
        diff.beforeIndex !== undefined ? beforeKeys?.[diff.beforeIndex] : undefined
      const afterKey =
        diff.afterIndex !== undefined ? afterKeys?.[diff.afterIndex] : undefined
      // Skip diffs whose only referenced keys sit outside the culling window.
      if (!inWindow(beforeKey) && !inWindow(afterKey)) {
        return
      }
      if (diff.status === 'modified' && beforeKey !== undefined && afterKey !== undefined) {
        const xa = timeToX(afterKey.time)
        const xb = timeToX(beforeKey.time)
        if (Math.abs(xa - xb) > 0.5) {
          glyphs.push(
            <line
              key={`bridge-${index}`}
              className={`${keyStatusClass(diff.status)} unity-anim-bridge`}
              x1={xb}
              y1={midY}
              x2={xa}
              y2={midY}
              stroke="currentColor"
              strokeWidth={1}
            />
          )
        }
        glyphs.push(renderDiamond(beforeKey, 'before', index, diff.status, false))
        glyphs.push(renderDiamond(afterKey, 'after', index, diff.status, true))
        return
      }
      if (diff.status === 'removed' && beforeKey !== undefined) {
        glyphs.push(renderDiamond(beforeKey, 'before', index, diff.status, false))
        return
      }
      if (diff.status === 'added' && afterKey !== undefined) {
        glyphs.push(renderDiamond(afterKey, 'after', index, diff.status, true))
        return
      }
      const key = afterKey ?? beforeKey
      const side: KeySide = afterKey !== undefined ? 'after' : 'before'
      if (key !== undefined) {
        glyphs.push(renderDiamond(key, side, index, diff.status, true))
      }
    })

    return (
      <svg
        className={`unity-anim-lane unity-anim-curve-${this.props.curveStatus}`}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden={true}
      >
        <line
          className="unity-anim-lane-baseline"
          x1={CURVE_PAD}
          y1={midY}
          x2={width - CURVE_PAD}
          y2={midY}
          stroke="currentColor"
          strokeWidth={1}
        />
        {glyphs}
      </svg>
    )
  }
}

interface IValueRange {
  readonly min: number
  readonly max: number
}

const numericValue = (value: IUnityAnimKey['value']): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const rangeOf = (keys: ReadonlyArray<IUnityAnimKey>): IValueRange | undefined => {
  let min = Infinity
  let max = -Infinity
  for (const k of keys) {
    const v = numericValue(k.value)
    if (v === undefined) {
      continue
    }
    if (v < min) min = v
    if (v > max) max = v
  }
  return Number.isFinite(min) ? { min, max } : undefined
}

const unionRange = (
  a: IValueRange | undefined,
  b: IValueRange | undefined
): IValueRange | undefined => {
  if (a === undefined) return b
  if (b === undefined) return a
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }
}

/**
 * Hermite basis evaluated at parameter `u` ∈ [0, 1] for a segment between
 * two keyframes with tangents scaled to the segment's time span.
 */
const hermite = (
  p0: number,
  p1: number,
  m0: number,
  m1: number,
  u: number
): number => {
  const u2 = u * u
  const u3 = u2 * u
  return (
    (2 * u3 - 3 * u2 + 1) * p0 +
    (u3 - 2 * u2 + u) * m0 +
    (-2 * u3 + 3 * u2) * p1 +
    (u3 - u2) * m1
  )
}

/**
 * Sample a curve at an arbitrary time using the same Hermite / step rules the
 * chart draws with. Returns undefined for empty curves or non-numeric PPtr
 * targets; returns the raw `value` type otherwise so callers can format PPtr
 * refs alongside numeric channels. Time before the first key clamps to the
 * first value; after the last key clamps to the last value (matches Unity's
 * default `PostInfinity` handling for constant / step curves).
 */
export const sampleCurveAt = (
  curve: IUnityAnimCurve,
  time: number
): number | string | undefined => {
  const keys = curve.keys
  if (keys.length === 0) {
    return undefined
  }
  if (curve.kind === 'pptr') {
    // Step interpolation — value holds until the next key.
    let last = keys[0].value
    for (const k of keys) {
      if (k.time > time) {
        break
      }
      last = k.value
    }
    return last
  }
  if (time <= keys[0].time) {
    return keys[0].value
  }
  if (time >= keys[keys.length - 1].time) {
    return keys[keys.length - 1].value
  }
  // Binary search would be nice; linear is fine for typical curve lengths.
  let a = keys[0]
  let b = keys[1]
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].time >= time) {
      a = keys[i - 1]
      b = keys[i]
      break
    }
  }
  const pA = numericValue(a.value)
  const pB = numericValue(b.value)
  if (pA === undefined || pB === undefined) {
    return a.value
  }
  const outA = slopeAsNumber(a.outSlope)
  const inB = slopeAsNumber(b.inSlope)
  const dt = b.time - a.time
  if (outA === undefined || inB === undefined || dt <= 0) {
    return pA
  }
  const u = (time - a.time) / dt
  return hermite(pA, pB, outA * dt, inB * dt, u)
}

interface ICurveGeometry {
  readonly path: string
  readonly points: ReadonlyArray<{ x: number; y: number }>
}

const buildCurveGeometry = (
  keys: ReadonlyArray<IUnityAnimKey>,
  domainStart: number,
  domainEnd: number,
  range: IValueRange,
  width: number,
  height: number
): ICurveGeometry => {
  const timeSpan = Math.max(domainEnd - domainStart, 1e-9)
  const valueSpan = Math.max(range.max - range.min, 1e-9)
  const timeToX = (t: number): number =>
    CURVE_PAD + ((t - domainStart) / timeSpan) * (width - CURVE_PAD * 2)
  const valueToY = (v: number): number =>
    height -
    CURVE_PAD -
    ((v - range.min) / valueSpan) * (height - CURVE_PAD * 2)

  const points: { x: number; y: number }[] = []
  for (const k of keys) {
    const v = numericValue(k.value)
    if (v !== undefined) {
      points.push({ x: timeToX(k.time), y: valueToY(v) })
    }
  }
  if (points.length === 0) {
    return { path: '', points }
  }

  const segments: string[] = [`M ${points[0].x} ${points[0].y}`]
  for (let i = 0; i < keys.length - 1; i++) {
    const kA = keys[i]
    const kB = keys[i + 1]
    const pA = numericValue(kA.value)
    const pB = numericValue(kB.value)
    if (pA === undefined || pB === undefined) {
      continue
    }
    const outA = slopeAsNumber(kA.outSlope)
    const inB = slopeAsNumber(kB.inSlope)
    const xB = timeToX(kB.time)
    const yA = valueToY(pA)
    const yB = valueToY(pB)
    if (outA === undefined || inB === undefined) {
      // Step interpolation for non-finite slopes.
      segments.push(`L ${xB} ${yA}`)
      segments.push(`L ${xB} ${yB}`)
      continue
    }
    const dt = kB.time - kA.time
    for (let step = 1; step <= CURVE_HERMITE_STEPS; step++) {
      const u = step / CURVE_HERMITE_STEPS
      const t = kA.time + u * dt
      const v = hermite(pA, pB, outA * dt, inB * dt, u)
      const x = timeToX(t)
      const y = valueToY(v)
      segments.push(`L ${x} ${y}`)
    }
  }
  return { path: segments.join(' '), points }
}

interface ICurveChartProps {
  readonly domainStart: number
  readonly domainEnd: number
  readonly before?: IUnityAnimCurve
  readonly after?: IUnityAnimCurve
  readonly keyDiffs: ReadonlyArray<IUnityAnimKeyDiff>
  readonly curveStatus: IUnityAnimKeyDiff['status']
  readonly tooltipPrefix: string
  readonly rowKey: string
  readonly onKeyClick?: (rowKey: string, info: IKeyClickInfo) => void
  readonly height?: number
  readonly width?: number
}

/** A per-curve sparkline: Hermite line + per-key dots colored by diff status. */
export class CurveChart extends React.PureComponent<ICurveChartProps, {}> {
  public render() {
    const width = this.props.width ?? CURVE_WIDTH
    const height = this.props.height ?? CURVE_HEIGHT
    const {
      before,
      after,
      keyDiffs,
      domainStart,
      domainEnd,
      curveStatus,
      tooltipPrefix,
      onKeyClick,
      rowKey,
    } = this.props

    const range = unionRange(
      before !== undefined ? rangeOf(before.keys) : undefined,
      after !== undefined ? rangeOf(after.keys) : undefined
    )

    if (range === undefined) {
      return (
        <svg
          className={`unity-anim-chart unity-anim-curve-${curveStatus}`}
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden={true}
        />
      )
    }
    const padded: IValueRange = (() => {
      if (range.max - range.min < 1e-9) {
        return { min: range.min - 1, max: range.max + 1 }
      }
      const pad = (range.max - range.min) * 0.1
      return { min: range.min - pad, max: range.max + pad }
    })()

    const beforeGeom =
      before !== undefined
        ? buildCurveGeometry(before.keys, domainStart, domainEnd, padded, width, height)
        : undefined
    const afterGeom =
      after !== undefined
        ? buildCurveGeometry(after.keys, domainStart, domainEnd, padded, width, height)
        : undefined

    const dots: React.ReactNode[] = []
    keyDiffs.forEach((diff, index) => {
      const useAfter = diff.afterIndex !== undefined && afterGeom !== undefined
      const geom = useAfter ? afterGeom : beforeGeom
      const keyIndex = useAfter ? diff.afterIndex! : diff.beforeIndex
      if (geom === undefined || keyIndex === undefined) {
        return
      }
      const pt = geom.points[keyIndex]
      if (pt === undefined) {
        return
      }
      const side: KeySide = useAfter ? 'after' : 'before'
      const key = side === 'after' ? after?.keys[keyIndex] : before?.keys[keyIndex]
      const label =
        key !== undefined
          ? `${tooltipPrefix}\nt=${key.time.toFixed(4)}s · ${side}=${formatKeyValue(key.value)}\n(click to copy)`
          : tooltipPrefix
      dots.push(
        <circle
          key={`d-${index}`}
          className={`${keyStatusClass(diff.status)} unity-anim-key-hit`}
          cx={pt.x}
          cy={pt.y}
          r={2.5}
          onClick={() => {
            if (key !== undefined) {
              onKeyClick?.(rowKey, {
                diffIndex: index,
                side,
                time: key.time,
                value: key.value,
                status: diff.status,
              })
            }
          }}
        >
          <title>{label}</title>
        </circle>
      )
    })

    return (
      <svg
        className={`unity-anim-chart unity-anim-curve-${curveStatus}`}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden={true}
      >
        {beforeGeom !== undefined && beforeGeom.path.length > 0 ? (
          <path
            className="unity-anim-line unity-anim-line-before"
            d={beforeGeom.path}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
          />
        ) : null}
        {afterGeom !== undefined && afterGeom.path.length > 0 ? (
          <path
            className="unity-anim-line unity-anim-line-after"
            d={afterGeom.path}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
          />
        ) : null}
        {dots}
      </svg>
    )
  }
}

/**
 * Pick a "nice" tick step in seconds so we land ~`RULER_TARGET_TICK_PX` apart
 * on screen. Sequence 1, 2, 5 × 10^n — the same rule human designers reach for
 * on any linear axis and what Unity's own dopesheet uses.
 */
const niceStep = (spanSeconds: number, widthPx: number): number => {
  const target = spanSeconds * (RULER_TARGET_TICK_PX / Math.max(widthPx, 1))
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)))
  const normalized = target / magnitude
  const nice =
    normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10
  return nice * magnitude
}

/** Format a tick label — seconds up to 4 digits, dropping trailing zeros. */
const formatTick = (t: number, step: number): string => {
  if (step >= 1) {
    return `${t.toFixed(0)}s`
  }
  const digits = Math.min(3, Math.max(1, -Math.floor(Math.log10(step))))
  return `${t.toFixed(digits)}s`
}

interface ITimelineRulerProps {
  readonly domainStart: number
  readonly domainEnd: number
  readonly width: number
  readonly playheadTime?: number
}

/** Time axis for the shared timeline: baseline + tick marks + second labels. */
export class TimelineRuler extends React.Component<ITimelineRulerProps, {}> {
  public render() {
    const { domainStart, domainEnd, width, playheadTime } = this.props
    const span = Math.max(domainEnd - domainStart, 1e-9)
    const usable = Math.max(width - CURVE_PAD * 2, 1)
    const step = niceStep(span, usable)
    const first = Math.ceil(domainStart / step) * step
    const timeToX = (t: number): number =>
      CURVE_PAD + ((t - domainStart) / span) * usable

    const ticks: React.ReactNode[] = []
    // Cap the tick count as a safety belt against pathologically large spans.
    for (let i = 0, t = first; i < 200 && t <= domainEnd + step * 0.5; i++, t += step) {
      const x = timeToX(t)
      ticks.push(
        <g key={i} className="unity-anim-ruler-tick">
          <line x1={x} y1={RULER_HEIGHT - 6} x2={x} y2={RULER_HEIGHT} />
          <text x={x + 2} y={RULER_HEIGHT - 8} className="unity-anim-ruler-label">
            {formatTick(t, step)}
          </text>
        </g>
      )
    }

    const playheadX =
      playheadTime !== undefined && playheadTime >= domainStart && playheadTime <= domainEnd
        ? timeToX(playheadTime)
        : null

    return (
      <svg
        className="unity-anim-ruler"
        width="100%"
        height={RULER_HEIGHT}
        viewBox={`0 0 ${width} ${RULER_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden={true}
      >
        <line
          className="unity-anim-ruler-baseline"
          x1={CURVE_PAD}
          y1={RULER_HEIGHT - 0.5}
          x2={width - CURVE_PAD}
          y2={RULER_HEIGHT - 0.5}
        />
        {ticks}
        {playheadX !== null ? (
          <>
            <line
              className="unity-anim-playhead"
              x1={playheadX}
              y1={0}
              x2={playheadX}
              y2={RULER_HEIGHT}
            />
            <text
              className="unity-anim-playhead-label"
              x={playheadX + 3}
              y={2}
              dominantBaseline="hanging"
            >
              {`${playheadTime!.toFixed(3)}s`}
            </text>
          </>
        ) : null}
      </svg>
    )
  }
}

interface IPanBarProps {
  readonly baseStart: number
  readonly baseEnd: number
  readonly viewStart: number
  readonly viewSpan: number
  readonly onViewStartChange: (viewStart: number) => void
}

interface IPanBarState {
  readonly dragging: boolean
}

/**
 * A horizontal scrubber above the ruler: shows the entire clip as a track and
 * the current viewport as a filled thumb. Drag the thumb to pan, click the
 * track to jump. Zoom is handled by the toolbar (`−` / `+` / `Fit`) — this
 * widget's job is purely pan.
 */
export class TimelinePanBar extends React.Component<IPanBarProps, IPanBarState> {
  private track: HTMLDivElement | null = null
  private dragOffsetTime = 0

  public constructor(props: IPanBarProps) {
    super(props)
    this.state = { dragging: false }
  }

  private setTrack = (el: HTMLDivElement | null) => {
    this.track = el
  }

  private baseSpan(): number {
    return Math.max(this.props.baseEnd - this.props.baseStart, 1e-9)
  }

  private clampViewStart(viewStart: number): number {
    const { baseStart, baseEnd, viewSpan } = this.props
    // Keep the viewport strictly inside the clip — no overscroll on either
    // side. Parent's clampViewport() is authoritative; this is a UI-side
    // safety belt against out-of-range values slipping through.
    const min = baseStart
    const max = Math.max(min, baseEnd - viewSpan)
    return Math.min(max, Math.max(min, viewStart))
  }

  private pxToTime(clientX: number): number {
    if (this.track === null) {
      return this.props.viewStart
    }
    const rect = this.track.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return this.props.baseStart + fraction * this.baseSpan()
  }

  private onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const t = this.pxToTime(e.clientX)
    this.dragOffsetTime = t - this.props.viewStart
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    this.setState({ dragging: true })
  }

  private onThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!this.state.dragging) {
      return
    }
    const t = this.pxToTime(e.clientX)
    this.props.onViewStartChange(this.clampViewStart(t - this.dragOffsetTime))
  }

  private onThumbPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    }
    this.setState({ dragging: false })
  }

  private onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Jump the viewport centre to the clicked time.
    const t = this.pxToTime(e.clientX)
    this.props.onViewStartChange(this.clampViewStart(t - this.props.viewSpan / 2))
  }

  public render() {
    const { baseStart, viewStart, viewSpan } = this.props
    const base = this.baseSpan()
    const leftPct = ((viewStart - baseStart) / base) * 100
    const widthPct = (viewSpan / base) * 100
    const thumbLeft = `${Math.min(100, Math.max(0, leftPct))}%`
    const thumbWidth = `${Math.min(100, Math.max(2, widthPct))}%`
    return (
      <div
        className="unity-anim-panbar"
        ref={this.setTrack}
        onClick={this.onTrackClick}
        title="Drag the highlighted range to pan · click to jump"
      >
        <div
          className={`unity-anim-panbar-thumb${this.state.dragging ? ' is-dragging' : ''}`}
          style={{ left: thumbLeft, width: thumbWidth }}
          onPointerDown={this.onThumbPointerDown}
          onPointerMove={this.onThumbPointerMove}
          onPointerUp={this.onThumbPointerUp}
          onPointerCancel={this.onThumbPointerUp}
          onClick={e => e.stopPropagation()}
        />
      </div>
    )
  }
}
