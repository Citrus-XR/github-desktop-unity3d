/**
 * Pure value-renderer widgets for the ParticleSystem Inspector: the two
 * MinMax value kinds Unity carries all over ParticleSystem
 * (`MinMaxCurve` and `MinMaxGradient`), and small primitives (`ColorSwatch`,
 * `GradientStrip`, `MinMaxCurveSparkline`) shared between them.
 *
 * Each display recognises the four Unity modes off the `minMaxState`
 * discriminator (0=Constant, 1=Curve, 2=TwoCurves, 3=TwoConstants; +4=RandomColor
 * for gradients) and picks between a scalar label, a `Random(a, b)` label,
 * and a mini visualization. In diff mode the display stacks before → after
 * horizontally, matching the rest of the Inspector's convention.
 *
 * The sparkline is a self-contained SVG that draws a Hermite-interpolated line
 * across the curve's keyframes; the CurveChart in `animation-curve-chart.tsx`
 * is not reused directly because its API assumes an `IUnityAnimCurve` with a
 * per-key diff array (semantics that don't fit MinMaxCurve).
 */

import * as React from 'react'
import { UnityPropertyValue } from '../../../models/unity/serialized-asset'
import { UnityChangeStatus } from '../../../models/unity/semantic-diff'
import { statusClass } from './inspector-fields'

const trimNumber = (value: number, digits = 3): string => {
  if (!Number.isFinite(value)) {
    return String(value)
  }
  const s = value.toFixed(digits)
  return s.replace(/\.?0+$/, '') || '0'
}

const asScalar = (value: UnityPropertyValue | null): string | undefined =>
  value !== null && value.kind === 'scalar' ? value.value : undefined

const asMap = (
  value: UnityPropertyValue | null
): ReadonlyMap<string, UnityPropertyValue> | undefined =>
  value !== null && value.kind === 'map'
    ? new Map(value.entries.map(e => [e.key, e.value]))
    : undefined

const scalarNumber = (value: UnityPropertyValue | null): number => {
  const s = asScalar(value)
  const n = s !== undefined ? Number(s) : NaN
  return Number.isFinite(n) ? n : 0
}

/** One RGBA color parsed from a Unity `{r, g, b, a}` map. */
export interface IColor {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

const readColor = (value: UnityPropertyValue | null): IColor | undefined => {
  const map = asMap(value)
  if (map === undefined) {
    return undefined
  }
  const r = scalarNumber(map.get('r') ?? null)
  const g = scalarNumber(map.get('g') ?? null)
  const b = scalarNumber(map.get('b') ?? null)
  // Alpha defaults to 1 to survive the rare serializer that drops it.
  const alphaRaw = asScalar(map.get('a') ?? null)
  const a = alphaRaw === undefined ? 1 : Number(alphaRaw)
  return {
    r,
    g,
    b,
    a: Number.isFinite(a) ? a : 1,
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

const toCss = (color: IColor, includeAlpha = true): string => {
  const to255 = (c: number) => Math.round(clamp01(c) * 255)
  return includeAlpha
    ? `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${trimNumber(
        clamp01(color.a),
        3
      )})`
    : `rgb(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)})`
}

const colorTitle = (color: IColor): string =>
  `R ${trimNumber(color.r)}  G ${trimNumber(color.g)}  B ${trimNumber(
    color.b
  )}  A ${trimNumber(color.a)}`

/** A single-color square with the RGBA tuple on hover. */
export const ColorSwatch: React.FC<{ readonly color: IColor }> = ({
  color,
}) => (
  <span
    className="unity-color-swatch"
    style={{ background: toCss(color) }}
    title={colorTitle(color)}
  />
)

/** One `key<N>` field parsed out of a MinMaxGradient. */
interface IColorKey {
  readonly color: IColor
  readonly time: number
}
interface IAlphaKey {
  readonly value: number
  readonly time: number
}

/**
 * Read a Unity MinMaxGradient map's numbered `key0..key7` + `ctime0..7` /
 * `atime0..7` (u16 [0, 65535] time) into two ordered key lists, trimmed to
 * the counts named by `m_NumColorKeys` / `m_NumAlphaKeys`. Empty when the
 * counts are missing or zero (defensive — some serializers omit them for a
 * fully-white gradient).
 */
const readGradient = (
  value: UnityPropertyValue | null
): {
  readonly colorKeys: ReadonlyArray<IColorKey>
  readonly alphaKeys: ReadonlyArray<IAlphaKey>
} | undefined => {
  const map = asMap(value)
  if (map === undefined) {
    return undefined
  }
  const numColorRaw = asScalar(map.get('m_NumColorKeys') ?? null)
  const numAlphaRaw = asScalar(map.get('m_NumAlphaKeys') ?? null)
  const numColor =
    numColorRaw !== undefined ? Math.max(0, Math.min(8, Number(numColorRaw))) : 0
  const numAlpha =
    numAlphaRaw !== undefined ? Math.max(0, Math.min(8, Number(numAlphaRaw))) : 0
  const colorKeys: IColorKey[] = []
  const alphaKeys: IAlphaKey[] = []
  for (let i = 0; i < numColor; i++) {
    const color = readColor(map.get(`key${i}`) ?? null)
    const time = scalarNumber(map.get(`ctime${i}`) ?? null) / 65535
    if (color !== undefined) {
      colorKeys.push({ color, time: clamp01(time) })
    }
  }
  for (let i = 0; i < numAlpha; i++) {
    const color = readColor(map.get(`key${i}`) ?? null)
    const time = scalarNumber(map.get(`atime${i}`) ?? null) / 65535
    if (color !== undefined) {
      alphaKeys.push({ value: color.a, time: clamp01(time) })
    }
  }
  return { colorKeys, alphaKeys }
}

/**
 * A horizontal gradient strip built from a Unity MinMaxGradient's color and
 * alpha key lists. Color is drawn opaque on top; a thinner bar underneath
 * shows alpha as grayscale so a semi-transparent gradient is still readable
 * against either theme.
 */
export const GradientStrip: React.FC<{
  readonly value: UnityPropertyValue | null
}> = ({ value }) => {
  const g = readGradient(value)
  if (g === undefined || g.colorKeys.length === 0) {
    return <span className="unity-gradient-strip is-empty" />
  }
  const sortedColor = [...g.colorKeys].sort((a, b) => a.time - b.time)
  const sortedAlpha = [...g.alphaKeys].sort((a, b) => a.time - b.time)
  const colorStops = sortedColor
    .map(k => `${toCss(k.color, false)} ${trimNumber(k.time * 100, 2)}%`)
    .join(', ')
  const alphaStops =
    sortedAlpha.length > 0
      ? sortedAlpha
          .map(k => {
            const v = Math.round(clamp01(k.value) * 255)
            return `rgb(${v}, ${v}, ${v}) ${trimNumber(k.time * 100, 2)}%`
          })
          .join(', ')
      : null
  return (
    <span className="unity-gradient-strip">
      <span
        className="unity-gradient-color"
        style={{ background: `linear-gradient(to right, ${colorStops})` }}
      />
      {alphaStops !== null ? (
        <span
          className="unity-gradient-alpha"
          style={{ background: `linear-gradient(to right, ${alphaStops})` }}
          title="Alpha"
        />
      ) : null}
    </span>
  )
}

/** One keyframe of a MinMaxCurve's `m_Curve` list. */
interface ICurveKey {
  readonly time: number
  readonly value: number
  readonly inSlope: number
  readonly outSlope: number
}

const readCurveKeys = (
  value: UnityPropertyValue | null
): ReadonlyArray<ICurveKey> | undefined => {
  const map = asMap(value)
  if (map === undefined) {
    return undefined
  }
  const seq = map.get('m_Curve')
  if (seq === undefined || seq.kind !== 'sequence') {
    return undefined
  }
  const keys: ICurveKey[] = []
  for (const item of seq.items) {
    const km = asMap(item)
    if (km === undefined) {
      continue
    }
    keys.push({
      time: scalarNumber(km.get('time') ?? null),
      value: scalarNumber(km.get('value') ?? null),
      inSlope: scalarNumber(km.get('inSlope') ?? null),
      outSlope: scalarNumber(km.get('outSlope') ?? null),
    })
  }
  return keys
}

const SPARK_W = 96
const SPARK_H = 28
const SPARK_PAD = 3
const HERMITE_STEPS = 12

const hermite = (
  p0: number,
  p1: number,
  m0: number,
  m1: number,
  t: number
): number => {
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
}

const buildSparkPath = (
  keys: ReadonlyArray<ICurveKey>,
  range: { readonly min: number; readonly max: number }
): string => {
  if (keys.length === 0) {
    return ''
  }
  const sorted = [...keys].sort((a, b) => a.time - b.time)
  const tMin = sorted[0].time
  const tMax = sorted[sorted.length - 1].time
  const tSpan = Math.max(tMax - tMin, 1e-9)
  const vSpan = Math.max(range.max - range.min, 1e-9)
  const timeToX = (t: number) =>
    SPARK_PAD + ((t - tMin) / tSpan) * (SPARK_W - SPARK_PAD * 2)
  const valueToY = (v: number) =>
    SPARK_H - SPARK_PAD - ((v - range.min) / vSpan) * (SPARK_H - SPARK_PAD * 2)
  const segments: string[] = [`M ${timeToX(sorted[0].time)} ${valueToY(sorted[0].value)}`]
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    const dt = b.time - a.time
    for (let step = 1; step <= HERMITE_STEPS; step++) {
      const u = step / HERMITE_STEPS
      const v = hermite(a.value, b.value, a.outSlope * dt, b.inSlope * dt, u)
      const t = a.time + u * dt
      segments.push(`L ${timeToX(t)} ${valueToY(v)}`)
    }
  }
  return segments.join(' ')
}

const rangeOfKeys = (
  ...keySets: ReadonlyArray<ReadonlyArray<ICurveKey> | undefined>
): { readonly min: number; readonly max: number } => {
  let min = Infinity
  let max = -Infinity
  for (const keys of keySets) {
    if (keys === undefined) {
      continue
    }
    for (const k of keys) {
      if (k.value < min) {
        min = k.value
      }
      if (k.value > max) {
        max = k.value
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 }
  }
  if (max - min < 1e-9) {
    const pad = Math.max(Math.abs(max), 1) * 0.1
    return { min: min - pad, max: max + pad }
  }
  const pad = (max - min) * 0.1
  return { min: min - pad, max: max + pad }
}

/**
 * SVG sparkline for a MinMaxCurve. When both `keys` and `secondKeys` are
 * present (TwoCurves mode) they are overlaid; the second gets a dashed
 * stroke so the pair reads as a min/max band.
 */
export const MinMaxCurveSparkline: React.FC<{
  readonly keys: ReadonlyArray<ICurveKey>
  readonly secondKeys?: ReadonlyArray<ICurveKey>
}> = ({ keys, secondKeys }) => {
  if (keys.length === 0 && (secondKeys === undefined || secondKeys.length === 0)) {
    return null
  }
  const range = rangeOfKeys(keys, secondKeys)
  const primary = buildSparkPath(keys, range)
  const secondary =
    secondKeys !== undefined ? buildSparkPath(secondKeys, range) : ''
  return (
    <svg
      className="unity-mmcurve-spark"
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      aria-hidden={true}
    >
      {primary.length > 0 ? (
        <path d={primary} fill="none" stroke="currentColor" strokeWidth={1.25} />
      ) : null}
      {secondary.length > 0 ? (
        <path
          d={secondary}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      ) : null}
    </svg>
  )
}

/** Friendly name for each `minMaxState`. */
const curveMode = (state: string | undefined): string => {
  switch (state) {
    case '0':
      return 'Constant'
    case '1':
      return 'Curve'
    case '2':
      return 'Two Curves'
    case '3':
      return 'Random Between Two Constants'
    default:
      return state ?? ''
  }
}

/**
 * Render one side of a MinMaxCurve as a friendly label + optional sparkline.
 * Mode drives the layout:
 *   0 Constant → `5`
 *   1 Curve → `Curve` + sparkline over `maxCurve`
 *   2 Two Curves → `Two Curves` + overlaid min/max sparklines
 *   3 Random Between Two Constants → `Random(0.1, 0.5)`
 */
const MinMaxCurveOneSide: React.FC<{
  readonly value: UnityPropertyValue | null
}> = ({ value }) => {
  const map = asMap(value)
  if (map === undefined) {
    return <span className="unity-mmcurve unity-mmcurve-empty">—</span>
  }
  const state = asScalar(map.get('minMaxState') ?? null)
  const scalar = scalarNumber(map.get('scalar') ?? null)
  const minScalar = scalarNumber(map.get('minScalar') ?? null)
  if (state === '0') {
    return (
      <span className="unity-mmcurve" title={`Constant · minMaxState 0`}>
        {trimNumber(scalar)}
      </span>
    )
  }
  if (state === '3') {
    return (
      <span
        className="unity-mmcurve"
        title="Random Between Two Constants · minMaxState 3"
      >
        <span className="unity-mmcurve-mode">Random</span>
        {`(${trimNumber(minScalar)}, ${trimNumber(scalar)})`}
      </span>
    )
  }
  const maxKeys = readCurveKeys(map.get('maxCurve') ?? null) ?? []
  const minKeys = readCurveKeys(map.get('minCurve') ?? null) ?? []
  const title = `${curveMode(state)} · minMaxState ${state ?? '?'}`
  return (
    <span className="unity-mmcurve" title={title}>
      <span className="unity-mmcurve-mode">{curveMode(state)}</span>
      <MinMaxCurveSparkline
        keys={maxKeys}
        secondKeys={state === '2' ? minKeys : undefined}
      />
    </span>
  )
}

/**
 * The Inspector-facing MinMaxCurve display: chooses between an unchanged
 * one-side render and a `before → after` stacked render, styled with the
 * existing status color scheme.
 */
export const MinMaxCurveDisplay: React.FC<{
  readonly status: UnityChangeStatus
  readonly before: UnityPropertyValue | null
  readonly after: UnityPropertyValue | null
}> = ({ status, before, after }) => {
  if (status === 'modified') {
    return (
      <span className="unity-mmcurve-diff">
        <span className="unity-value-before">
          <MinMaxCurveOneSide value={before} />
        </span>
        <span className="unity-mmcurve-arrow">→</span>
        <span className="unity-value-after">
          <MinMaxCurveOneSide value={after} />
        </span>
      </span>
    )
  }
  return <MinMaxCurveOneSide value={after ?? before} />
}

const gradientMode = (state: string | undefined): string => {
  switch (state) {
    case '0':
      return 'Color'
    case '1':
      return 'Gradient'
    case '2':
      return 'Two Colors'
    case '3':
      return 'Two Gradients'
    case '4':
      return 'Random Color'
    default:
      return state ?? ''
  }
}

const MinMaxGradientOneSide: React.FC<{
  readonly value: UnityPropertyValue | null
}> = ({ value }) => {
  const map = asMap(value)
  if (map === undefined) {
    return <span className="unity-mmgradient unity-mmgradient-empty">—</span>
  }
  const state = asScalar(map.get('minMaxState') ?? null)
  const title = `${gradientMode(state)} · minMaxState ${state ?? '?'}`
  const maxColor = readColor(map.get('maxColor') ?? null)
  const minColor = readColor(map.get('minColor') ?? null)
  if (state === '0') {
    return (
      <span className="unity-mmgradient" title={title}>
        {maxColor !== undefined ? <ColorSwatch color={maxColor} /> : null}
      </span>
    )
  }
  if (state === '2') {
    return (
      <span className="unity-mmgradient" title={title}>
        {minColor !== undefined ? <ColorSwatch color={minColor} /> : null}
        {maxColor !== undefined ? <ColorSwatch color={maxColor} /> : null}
      </span>
    )
  }
  if (state === '3') {
    return (
      <span className="unity-mmgradient" title={title}>
        <GradientStrip value={map.get('minGradient') ?? null} />
        <GradientStrip value={map.get('maxGradient') ?? null} />
      </span>
    )
  }
  // 1 Gradient / 4 Random Color both draw the `maxGradient` strip.
  return (
    <span className="unity-mmgradient" title={title}>
      {state === '4' ? (
        <span className="unity-mmgradient-mode">Random</span>
      ) : null}
      <GradientStrip value={map.get('maxGradient') ?? null} />
    </span>
  )
}

export const MinMaxGradientDisplay: React.FC<{
  readonly status: UnityChangeStatus
  readonly before: UnityPropertyValue | null
  readonly after: UnityPropertyValue | null
}> = ({ status, before, after }) => {
  if (status === 'modified') {
    return (
      <span className="unity-mmgradient-diff">
        <span className="unity-value-before">
          <MinMaxGradientOneSide value={before} />
        </span>
        <span className="unity-mmgradient-arrow">→</span>
        <span className="unity-value-after">
          <MinMaxGradientOneSide value={after} />
        </span>
      </span>
    )
  }
  return <MinMaxGradientOneSide value={after ?? before} />
}

/**
 * Color field renderer for plain `{r, g, b, a}` maps (i.e. NOT a MinMaxGradient
 * wrapper). Diff mode shows before → after swatches; unchanged shows a single
 * swatch.
 */
export const ColorFieldDisplay: React.FC<{
  readonly status: UnityChangeStatus
  readonly before: UnityPropertyValue | null
  readonly after: UnityPropertyValue | null
}> = ({ status, before, after }) => {
  const beforeColor = readColor(before)
  const afterColor = readColor(after)
  if (status === 'modified') {
    return (
      <span className="unity-color-diff">
        <span className="unity-value-before">
          {beforeColor !== undefined ? <ColorSwatch color={beforeColor} /> : '—'}
        </span>
        <span className="unity-color-arrow">→</span>
        <span className="unity-value-after">
          {afterColor !== undefined ? <ColorSwatch color={afterColor} /> : '—'}
        </span>
      </span>
    )
  }
  const color = afterColor ?? beforeColor
  return color !== undefined ? <ColorSwatch color={color} /> : <>—</>
}

/**
 * Enum field renderer — maps a scalar value to its friendly label, keeping
 * the raw value visible on hover so the underlying enum ordinal is still
 * discoverable.
 */
export const EnumFieldDisplay: React.FC<{
  readonly status: UnityChangeStatus
  readonly before: UnityPropertyValue | null
  readonly after: UnityPropertyValue | null
  readonly labels: ReadonlyMap<string, string>
}> = ({ status, before, after, labels }) => {
  const format = (value: UnityPropertyValue | null): string => {
    const raw = asScalar(value)
    if (raw === undefined) {
      return ''
    }
    return labels.get(raw) ?? raw
  }
  const rawTitle = (value: UnityPropertyValue | null): string =>
    asScalar(value) ?? ''
  if (status === 'modified') {
    return (
      <span className="unity-enum-diff">
        <span className="unity-value-before" title={rawTitle(before)}>
          {format(before)}
        </span>
        {' → '}
        <span className="unity-value-after" title={rawTitle(after)}>
          {format(after)}
        </span>
      </span>
    )
  }
  const value = after ?? before
  return (
    <span title={rawTitle(value)} className={statusClass(status)}>
      {format(value)}
    </span>
  )
}

/** Distribution modes exposed by Unity's ShapeModule MultiModeParameter. */
const multiModeParameterModes = new Map<string, string>([
  ['0', 'Random'],
  ['1', 'Loop'],
  ['2', 'Ping-Pong'],
  ['3', 'Burst Spread'],
])

const MultiModeParameterOneSide: React.FC<{
  readonly value: UnityPropertyValue | null
}> = ({ value }) => {
  const m = asMap(value)
  if (m === undefined) {
    return <span className="unity-mmparam-empty">—</span>
  }
  const scalarRaw = asScalar(m.get('value') ?? null)
  const mode = asScalar(m.get('mode') ?? null)
  const spread = asScalar(m.get('spread') ?? null)
  const modeLabel = multiModeParameterModes.get(mode ?? '') ?? mode ?? '?'
  const speedMap = asMap(m.get('speed') ?? null)
  const speedState = asScalar(speedMap?.get('minMaxState') ?? null)
  const parts = [`Mode: ${modeLabel}`]
  if (spread !== undefined) {
    parts.push(`Spread: ${spread}`)
  }
  if (speedState !== undefined) {
    parts.push(`Speed mode: ${speedState}`)
  }
  return (
    <span className="unity-mmparam" title={parts.join(' · ')}>
      {scalarRaw !== undefined ? trimNumber(Number(scalarRaw)) : '—'}
      {mode !== '0' ? (
        <span className="unity-mmparam-mode">{modeLabel}</span>
      ) : null}
    </span>
  )
}

/**
 * ShapeModule `MultiModeParameter` display. Unity's Inspector shows the
 * primary scalar (`value`) inline; the distribution mode / spread / speed
 * live on hover. Diff mode stacks before → after just like MinMaxCurve.
 */
export const MultiModeParameterDisplay: React.FC<{
  readonly status: UnityChangeStatus
  readonly before: UnityPropertyValue | null
  readonly after: UnityPropertyValue | null
}> = ({ status, before, after }) => {
  if (status === 'modified') {
    return (
      <span className="unity-mmparam-diff">
        <span className="unity-value-before">
          <MultiModeParameterOneSide value={before} />
        </span>
        <span className="unity-mmparam-arrow">→</span>
        <span className="unity-value-after">
          <MultiModeParameterOneSide value={after} />
        </span>
      </span>
    )
  }
  return <MultiModeParameterOneSide value={after ?? before} />
}
