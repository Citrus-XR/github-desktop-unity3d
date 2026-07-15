/**
 * Pannable, zoomable SVG graph canvas for the AnimatorController viewer.
 * Nodes are placed at the raw `m_Position` coordinates Unity itself uses in
 * the Animator window, so the layout matches. Interactions:
 *
 * - Wheel over the canvas → zoom around the cursor.
 * - Left-drag on empty space → pan.
 * - Click a state → parent picks it up via `onSelectNode(fileId)`.
 * - Double-click a sub-state-machine → parent pushes to its drill-down path.
 * - "Fit" button (owned by the parent) resets pan/zoom to frame everything.
 *
 * Perf model: nodes and edges are individual PureComponents keyed by fileId
 * with prop-stable callbacks; pan/zoom setState is RAF-throttled; nodes /
 * edges whose bounding boxes fall outside the viewport (plus buffer) are
 * skipped at the render level so a 100-state controller stays interactive.
 */

import * as React from 'react'
import {
  IUnityAnimatorController,
  IUnityAnimPosition,
  IUnityAnimStateMachine,
  UnityAnimEntityStatus,
} from '../../../models/unity/animator-controller'
import { UnityFileId } from '../../../models/unity/serialized-asset'

const NODE_WIDTH = 140
const NODE_HEIGHT = 34
/** Special nodes (Any State / Entry / Exit) render as the same rectangle
 *  shape as regular states, but wear their role's fill color. This matches
 *  the "everything is a box" affordance Unity moved to in recent versions. */
const SPECIAL_WIDTH = NODE_WIDTH
const SPECIAL_HEIGHT = NODE_HEIGHT
const MIN_ZOOM = 0.15
const MAX_ZOOM = 4
const ZOOM_STEP = 1.15
const CULL_MARGIN = 200

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

export interface IAnimatorGraphSelection {
  readonly kind: 'state' | 'stateMachine' | 'transition' | 'special'
  readonly fileId: UnityFileId
}

export interface IAnimatorGraphProps {
  readonly controller: IUnityAnimatorController
  /** Which state machine's contents are currently visible (drill-down target). */
  readonly currentStateMachineFileId: UnityFileId
  /** Per-entity status for coloring. Missing = 'unchanged'. */
  readonly statusByFileId: ReadonlyMap<UnityFileId, UnityAnimEntityStatus>
  /**
   * When set, only nodes / edges whose fileId is in this set render. Special
   * nodes (Entry / Exit / AnyState) always render. Used by the enclosing
   * inspector to hide unchanged parts of the graph while ShowUnchanged is off.
   */
  readonly visibleFileIds: ReadonlySet<UnityFileId> | null
  /** Selected node/edge fileId, or null. */
  readonly selectedFileId: UnityFileId | null
  readonly onSelect: (selection: IAnimatorGraphSelection | null) => void
  /** Fired when the user double-clicks a sub-state-machine node. */
  readonly onEnterStateMachine: (fileId: UnityFileId) => void
}

interface IAnimatorGraphState {
  readonly panX: number
  readonly panY: number
  readonly zoom: number
  readonly containerWidth: number
  readonly containerHeight: number
  /** Which "session" of fit-recentering we're on; used to force refits on drill-down. */
  readonly fitToken: number
}

interface INodeGeometry {
  readonly kind: 'state' | 'child-sm' | 'entry' | 'exit' | 'anystate'
  readonly fileId: UnityFileId
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly label: string
  readonly status: UnityAnimEntityStatus
  readonly isDefault: boolean
}

interface IEdgeGeometry {
  readonly fileId: UnityFileId
  readonly sourceCenter: { x: number; y: number }
  readonly targetCenter: { x: number; y: number }
  readonly status: UnityAnimEntityStatus
  /** 0-based offset used to fan out overlapping edges between the same pair. */
  readonly fanIndex: number
  readonly fanCount: number
  /** True for the implicit Entry→default arrow Unity draws by convention. */
  readonly synthetic: boolean
}

const posOf = (p: IUnityAnimPosition): { x: number; y: number } => ({ x: p.x, y: p.y })

const centerOfNode = (node: INodeGeometry): { x: number; y: number } => ({
  x: node.x + node.width / 2,
  y: node.y + node.height / 2,
})

/** Build the geometry for every node visible in the given state machine. */
const collectNodes = (
  controller: IUnityAnimatorController,
  sm: IUnityAnimStateMachine,
  statusByFileId: ReadonlyMap<UnityFileId, UnityAnimEntityStatus>,
  visibleFileIds: ReadonlySet<UnityFileId> | null
): ReadonlyArray<INodeGeometry> => {
  const out: INodeGeometry[] = []
  const isVisible = (id: UnityFileId): boolean =>
    visibleFileIds === null || visibleFileIds.has(id)
  // Special nodes first so they sit "behind" states in DOM order (states
  // paint on top when they overlap).
  const special = (
    kind: 'entry' | 'exit' | 'anystate',
    fileId: UnityFileId,
    pos: { x: number; y: number },
    label: string
  ): INodeGeometry => ({
    kind,
    fileId,
    x: pos.x,
    y: pos.y,
    width: SPECIAL_WIDTH,
    height: SPECIAL_HEIGHT,
    label,
    status: 'unchanged',
    isDefault: false,
  })
  out.push(special('entry', `${sm.fileId}#entry`, posOf(sm.entryPos), 'Entry'))
  out.push(special('exit', `${sm.fileId}#exit`, posOf(sm.exitPos), 'Exit'))
  out.push(special('anystate', `${sm.fileId}#anystate`, posOf(sm.anyStatePos), 'Any State'))

  // Regular state nodes: only the ones that live in THIS state machine.
  for (const stateId of sm.stateFileIds) {
    if (!isVisible(stateId)) continue
    const state = controller.states.get(stateId)
    if (state === undefined) {
      continue
    }
    out.push({
      kind: 'state',
      fileId: state.fileId,
      x: state.position.x,
      y: state.position.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      label: state.name,
      status: statusByFileId.get(state.fileId) ?? 'unchanged',
      isDefault: sm.defaultStateFileId === state.fileId,
    })
  }

  // Child sub-state-machines rendered as slightly wider rounded rects.
  for (const child of sm.childStateMachines) {
    if (!isVisible(child.fileId)) continue
    const childSM = controller.stateMachines.get(child.fileId)
    out.push({
      kind: 'child-sm',
      fileId: child.fileId,
      x: child.position.x,
      y: child.position.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      label: childSM?.name ?? '(State Machine)',
      status: statusByFileId.get(child.fileId) ?? 'unchanged',
      isDefault: false,
    })
  }

  return out
}

/**
 * Build the geometry for every edge visible in the given state machine. Edges
 * come from three sources: state.m_Transitions, sm.m_AnyStateTransitions,
 * sm.m_EntryTransitions. Only edges whose SOURCE node is in the current SM's
 * node set render (destinations may point into other layers, in which case
 * we drop the edge; a proper cross-SM view would need drill-down).
 */
const collectEdges = (
  controller: IUnityAnimatorController,
  sm: IUnityAnimStateMachine,
  nodesByFileId: ReadonlyMap<UnityFileId, INodeGeometry>,
  statusByFileId: ReadonlyMap<UnityFileId, UnityAnimEntityStatus>,
  visibleFileIds: ReadonlySet<UnityFileId> | null
): ReadonlyArray<IEdgeGeometry> => {
  const isVisible = (id: UnityFileId): boolean =>
    visibleFileIds === null || visibleFileIds.has(id)
  const raw: {
    fileId: string
    sourceFileId: string
    targetFileId: string
    status: UnityAnimEntityStatus
    synthetic: boolean
  }[] = []

  const pushTransition = (sourceFileId: string, transitionId: string) => {
    if (!isVisible(transitionId)) return
    const t = controller.transitions.get(transitionId)
    if (t === undefined) {
      return
    }
    let targetFileId: string | undefined
    if (t.isExit) {
      targetFileId = `${sm.fileId}#exit`
    } else if (t.dstStateFileId !== undefined && t.dstStateFileId !== '0') {
      targetFileId = t.dstStateFileId
    } else if (t.dstStateMachineFileId !== undefined && t.dstStateMachineFileId !== '0') {
      targetFileId = t.dstStateMachineFileId
    }
    if (targetFileId === undefined) {
      return
    }
    if (!nodesByFileId.has(sourceFileId) || !nodesByFileId.has(targetFileId)) {
      return
    }
    raw.push({
      fileId: t.fileId,
      sourceFileId,
      targetFileId,
      status: statusByFileId.get(t.fileId) ?? 'unchanged',
      synthetic: false,
    })
  }

  for (const stateId of sm.stateFileIds) {
    const state = controller.states.get(stateId)
    if (state === undefined) continue
    for (const tid of state.transitionFileIds) pushTransition(state.fileId, tid)
  }
  const anyId = `${sm.fileId}#anystate`
  for (const tid of sm.anyStateTransitionFileIds) pushTransition(anyId, tid)
  const entryId = `${sm.fileId}#entry`
  for (const tid of sm.entryTransitionFileIds) pushTransition(entryId, tid)

  // Unity draws an implicit arrow from Entry to the state machine's default
  // state whether or not there's an explicit entry transition. Keep the arrow
  // so the reader can see where playback starts.
  if (sm.defaultStateFileId !== undefined && sm.defaultStateFileId !== '0') {
    if (nodesByFileId.has(entryId) && nodesByFileId.has(sm.defaultStateFileId)) {
      raw.push({
        fileId: `${sm.fileId}#defaultEntry`,
        sourceFileId: entryId,
        targetFileId: sm.defaultStateFileId,
        status: 'unchanged',
        synthetic: true,
      })
    }
  }

  // Fan out edges that share the same (source, target) pair so they don't
  // stack invisibly on top of each other.
  const byPair = new Map<string, number>()
  const pairKey = (a: string, b: string): string => `${a} ${b}`
  const pairIndex = new Map<string, number>()
  for (const r of raw) {
    const k = pairKey(r.sourceFileId, r.targetFileId)
    byPair.set(k, (byPair.get(k) ?? 0) + 1)
  }
  const out: IEdgeGeometry[] = []
  for (const r of raw) {
    const k = pairKey(r.sourceFileId, r.targetFileId)
    const idx = pairIndex.get(k) ?? 0
    pairIndex.set(k, idx + 1)
    const source = nodesByFileId.get(r.sourceFileId)!
    const target = nodesByFileId.get(r.targetFileId)!
    out.push({
      fileId: r.fileId,
      sourceCenter: centerOfNode(source),
      targetCenter: centerOfNode(target),
      status: r.status,
      fanIndex: idx,
      fanCount: byPair.get(k) ?? 1,
      synthetic: r.synthetic,
    })
  }
  return out
}

/**
 * Compute a cubic-Bezier path from source to target. Perpendicular fan-out
 * offsets the control point so overlapping edges spread apart.
 */
const edgePath = (edge: IEdgeGeometry): string => {
  const { sourceCenter: s, targetCenter: t, fanIndex, fanCount } = edge
  const dx = t.x - s.x
  const dy = t.y - s.y
  const len = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-6)
  // Perpendicular unit vector (rotate (dx,dy)/len by 90°).
  const px = -dy / len
  const py = dx / len
  // Fan spread: 0 for the middle transition, ± up to (fanCount-1)/2 * step.
  const step = 22
  const offset = (fanIndex - (fanCount - 1) / 2) * step
  const cx = (s.x + t.x) / 2 + px * offset
  const cy = (s.y + t.y) / 2 + py * offset
  return `M ${s.x} ${s.y} Q ${cx} ${cy} ${t.x} ${t.y}`
}

/** Arrowhead position: a hair short of the target center along the curve tangent. */
const arrowheadAt = (edge: IEdgeGeometry): {
  x: number
  y: number
  angle: number
} => {
  const { targetCenter: t, sourceCenter: s, fanIndex, fanCount } = edge
  const dx = t.x - s.x
  const dy = t.y - s.y
  const len = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-6)
  const px = -dy / len
  const py = dx / len
  const step = 22
  const offset = (fanIndex - (fanCount - 1) / 2) * step
  const cx = (s.x + t.x) / 2 + px * offset
  const cy = (s.y + t.y) / 2 + py * offset
  // Tangent at u=1 of a quadratic Bezier is 2*(t - c).
  const tx = 2 * (t.x - cx)
  const ty = 2 * (t.y - cy)
  const angle = Math.atan2(ty, tx) * (180 / Math.PI)
  return { x: t.x, y: t.y, angle }
}

const statusClassFor = (status: UnityAnimEntityStatus): string =>
  `unity-anim-graph-status-${status}`

interface IGraphNodeProps {
  readonly node: INodeGeometry
  readonly selected: boolean
  readonly onSelect: (fileId: UnityFileId) => void
  readonly onEnterStateMachine: (fileId: UnityFileId) => void
}

class GraphNode extends React.PureComponent<IGraphNodeProps, {}> {
  private onClick = (e: React.MouseEvent<SVGElement>) => {
    e.stopPropagation()
    this.props.onSelect(this.props.node.fileId)
  }
  private onDoubleClick = (e: React.MouseEvent<SVGElement>) => {
    if (this.props.node.kind === 'child-sm') {
      e.stopPropagation()
      this.props.onEnterStateMachine(this.props.node.fileId)
    }
  }

  public render() {
    const { node, selected } = this.props
    const status = statusClassFor(node.status)
    const cx = node.x + node.width / 2
    const cy = node.y + node.height / 2

    if (node.kind === 'entry' || node.kind === 'exit' || node.kind === 'anystate') {
      const cls = `unity-anim-graph-special unity-anim-graph-special-${node.kind}${
        selected ? ' is-selected' : ''
      }`
      return (
        <g className={cls} onClick={this.onClick}>
          <rect
            x={node.x}
            y={node.y}
            rx={5}
            ry={5}
            width={node.width}
            height={node.height}
          />
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
            {node.label}
          </text>
        </g>
      )
    }

    const cls = [
      'unity-anim-graph-node',
      `unity-anim-graph-node-${node.kind}`,
      status,
      node.isDefault ? 'is-default' : '',
      selected ? 'is-selected' : '',
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <g className={cls} onClick={this.onClick} onDoubleClick={this.onDoubleClick}>
        <rect
          x={node.x}
          y={node.y}
          rx={node.kind === 'child-sm' ? 12 : 5}
          ry={node.kind === 'child-sm' ? 12 : 5}
          width={node.width}
          height={node.height}
        />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
          {node.label || '(unnamed)'}
        </text>
      </g>
    )
  }
}

interface IGraphEdgeProps {
  readonly edge: IEdgeGeometry
  readonly selected: boolean
  readonly onSelect: (fileId: UnityFileId) => void
}

class GraphEdge extends React.PureComponent<IGraphEdgeProps, {}> {
  private onClick = (e: React.MouseEvent<SVGElement>) => {
    e.stopPropagation()
    this.props.onSelect(this.props.edge.fileId)
  }

  public render() {
    const { edge, selected } = this.props
    const status = statusClassFor(edge.status)
    const d = edgePath(edge)
    const head = arrowheadAt(edge)
    const cls = `unity-anim-graph-edge ${status}${selected ? ' is-selected' : ''}${
      edge.synthetic ? ' is-synthetic' : ''
    }`
    return (
      <g className={cls} onClick={this.onClick}>
        {/* Wide invisible stroke for the click hit-area. */}
        <path d={d} className="unity-anim-graph-edge-hit" fill="none" />
        <path d={d} className="unity-anim-graph-edge-line" fill="none" />
        <polygon
          className="unity-anim-graph-edge-head"
          points="-9,-5 0,0 -9,5"
          transform={`translate(${head.x} ${head.y}) rotate(${head.angle})`}
        />
      </g>
    )
  }
}

export class AnimatorGraph extends React.Component<
  IAnimatorGraphProps,
  IAnimatorGraphState
> {
  private container: HTMLDivElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private pendingPan: { x: number; y: number } | null = null
  private pendingZoom: number | null = null
  private rafId: number | null = null
  private panning: boolean = false
  private panStart: { clientX: number; clientY: number; panX: number; panY: number } | null = null

  public constructor(props: IAnimatorGraphProps) {
    super(props)
    this.state = {
      panX: 60,
      panY: 60,
      zoom: 1,
      containerWidth: 800,
      containerHeight: 500,
      fitToken: 0,
    }
  }

  public componentDidMount() {
    if (typeof ResizeObserver !== 'undefined' && this.container !== null) {
      this.resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          const w = entry.contentRect.width
          const h = entry.contentRect.height
          if (w > 0 && h > 0) {
            const dx = Math.abs(w - this.state.containerWidth)
            const dy = Math.abs(h - this.state.containerHeight)
            if (dx > 0.5 || dy > 0.5) {
              this.setState({ containerWidth: w, containerHeight: h })
            }
          }
        }
      })
      this.resizeObserver.observe(this.container)
    }
    this.container?.addEventListener('wheel', this.onWheel, { passive: false })
    document.addEventListener('pointerup', this.onPanEnd)
    document.addEventListener('pointercancel', this.onPanEnd)
    this.fitToCurrent()
  }

  public componentDidUpdate(prev: IAnimatorGraphProps) {
    if (
      prev.currentStateMachineFileId !== this.props.currentStateMachineFileId ||
      prev.controller !== this.props.controller
    ) {
      this.fitToCurrent()
    }
  }

  public componentWillUnmount() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.container?.removeEventListener('wheel', this.onWheel)
    document.removeEventListener('pointerup', this.onPanEnd)
    document.removeEventListener('pointercancel', this.onPanEnd)
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
    }
  }

  /** Frame the current state machine's contents inside the viewport. */
  public fitToCurrent = () => {
    const { controller, currentStateMachineFileId, statusByFileId } = this.props
    const sm = controller.stateMachines.get(currentStateMachineFileId)
    if (sm === undefined || this.container === null) {
      return
    }
    const nodes = collectNodes(controller, sm, statusByFileId, this.props.visibleFileIds)
    if (nodes.length === 0) {
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of nodes) {
      if (n.x < minX) minX = n.x
      if (n.y < minY) minY = n.y
      if (n.x + n.width > maxX) maxX = n.x + n.width
      if (n.y + n.height > maxY) maxY = n.y + n.height
    }
    const bboxW = Math.max(maxX - minX, 1)
    const bboxH = Math.max(maxY - minY, 1)
    const pad = 60
    const availW = Math.max(this.state.containerWidth - pad * 2, 1)
    const availH = Math.max(this.state.containerHeight - pad * 2, 1)
    const zoom = clamp(Math.min(availW / bboxW, availH / bboxH), MIN_ZOOM, MAX_ZOOM)
    const panX = pad + (availW - bboxW * zoom) / 2 - minX * zoom
    const panY = pad + (availH - bboxH * zoom) / 2 - minY * zoom
    this.setState({ panX, panY, zoom })
  }

  private setContainer = (el: HTMLDivElement | null) => {
    if (this.container !== null && this.container !== el) {
      this.container.removeEventListener('wheel', this.onWheel)
    }
    this.container = el
  }

  private schedulePanZoom(next: { panX?: number; panY?: number; zoom?: number }) {
    if (next.panX !== undefined || next.panY !== undefined) {
      this.pendingPan = {
        x: next.panX ?? this.pendingPan?.x ?? this.state.panX,
        y: next.panY ?? this.pendingPan?.y ?? this.state.panY,
      }
    }
    if (next.zoom !== undefined) {
      this.pendingZoom = next.zoom
    }
    if (this.rafId !== null) {
      return
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      const nextState: {
        panX?: number
        panY?: number
        zoom?: number
      } = {}
      if (this.pendingPan !== null) {
        nextState.panX = this.pendingPan.x
        nextState.panY = this.pendingPan.y
        this.pendingPan = null
      }
      if (this.pendingZoom !== null) {
        nextState.zoom = this.pendingZoom
        this.pendingZoom = null
      }
      this.setState(nextState as unknown as IAnimatorGraphState)
    })
  }

  private onWheel = (e: WheelEvent) => {
    if (this.container === null) {
      return
    }
    e.preventDefault()
    const rect = this.container.getBoundingClientRect()
    const cursorX = e.clientX - rect.left
    const cursorY = e.clientY - rect.top
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const nextZoom = clamp(this.state.zoom * factor, MIN_ZOOM, MAX_ZOOM)
    // Anchor: keep the world-space point under the cursor fixed.
    const worldX = (cursorX - this.state.panX) / this.state.zoom
    const worldY = (cursorY - this.state.panY) / this.state.zoom
    const panX = cursorX - worldX * nextZoom
    const panY = cursorY - worldY * nextZoom
    this.schedulePanZoom({ panX, panY, zoom: nextZoom })
  }

  private onPanStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const isLeft = e.button === 0
    const isRight = e.button === 2
    if (!isLeft && !isRight) return

    if (isLeft) {
      const target = e.target as Element
      // Left click on a node / edge selects it — the SVG child stops
      // propagation on its own click, so we only see the empty-space case
      // here. Filter defensively anyway.
      if (target.closest('.unity-anim-graph-node, .unity-anim-graph-edge, .unity-anim-graph-special')) {
        return
      }
      // Left-click-drag on empty space clears the current selection.
      this.props.onSelect(null)
    }
    // Right-click-drag pans from ANYWHERE, over nodes included, and NEVER
    // clears the selection. Matches Unity's own middle-drag pan gesture but
    // uses the right button because we can suppress its default context
    // menu whereas middle-click isn't reliably delivered by every mouse.
    this.panning = true
    this.panStart = {
      clientX: e.clientX,
      clientY: e.clientY,
      panX: this.state.panX,
      panY: this.state.panY,
    }
  }

  private onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    // Right button is our pan gesture — never surface the browser context menu.
    e.preventDefault()
  }

  private onPanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!this.panning || this.panStart === null) return
    const dx = e.clientX - this.panStart.clientX
    const dy = e.clientY - this.panStart.clientY
    this.schedulePanZoom({
      panX: this.panStart.panX + dx,
      panY: this.panStart.panY + dy,
    })
  }

  private onPanEnd = () => {
    this.panning = false
    this.panStart = null
  }

  public render() {
    const { controller, currentStateMachineFileId, statusByFileId, selectedFileId, onSelect, onEnterStateMachine } = this.props
    const sm = controller.stateMachines.get(currentStateMachineFileId)
    if (sm === undefined) {
      return (
        <div className="unity-anim-graph" ref={this.setContainer}>
          <div className="unity-diff-message">State machine not found.</div>
        </div>
      )
    }
    const { panX, panY, zoom, containerWidth, containerHeight } = this.state
    const nodes = collectNodes(controller, sm, statusByFileId, this.props.visibleFileIds)
    const nodesByFileId = new Map<UnityFileId, INodeGeometry>()
    for (const n of nodes) nodesByFileId.set(n.fileId, n)
    const edges = collectEdges(
      controller,
      sm,
      nodesByFileId,
      statusByFileId,
      this.props.visibleFileIds
    )

    // Viewport in world coordinates for culling.
    const viewportWorldLeft = -panX / zoom - CULL_MARGIN
    const viewportWorldTop = -panY / zoom - CULL_MARGIN
    const viewportWorldRight = (containerWidth - panX) / zoom + CULL_MARGIN
    const viewportWorldBottom = (containerHeight - panY) / zoom + CULL_MARGIN
    const nodeInViewport = (n: INodeGeometry): boolean =>
      n.x + n.width >= viewportWorldLeft &&
      n.x <= viewportWorldRight &&
      n.y + n.height >= viewportWorldTop &&
      n.y <= viewportWorldBottom
    const edgeInViewport = (e: IEdgeGeometry): boolean => {
      const minX = Math.min(e.sourceCenter.x, e.targetCenter.x)
      const maxX = Math.max(e.sourceCenter.x, e.targetCenter.x)
      const minY = Math.min(e.sourceCenter.y, e.targetCenter.y)
      const maxY = Math.max(e.sourceCenter.y, e.targetCenter.y)
      return (
        maxX >= viewportWorldLeft &&
        minX <= viewportWorldRight &&
        maxY >= viewportWorldTop &&
        minY <= viewportWorldBottom
      )
    }

    const visibleNodes = nodes.filter(nodeInViewport)
    const visibleEdges = edges.filter(edgeInViewport)

    return (
      <div
        className={`unity-anim-graph${this.panning ? ' is-panning' : ''}`}
        ref={this.setContainer}
        onPointerDown={this.onPanStart}
        onPointerMove={this.onPanMove}
        onContextMenu={this.onContextMenu}
      >
        <svg
          className="unity-anim-graph-svg"
          width="100%"
          height="100%"
        >
          <g transform={`translate(${panX} ${panY}) scale(${zoom})`}>
            {/* Edges first so nodes paint on top. */}
            {visibleEdges.map(e => (
              <GraphEdge
                key={e.fileId}
                edge={e}
                selected={e.fileId === selectedFileId}
                onSelect={fid => onSelect({ kind: 'transition', fileId: fid })}
              />
            ))}
            {visibleNodes.map(n => (
              <GraphNode
                key={n.fileId}
                node={n}
                selected={n.fileId === selectedFileId}
                onSelect={fid => {
                  if (n.kind === 'child-sm') {
                    onSelect({ kind: 'stateMachine', fileId: fid })
                  } else if (n.kind === 'state') {
                    onSelect({ kind: 'state', fileId: fid })
                  } else {
                    onSelect({ kind: 'special', fileId: fid })
                  }
                }}
                onEnterStateMachine={onEnterStateMachine}
              />
            ))}
          </g>
        </svg>
      </div>
    )
  }
}
