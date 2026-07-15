/**
 * Friendly AnimationClip viewer used in place of the generic property tree for
 * `!u!74` documents. Two view modes:
 *
 * - Dopesheet (default): every curve is a horizontal lane on a shared time
 *   axis. Each keyframe is a diamond, colored by its diff status
 *   (added / removed / modified / unchanged).
 * - Curves: per-curve Hermite sparkline with the same per-key coloring, and
 *   overlaid before/after lines when a curve is modified.
 *
 * The timeline (ruler + lanes/charts) shares a viewport across every curve.
 * A pan-bar above the ruler shows [viewStart, viewEnd] as a draggable thumb
 * inside the full clip range. The user zooms with `−` / `+` / `Fit` buttons
 * in the header, or with Ctrl+scroll (cursor-anchored). Shift+scroll pans;
 * plain scroll is left to the browser so the curve list still scrolls.
 *
 * A vertical playhead (Unity's cyan scrubber, matched here as a dashed line)
 * spans the ruler and every lane/chart when set. Clicking anywhere on the
 * timeline area moves the playhead; the sampled value at that time renders
 * next to each curve's attribute name. Hovering a diamond shows a native
 * tooltip with (path, attribute, time, value); clicking it copies the same
 * information to the clipboard.
 */

import * as React from 'react'
import { clipboard } from 'electron'
import {
  IUnityAnimationClip,
  IUnityAnimationClipDiff,
  IUnityAnimCurve,
  IUnityAnimCurveDiff,
  UnityAnimHeaderField,
  UnityCurveKind,
} from '../../../models/unity/animation-clip'
import { IUnityDocumentDiff } from '../../../models/unity/semantic-diff'
import {
  CurveChart,
  DopesheetLane,
  IKeyClickInfo,
  TimelinePanBar,
  TimelineRuler,
  sampleCurveAt,
} from './animation-curve-chart'
import { statusClass } from './inspector-fields'

type ViewMode = 'dopesheet' | 'curves'

interface IProps {
  readonly doc: IUnityDocumentDiff
  readonly clip: IUnityAnimationClipDiff | undefined
  readonly showUnchanged: boolean
}

interface IState {
  readonly viewMode: ViewMode
  /** Viewport left edge, in clip time (seconds). */
  readonly viewStart: number
  /** Viewport width, in clip time (seconds). */
  readonly viewSpan: number
  /** Chart area width in CSS pixels — measured with ResizeObserver. */
  readonly chartWidth: number
  /** Playhead time in clip seconds; null = no playhead shown. */
  readonly playheadTime: number | null
  /** Transient toast shown after a clipboard copy — cleared by timer. */
  readonly toast: string | null
}

const KIND_ORDER: Record<UnityCurveKind, number> = {
  position: 0,
  rotation: 1,
  euler: 2,
  scale: 3,
  float: 4,
  pptr: 5,
}

const KIND_LABEL: Record<UnityCurveKind, string> = {
  position: 'Position',
  rotation: 'Rotation',
  euler: 'Euler',
  scale: 'Scale',
  float: 'Float',
  pptr: 'PPtr',
}

const HEADER_LABEL: Record<UnityAnimHeaderField, string> = {
  sampleRate: 'Sample rate',
  wrapMode: 'Wrap mode',
  loopTime: 'Loop time',
  startTime: 'Start',
  stopTime: 'Stop',
  legacy: 'Legacy',
}

const MIN_SPAN = 1 / 240
const ZOOM_FACTOR = 1.15
const BUTTON_ZOOM_FACTOR = 1.5
const TOAST_MS = 1400

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value))

/**
 * Snap a viewport `(start, span)` back inside the clip's real time range.
 * Rules:
 * - Never show t < 0 unless the clip itself has negative-time keys (rare but
 *   legal in Unity), in which case the floor drops to `base.start`.
 * - Never show t past `base.end` — a viewport wider than the clip is capped
 *   to the clip's whole span.
 * - Preserves the intended zoom level; only clamps when the requested
 *   viewport would push past either end.
 */
const clampViewport = (
  viewStart: number,
  viewSpan: number,
  base: { readonly start: number; readonly end: number }
): { viewStart: number; viewSpan: number } => {
  const floor = Math.min(0, base.start)
  const ceiling = base.end
  const maxSpan = Math.max(ceiling - floor, 1e-9)
  const cappedSpan = Math.min(Math.max(viewSpan, MIN_SPAN), maxSpan)
  const cappedStart = clamp(viewStart, floor, ceiling - cappedSpan)
  return { viewStart: cappedStart, viewSpan: cappedSpan }
}

const anyClipOf = (
  diff: IUnityAnimationClipDiff | undefined
): IUnityAnimationClip | undefined => diff?.after ?? diff?.before

const displayName = (diff: IUnityAnimationClipDiff | undefined): string =>
  anyClipOf(diff)?.name ?? ''

const curveRowOf = (
  curve: IUnityAnimCurveDiff
): { path: string; attribute: string; label: string } => {
  const c = curve.after ?? curve.before
  if (c === undefined) {
    return { path: '', attribute: '', label: '' }
  }
  const attribute =
    c.channel !== undefined ? `${c.attribute}.${c.channel}` : c.attribute
  const kindLabel = KIND_LABEL[c.kind]
  return {
    path: c.path.length === 0 ? '(root)' : c.path,
    attribute,
    label: `${kindLabel} · ${attribute}`,
  }
}

const compareCurves = (a: IUnityAnimCurveDiff, b: IUnityAnimCurveDiff): number => {
  const ac = a.after ?? a.before
  const bc = b.after ?? b.before
  if (ac === undefined || bc === undefined) {
    return 0
  }
  if (ac.path !== bc.path) {
    return ac.path.localeCompare(bc.path)
  }
  const dk = KIND_ORDER[ac.kind] - KIND_ORDER[bc.kind]
  if (dk !== 0) {
    return dk
  }
  if (ac.attribute !== bc.attribute) {
    return ac.attribute.localeCompare(bc.attribute)
  }
  const ach = ac.channel ?? ''
  const bch = bc.channel ?? ''
  return ach.localeCompare(bch)
}

/**
 * Auto-fit domain: the tightest range that still shows every keyframe plus a
 * hair of padding on each end. Falls back to `[startTime, stopTime]` when the
 * clip has no keys, and always returns a non-degenerate span.
 */
const fitDomain = (
  diff: IUnityAnimationClipDiff
): { start: number; end: number } => {
  let start = Infinity
  let end = -Infinity
  const consider = (clip: IUnityAnimationClip | undefined) => {
    if (clip === undefined) {
      return
    }
    for (const c of clip.curves) {
      for (const k of c.keys) {
        if (k.time < start) start = k.time
        if (k.time > end) end = k.time
      }
    }
  }
  consider(diff.before)
  consider(diff.after)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    const fallback = diff.after ?? diff.before
    if (fallback !== undefined) {
      return { start: fallback.startTime, end: Math.max(fallback.stopTime, fallback.startTime + 1) }
    }
    return { start: 0, end: 1 }
  }
  if (end - start < 1e-9) {
    return { start, end: start + 1 }
  }
  // Symmetric 2% pad, but never dip below zero when the clip has no negative
  // keys — the user has explicitly said "don't show negative time".
  const pad = (end - start) * 0.02
  const paddedStart = start < 0 ? start - pad : Math.max(0, start - pad)
  return { start: paddedStart, end: end + pad }
}

const formatNumber = (n: number, digits = 3): string => {
  if (!Number.isFinite(n)) {
    return String(n)
  }
  const s = n.toFixed(digits)
  return s.replace(/\.?0+$/, '') || '0'
}

const formatSample = (v: number | string | undefined): string => {
  if (v === undefined) {
    return '—'
  }
  return typeof v === 'number' ? formatNumber(v, 4) : v
}

const formatDisplayValue = (v: number | string): string =>
  typeof v === 'number' ? formatNumber(v) : v

const headerLine = (
  clip: IUnityAnimationClip | undefined,
  headerChanges: ReadonlyArray<UnityAnimHeaderField>,
  before: IUnityAnimationClip | undefined,
  after: IUnityAnimationClip | undefined
): React.ReactNode => {
  if (clip === undefined) {
    return null
  }
  const duration = clip.stopTime - clip.startTime
  const parts: React.ReactNode[] = [
    <span key="duration">Duration <b>{formatNumber(duration)}s</b></span>,
    <span key="rate">Sample <b>{clip.sampleRate}Hz</b></span>,
    <span key="loop">
      Loop <b>{clip.loopTime ? 'on' : 'off'}</b>
    </span>,
  ]
  if (clip.legacy) {
    parts.push(<span key="legacy">Legacy</span>)
  }
  if (headerChanges.length > 0 && before !== undefined && after !== undefined) {
    const changes = headerChanges.map(field => {
      const beforeValue = before[field]
      const afterValue = after[field]
      return (
        <span
          key={field}
          className="unity-anim-header-change unity-status-modified"
        >
          {HEADER_LABEL[field]}
          {': '}
          <s>{String(beforeValue)}</s>
          {' → '}
          <b>{String(afterValue)}</b>
        </span>
      )
    })
    parts.push(...changes)
  }
  return <div className="unity-anim-header-meta">{parts}</div>
}

interface IGroupedRow {
  readonly path: string
  readonly rows: ReadonlyArray<IUnityAnimCurveDiff>
}

const groupCurvesByPath = (
  curves: ReadonlyArray<IUnityAnimCurveDiff>
): ReadonlyArray<IGroupedRow> => {
  const order: string[] = []
  const byPath = new Map<string, IUnityAnimCurveDiff[]>()
  for (const curve of curves) {
    const { path } = curveRowOf(curve)
    let bucket = byPath.get(path)
    if (bucket === undefined) {
      bucket = []
      byPath.set(path, bucket)
      order.push(path)
    }
    bucket.push(curve)
  }
  return order.map(path => ({
    path,
    rows: byPath.get(path)!.slice().sort(compareCurves),
  }))
}

export class AnimationClipInspector extends React.Component<IProps, IState> {
  private chartArea: HTMLDivElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private fitDomainCache: {
    readonly fileId: string
    readonly domain: { start: number; end: number }
  } | null = null
  /** See `onViewStartChange`. */
  private pendingViewStart: number | null = null
  private viewStartRafId: number | null = null
  /** Same story for the playhead — scrubbing fires pointermove many times a frame. */
  private pendingPlayhead: number | null = null
  private playheadRafId: number | null = null
  private scrubbing: boolean = false
  /** Lookup of curveDiff by key for the stable onKeyClick callback. */
  private curveByKey: ReadonlyMap<string, IUnityAnimCurveDiff> = new Map()

  public constructor(props: IProps) {
    super(props)
    const initial = props.clip !== undefined ? fitDomain(props.clip) : { start: 0, end: 1 }
    const base = props.clip !== undefined ? initial : { start: 0, end: 1 }
    const clamped = clampViewport(initial.start, initial.end - initial.start, base)
    this.state = {
      viewMode: 'dopesheet',
      viewStart: clamped.viewStart,
      viewSpan: clamped.viewSpan,
      chartWidth: 600,
      playheadTime: null,
      toast: null,
    }
  }

  public componentDidMount() {
    if (typeof ResizeObserver !== 'undefined' && this.chartArea !== null) {
      this.resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          const width = entry.contentRect.width
          if (width > 0 && Math.abs(width - this.state.chartWidth) > 0.5) {
            this.setState({ chartWidth: width })
          }
        }
      })
      this.resizeObserver.observe(this.chartArea)
    }
    this.chartArea?.addEventListener('wheel', this.handleWheel, { passive: false })
    // Global up-listener so releasing the mouse outside the timeline also
    // ends a scrub drag — otherwise letting go over the panbar or the
    // header would leave `scrubbing` stuck true.
    document.addEventListener('pointerup', this.onScrubEnd)
    document.addEventListener('pointercancel', this.onScrubEnd)
    this.rebuildCurveIndex()
  }

  public componentDidUpdate(prevProps: IProps) {
    if (prevProps.clip?.fileId !== this.props.clip?.fileId && this.props.clip !== undefined) {
      const d = this.fitDomainOf(this.props.clip)
      const clamped = clampViewport(d.start, d.end - d.start, d)
      this.setState({
        viewStart: clamped.viewStart,
        viewSpan: clamped.viewSpan,
        playheadTime: null,
      })
    }
    if (prevProps.clip !== this.props.clip) {
      this.rebuildCurveIndex()
    }
  }

  private rebuildCurveIndex() {
    const map = new Map<string, IUnityAnimCurveDiff>()
    for (const c of this.props.clip?.curves ?? []) {
      map.set(c.key, c)
    }
    this.curveByKey = map
  }

  public componentWillUnmount() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.chartArea?.removeEventListener('wheel', this.handleWheel)
    document.removeEventListener('pointerup', this.onScrubEnd)
    document.removeEventListener('pointercancel', this.onScrubEnd)
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
    }
    if (this.viewStartRafId !== null) {
      cancelAnimationFrame(this.viewStartRafId)
      this.viewStartRafId = null
    }
    if (this.playheadRafId !== null) {
      cancelAnimationFrame(this.playheadRafId)
      this.playheadRafId = null
    }
  }

  private fitDomainOf(
    diff: IUnityAnimationClipDiff
  ): { start: number; end: number } {
    if (this.fitDomainCache?.fileId === diff.fileId) {
      return this.fitDomainCache.domain
    }
    const domain = fitDomain(diff)
    this.fitDomainCache = { fileId: diff.fileId, domain }
    return domain
  }

  private setChartArea = (el: HTMLDivElement | null) => {
    if (this.chartArea !== null && this.chartArea !== el) {
      this.chartArea.removeEventListener('wheel', this.handleWheel)
    }
    this.chartArea = el
  }

  private onSelectDopesheet = () => this.setState({ viewMode: 'dopesheet' })
  private onSelectCurves = () => this.setState({ viewMode: 'curves' })

  private onResetZoom = () => {
    if (this.props.clip === undefined) {
      return
    }
    const d = this.fitDomainOf(this.props.clip)
    const clamped = clampViewport(d.start, d.end - d.start, d)
    this.setState({ viewStart: clamped.viewStart, viewSpan: clamped.viewSpan })
  }

  private zoomBy(factor: number) {
    if (this.props.clip === undefined) {
      return
    }
    const base = this.fitDomainOf(this.props.clip)
    const { viewStart, viewSpan, playheadTime } = this.state
    // Zoom around the playhead if it's in view, otherwise the viewport centre.
    const anchor =
      playheadTime !== null && playheadTime >= viewStart && playheadTime <= viewStart + viewSpan
        ? playheadTime
        : viewStart + viewSpan / 2
    const anchorFraction = (anchor - viewStart) / viewSpan
    const desiredSpan = viewSpan * factor
    const clamped = clampViewport(anchor - anchorFraction * desiredSpan, desiredSpan, base)
    this.setState({ viewStart: clamped.viewStart, viewSpan: clamped.viewSpan })
  }

  private onZoomIn = () => this.zoomBy(1 / BUTTON_ZOOM_FACTOR)
  private onZoomOut = () => this.zoomBy(BUTTON_ZOOM_FACTOR)

  private handleWheel = (e: WheelEvent) => {
    if (this.props.clip === undefined || this.chartArea === null) {
      return
    }
    const wantsZoom = e.ctrlKey || e.metaKey
    const wantsPan = e.shiftKey || (e.deltaX !== 0 && Math.abs(e.deltaX) > Math.abs(e.deltaY))
    if (!wantsZoom && !wantsPan) {
      return
    }
    e.preventDefault()

    const rect = this.chartArea.getBoundingClientRect()
    const { viewStart, viewSpan } = this.state
    const base = this.fitDomainOf(this.props.clip)

    if (wantsPan) {
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY
      const panFraction = delta / Math.max(rect.width, 1)
      const clamped = clampViewport(viewStart + panFraction * viewSpan, viewSpan, base)
      this.setState({ viewStart: clamped.viewStart, viewSpan: clamped.viewSpan })
      return
    }

    const cursorPx = clamp(e.clientX - rect.left, 0, rect.width)
    const cursorFraction = rect.width > 0 ? cursorPx / rect.width : 0.5
    const timeAtCursor = viewStart + cursorFraction * viewSpan
    const factor = e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR
    const desiredSpan = viewSpan * factor
    const clamped = clampViewport(
      timeAtCursor - cursorFraction * desiredSpan,
      desiredSpan,
      base
    )
    this.setState({ viewStart: clamped.viewStart, viewSpan: clamped.viewSpan })
  }

  private onViewStartChange = (viewStart: number) => {
    // Coalesce rapid pan-drag updates: keep only the latest requested value
    // and commit it once per animation frame, clamped to the clip range.
    if (this.props.clip !== undefined) {
      const base = this.fitDomainOf(this.props.clip)
      const clamped = clampViewport(viewStart, this.state.viewSpan, base)
      this.pendingViewStart = clamped.viewStart
    } else {
      this.pendingViewStart = viewStart
    }
    if (this.viewStartRafId !== null) {
      return
    }
    this.viewStartRafId = requestAnimationFrame(() => {
      this.viewStartRafId = null
      if (this.pendingViewStart !== null) {
        const next = this.pendingViewStart
        this.pendingViewStart = null
        this.setState({ viewStart: next })
      }
    })
  }

  /** Turn a client-x on the chart area into a domain time. */
  private timeAtClientX(clientX: number): number | null {
    if (this.chartArea === null) {
      return null
    }
    const rect = this.chartArea.getBoundingClientRect()
    // Use clientWidth (excludes the vertical-scrollbar strip) so a click at
    // the right edge of the content area lands on the actual clip end time,
    // not slightly past it.
    const usable = this.chartArea.clientWidth || rect.width
    const fraction = clamp((clientX - rect.left) / usable, 0, 1)
    return this.state.viewStart + fraction * this.state.viewSpan
  }

  /**
   * True when the pointer is over the vertical scrollbar strip on the right
   * edge of the timeline container. `getBoundingClientRect().width` includes
   * the scrollbar; `clientWidth` doesn't — the delta is exactly the scrollbar
   * strip, so anything past `left + clientWidth` is scrollbar territory and
   * should not start a playhead scrub.
   */
  private pointerOverScrollbar(clientX: number): boolean {
    if (this.chartArea === null) {
      return false
    }
    const rect = this.chartArea.getBoundingClientRect()
    return clientX > rect.left + this.chartArea.clientWidth
  }

  /**
   * Commit a playhead time — coalesces multiple pointermove events into one
   * setState per frame so scrubbing stays smooth even on large scenes.
   */
  private schedulePlayhead(time: number) {
    this.pendingPlayhead = time
    if (this.playheadRafId !== null) {
      return
    }
    this.playheadRafId = requestAnimationFrame(() => {
      this.playheadRafId = null
      if (this.pendingPlayhead !== null) {
        const next = this.pendingPlayhead
        this.pendingPlayhead = null
        this.setState({ playheadTime: next })
      }
    })
  }

  /**
   * Timeline pointerdown starts a scrub drag: sets the playhead immediately
   * and every pointermove until pointerup updates it. Clicks on diamonds are
   * skipped so the click-to-copy still works.
   */
  private onScrubStart = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore anything but the primary (left) button — right-click / middle
    // shouldn't move the playhead, and it also skips synthetic touch clicks
    // that come with a non-zero button.
    if (e.button !== 0) {
      return
    }
    if (this.pointerOverScrollbar(e.clientX)) {
      return
    }
    const target = e.target as Element
    if (target.classList.contains('unity-anim-key-hit')) {
      return
    }
    if (target.closest('.unity-anim-panbar')) {
      // Let the panbar own its own pointer events; it has its own drag.
      return
    }
    const t = this.timeAtClientX(e.clientX)
    if (t === null) {
      return
    }
    this.scrubbing = true
    this.schedulePlayhead(t)
  }

  private onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!this.scrubbing) {
      return
    }
    if (this.pointerOverScrollbar(e.clientX)) {
      return
    }
    const t = this.timeAtClientX(e.clientX)
    if (t !== null) {
      this.schedulePlayhead(t)
    }
  }

  private onScrubEnd = () => {
    this.scrubbing = false
  }

  /**
   * Stable click callback for every diamond in every lane. Receiving a
   * `rowKey` (rather than a captured `curveDiff` closure) is what lets the
   * lane's `onKeyClick` prop stay reference-stable across parent renders,
   * which is required for the PureComponent shallow-prop skip to actually
   * kick in during panbar / zoom.
   */
  private onKeyClick = (rowKey: string, info: IKeyClickInfo) => {
    const curve = this.curveByKey.get(rowKey)
    if (curve === undefined) {
      return
    }
    const c = info.side === 'after' ? curve.after : curve.before
    if (c === undefined) {
      return
    }
    const attribute =
      c.channel !== undefined ? `${c.attribute}.${c.channel}` : c.attribute
    const path = c.path.length === 0 ? '(root)' : c.path
    const value =
      typeof info.value === 'number' ? String(+info.value.toFixed(6)) : info.value
    const text = `${path} · ${attribute} @ ${info.time.toFixed(4)}s = ${value} (${info.side})`
    clipboard.writeText(text)
    this.showToast(`Copied: ${text}`)
  }

  private showToast(message: string) {
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
    }
    this.setState({ toast: message })
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null
      this.setState({ toast: null })
    }, TOAST_MS)
  }

  public render() {
    const { doc, clip, showUnchanged } = this.props
    const displayClip = anyClipOf(clip)
    const title = displayName(clip) || doc.typeName || 'AnimationClip'
    const status = clip?.status ?? 'unchanged'

    if (clip === undefined || displayClip === undefined) {
      return (
        <div className="unity-anim-inspector">
          <h2 className="unity-inspector-title">
            <span className={statusClass(status)}>{title}</span>
          </h2>
          <div className="unity-diff-message">
            AnimationClip data not available.
          </div>
        </div>
      )
    }

    const rawCurves = clip.curves
    const visibleCurves = showUnchanged
      ? rawCurves
      : rawCurves.filter(c => c.status !== 'unchanged')
    const groups = groupCurvesByPath(visibleCurves)
    const domainStart = this.state.viewStart
    const domainEnd = this.state.viewStart + this.state.viewSpan
    const chartWidth = this.state.chartWidth
    const base = this.fitDomainOf(clip)
    const playheadTime = this.state.playheadTime

    return (
      <div className="unity-anim-inspector">
        <h2 className="unity-inspector-title">
          <span className={statusClass(status)}>{title}</span>
        </h2>
        <div className="unity-anim-header">
          {headerLine(displayClip, clip.headerChanges, clip.before, clip.after)}
          <div className="unity-anim-header-controls">
            <div className="unity-anim-zoom-group" role="group" aria-label="Timeline zoom">
              <button
                className="unity-anim-icon-btn"
                onClick={this.onZoomOut}
                title="Zoom out"
                aria-label="Zoom out"
              >−</button>
              <button
                className="unity-anim-icon-btn"
                onClick={this.onZoomIn}
                title="Zoom in"
                aria-label="Zoom in"
              >+</button>
              <button
                className="unity-anim-icon-btn"
                onClick={this.onResetZoom}
                title="Fit the whole clip in the timeline"
              >Fit</button>
            </div>
            <div className="unity-anim-view-toggle" role="tablist">
              <button
                role="tab"
                aria-selected={this.state.viewMode === 'dopesheet'}
                className={
                  this.state.viewMode === 'dopesheet' ? 'is-active' : undefined
                }
                onClick={this.onSelectDopesheet}
              >
                Dopesheet
              </button>
              <button
                role="tab"
                aria-selected={this.state.viewMode === 'curves'}
                className={
                  this.state.viewMode === 'curves' ? 'is-active' : undefined
                }
                onClick={this.onSelectCurves}
              >
                Curves
              </button>
            </div>
          </div>
        </div>
        {groups.length === 0 ? (
          <div className="unity-diff-message">
            {showUnchanged
              ? 'This clip has no animated properties.'
              : 'No changed curves. Toggle "Show unchanged" to see the full clip.'}
          </div>
        ) : (
          <div
            className="unity-anim-timeline"
            ref={this.setChartArea}
            onPointerDown={this.onScrubStart}
            onPointerMove={this.onScrubMove}
            title="Click / drag to move playhead · Ctrl+scroll to zoom · Shift+scroll to pan"
          >
            <div className="unity-anim-panbar-wrap">
              <TimelinePanBar
                baseStart={base.start}
                baseEnd={base.end}
                viewStart={this.state.viewStart}
                viewSpan={this.state.viewSpan}
                onViewStartChange={this.onViewStartChange}
              />
            </div>
            <div className="unity-anim-ruler-wrap">
              <TimelineRuler
                domainStart={domainStart}
                domainEnd={domainEnd}
                width={chartWidth}
                playheadTime={playheadTime ?? undefined}
              />
            </div>
            <div className="unity-anim-body">
              {groups.map(group =>
                this.renderGroup(group, domainStart, domainEnd, chartWidth, playheadTime)
              )}
            </div>
            {playheadTime !== null &&
             playheadTime >= domainStart &&
             playheadTime <= domainEnd ? (
              <div
                className="unity-anim-playhead-overlay"
                style={{
                  left: `${
                    ((playheadTime - domainStart) / (domainEnd - domainStart)) *
                    100
                  }%`,
                }}
              />
            ) : null}
          </div>
        )}
        {this.state.toast !== null ? (
          <div className="unity-anim-toast" role="status">{this.state.toast}</div>
        ) : null}
      </div>
    )
  }

  private renderGroup(
    group: IGroupedRow,
    domainStart: number,
    domainEnd: number,
    chartWidth: number,
    playheadTime: number | null
  ) {
    return (
      <div className="unity-anim-group" key={group.path}>
        <div className="unity-anim-group-path">{group.path}</div>
        <ul className="unity-anim-rows">
          {group.rows.map(curve =>
            this.renderRow(curve, domainStart, domainEnd, chartWidth, playheadTime)
          )}
        </ul>
      </div>
    )
  }

  private renderRow(
    curve: IUnityAnimCurveDiff,
    domainStart: number,
    domainEnd: number,
    chartWidth: number,
    playheadTime: number | null
  ) {
    const { attribute, path } = curveRowOf(curve)
    const displayCurve: IUnityAnimCurve | undefined = curve.after ?? curve.before
    const summary = displayCurve !== undefined ? this.summaryOf(curve, displayCurve) : ''
    const sampled = displayCurve !== undefined && playheadTime !== null
      ? sampleCurveAt(displayCurve, playheadTime)
      : undefined
    const tooltipPrefix = `${path} · ${attribute}`
    return (
      <li
        className={`unity-anim-row ${statusClass(curve.status)}`}
        key={curve.key}
      >
        <div className="unity-anim-row-head">
          <span className={`unity-anim-pill ${statusClass(curve.status)}`}>
            {curve.status}
          </span>
          <span className="unity-anim-attr">{attribute}</span>
          {playheadTime !== null ? (
            <span className="unity-anim-current-value" title="Sampled value at the playhead">
              = <b>{formatSample(sampled)}</b>
            </span>
          ) : null}
          <span className="unity-anim-summary">{summary}</span>
        </div>
        <div className="unity-anim-row-chart">
          {this.state.viewMode === 'dopesheet' ? (
            <DopesheetLane
              domainStart={domainStart}
              domainEnd={domainEnd}
              width={chartWidth}
              beforeKeys={curve.before?.keys}
              afterKeys={curve.after?.keys}
              keyDiffs={curve.keyDiffs}
              curveStatus={curve.status}
              tooltipPrefix={tooltipPrefix}
              rowKey={curve.key}
              onKeyClick={this.onKeyClick}
            />
          ) : (
            <CurveChart
              domainStart={domainStart}
              domainEnd={domainEnd}
              width={chartWidth}
              before={curve.before}
              after={curve.after}
              keyDiffs={curve.keyDiffs}
              curveStatus={curve.status}
              tooltipPrefix={tooltipPrefix}
              rowKey={curve.key}
              onKeyClick={this.onKeyClick}
            />
          )}
        </div>
      </li>
    )
  }

  private summaryOf(
    diff: IUnityAnimCurveDiff,
    curve: IUnityAnimCurve
  ): string {
    const added = diff.keyDiffs.filter(k => k.status === 'added').length
    const removed = diff.keyDiffs.filter(k => k.status === 'removed').length
    const modified = diff.keyDiffs.filter(k => k.status === 'modified').length
    const total = curve.keys.length
    const parts: string[] = [`${total} keys`]
    if (added > 0) {
      parts.push(`+${added}`)
    }
    if (removed > 0) {
      parts.push(`−${removed}`)
    }
    if (modified > 0) {
      parts.push(`~${modified}`)
    }
    if (curve.keys.length > 0) {
      const first = curve.keys[0]
      const last = curve.keys[curve.keys.length - 1]
      parts.push(`${formatNumber(first.time)}s → ${formatNumber(last.time)}s`)
      if (curve.kind === 'pptr') {
        parts.push(`ref ${formatDisplayValue(last.value)}`)
      }
    }
    return parts.join(' · ')
  }
}
