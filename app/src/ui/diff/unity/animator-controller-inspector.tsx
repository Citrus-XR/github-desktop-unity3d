/**
 * Friendly AnimatorController viewer used in place of the generic property
 * tree for `.controller` files. Owns the layer switching, sub-state-machine
 * drill-down path, and current selection; delegates the actual node graph to
 * `AnimatorGraph`.
 *
 * Layout:
 *   [Title]
 *   [Layer tabs] · [ Fit ][ Parameters ]
 *   [Breadcrumbs: Base Layer › Combat › Attack]
 *   +--------+---+------------+---+--------+
 *   | Params | ↔ | Graph      | ↔ | Detail |
 *   +--------+---+------------+---+--------+
 *
 * ShowUnchanged: when off, the graph is filtered to the changed entities plus
 * the complete Entry-to-change path plus one hop forward from every changed
 * transition — so a reader always sees where a change plugs into the flow.
 */

import * as React from 'react'
import { clipboard } from 'electron'
import {
  IUnityAnimatorController,
  IUnityAnimatorControllerDiff,
  IUnityAnimCondition,
  IUnityAnimParameter,
  IUnityAnimParamDiff,
  IUnityAnimState,
  IUnityAnimStateMachine,
  IUnityAnimTransition,
  UnityAnimEntityStatus,
} from '../../../models/unity/animator-controller'
import {
  IUnityResolvedGuid,
  IUnitySemanticDiffResult,
} from '../../../models/unity/semantic-diff'
import { UnityFileId } from '../../../models/unity/serialized-asset'
import { AnimatorGraph, IAnimatorGraphSelection } from './animator-graph'
import { statusClass } from './inspector-fields'

interface IProps {
  readonly result: IUnitySemanticDiffResult
  readonly controllerDiff: IUnityAnimatorControllerDiff
  readonly showUnchanged: boolean
}

interface IState {
  readonly activeLayerIndex: number
  /** Stack of state-machine fileIds for drill-down; top = currently rendered SM. */
  readonly stateMachinePath: ReadonlyArray<UnityFileId>
  readonly selection: IAnimatorGraphSelection | null
  readonly parametersOpen: boolean
  readonly toast: string | null
  readonly paramsWidth: number
  readonly detailWidth: number
}

const CONDITION_MODE_LABEL: Record<number, string> = {
  1: 'If',
  2: 'IfNot',
  3: '>',
  4: '<',
  6: '==',
  7: '≠',
}

const TOAST_MS = 1400
const PANEL_MIN_WIDTH = 160
const PANEL_MAX_WIDTH = 520

const currentController = (
  diff: IUnityAnimatorControllerDiff
): IUnityAnimatorController | undefined => diff.after ?? diff.before

/** Build a fileId → status lookup covering every entity the graph can show. */
const buildStatusMap = (
  diff: IUnityAnimatorControllerDiff
): ReadonlyMap<UnityFileId, UnityAnimEntityStatus> => {
  const out = new Map<UnityFileId, UnityAnimEntityStatus>()
  for (const s of diff.states) out.set(s.fileId, s.status)
  for (const t of diff.transitions) out.set(t.fileId, t.status)
  for (const sm of diff.stateMachines) out.set(sm.fileId, sm.status)
  return out
}

const formatNumber = (n: number, digits = 3): string => {
  if (!Number.isFinite(n)) return String(n)
  const s = n.toFixed(digits)
  return s.replace(/\.?0+$/, '') || '0'
}

/** Resolve a cross-file GUID to its repository path, or undefined. */
const pathForGuid = (
  resolved: ReadonlyArray<IUnityResolvedGuid>,
  guid: string | undefined
): string | undefined => {
  if (guid === undefined) return undefined
  for (const r of resolved) {
    if (r.guid === guid) return r.path
  }
  return undefined
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

/**
 * Compute the "relevant" state / transition fileIds to render when
 * ShowUnchanged is off. Rule:
 *   1. Seed with every changed state and every changed transition, plus both
 *      endpoints of each changed transition (so a changed edge always has
 *      both boxes to hang between).
 *   2. Walk backward from every relevant state through the reversed
 *      transition graph, marking each incoming transition + its source state
 *      — this guarantees a visible path from Entry (via the default arrow or
 *      an explicit entry transition) to every change.
 *   3. Also walk one hop forward from each changed transition's destination
 *      so an "the transition now reroutes to X" edit shows X too.
 */
const computeRelevantFileIds = (
  controller: IUnityAnimatorController,
  sm: IUnityAnimStateMachine,
  statusByFileId: ReadonlyMap<UnityFileId, UnityAnimEntityStatus>
): ReadonlySet<UnityFileId> => {
  const isChanged = (id: UnityFileId): boolean => {
    const s = statusByFileId.get(id)
    return s !== undefined && s !== 'unchanged'
  }

  const currentSmStates = new Set(sm.stateFileIds)
  // Only transitions rooted in the current state machine are drawable — Any
  // State / Entry / state-outbound. Others belong to other SMs.
  const relevantTransitionIds = new Set<UnityFileId>()
  for (const stateId of sm.stateFileIds) {
    const state = controller.states.get(stateId)
    if (state === undefined) continue
    for (const tid of state.transitionFileIds) relevantTransitionIds.add(tid)
  }
  for (const tid of sm.anyStateTransitionFileIds) relevantTransitionIds.add(tid)
  for (const tid of sm.entryTransitionFileIds) relevantTransitionIds.add(tid)

  // Build (state -> incoming transitions) and (state -> outgoing transitions)
  // indices over the transitions that belong to this SM.
  interface ITxRef {
    readonly transitionFileId: UnityFileId
    readonly otherEndpoint: UnityFileId
  }
  const incoming = new Map<UnityFileId, ITxRef[]>()
  const outgoing = new Map<UnityFileId, ITxRef[]>()
  const pushInto = (map: Map<UnityFileId, ITxRef[]>, k: UnityFileId, v: ITxRef) => {
    let list = map.get(k)
    if (list === undefined) {
      list = []
      map.set(k, list)
    }
    list.push(v)
  }
  const transitionsWithOwner: {
    fileId: UnityFileId
    source: UnityFileId
    target: UnityFileId | undefined
  }[] = []
  for (const tid of relevantTransitionIds) {
    const t = controller.transitions.get(tid)
    if (t === undefined) continue
    const source = t.ownerFileId
    let target: UnityFileId | undefined
    if (t.isExit) target = `${sm.fileId}#exit`
    else if (t.dstStateFileId !== undefined && t.dstStateFileId !== '0') {
      target = t.dstStateFileId
    } else if (
      t.dstStateMachineFileId !== undefined &&
      t.dstStateMachineFileId !== '0'
    ) {
      target = t.dstStateMachineFileId
    }
    transitionsWithOwner.push({ fileId: tid, source, target })
    if (target !== undefined) {
      pushInto(incoming, target, { transitionFileId: tid, otherEndpoint: source })
      pushInto(outgoing, source, { transitionFileId: tid, otherEndpoint: target })
    }
  }
  // Implicit Entry→default arrow — treat as a synthetic transition (no fileId
  // in the changed set, but it participates in path walks).
  const entryId = `${sm.fileId}#entry`
  if (
    sm.defaultStateFileId !== undefined &&
    sm.defaultStateFileId !== '0' &&
    currentSmStates.has(sm.defaultStateFileId)
  ) {
    pushInto(incoming, sm.defaultStateFileId, {
      transitionFileId: `${sm.fileId}#defaultEntry`,
      otherEndpoint: entryId,
    })
  }

  const relevant = new Set<UnityFileId>()

  const markState = (id: UnityFileId) => {
    if (currentSmStates.has(id)) relevant.add(id)
  }
  const markChildSM = (id: UnityFileId) => {
    if (sm.childStateMachines.some(c => c.fileId === id)) relevant.add(id)
  }

  // Seed: every changed state / child-SM in this SM, plus both endpoints of
  // every changed transition rooted here.
  for (const stateId of sm.stateFileIds) {
    if (isChanged(stateId)) markState(stateId)
  }
  for (const child of sm.childStateMachines) {
    if (isChanged(child.fileId)) markChildSM(child.fileId)
  }
  const changedTransitions: {
    fileId: UnityFileId
    source: UnityFileId
    target: UnityFileId | undefined
  }[] = []
  for (const t of transitionsWithOwner) {
    if (isChanged(t.fileId)) {
      relevant.add(t.fileId)
      markState(t.source)
      markChildSM(t.source)
      if (t.target !== undefined) {
        markState(t.target)
        markChildSM(t.target)
      }
      changedTransitions.push(t)
    }
  }

  // Step 2: backward path from every relevant state to Entry.
  const stack: UnityFileId[] = [...relevant]
  while (stack.length > 0) {
    const at = stack.pop()!
    const incs = incoming.get(at)
    if (incs === undefined) continue
    for (const inc of incs) {
      if (!relevant.has(inc.transitionFileId)) {
        relevant.add(inc.transitionFileId)
      }
      // Source may be a state, child-SM, entry, or anystate. Only push real
      // states / child-SMs; special nodes are always shown by the graph.
      if (currentSmStates.has(inc.otherEndpoint) && !relevant.has(inc.otherEndpoint)) {
        relevant.add(inc.otherEndpoint)
        stack.push(inc.otherEndpoint)
      } else if (
        sm.childStateMachines.some(c => c.fileId === inc.otherEndpoint) &&
        !relevant.has(inc.otherEndpoint)
      ) {
        relevant.add(inc.otherEndpoint)
        stack.push(inc.otherEndpoint)
      }
    }
  }

  // Step 3: one hop forward from every changed transition's destination.
  for (const t of changedTransitions) {
    if (t.target === undefined) continue
    const outs = outgoing.get(t.target)
    if (outs === undefined) continue
    for (const out of outs) {
      relevant.add(out.transitionFileId)
      markState(out.otherEndpoint)
      markChildSM(out.otherEndpoint)
    }
  }

  return relevant
}

const paramsEqualDefault = (
  a: IUnityAnimParameter,
  b: IUnityAnimParameter
): boolean =>
  a.type === b.type &&
  a.defaultFloat === b.defaultFloat &&
  a.defaultInt === b.defaultInt &&
  a.defaultBool === b.defaultBool

const paramValueGlyph = (p: IUnityAnimParameter): React.ReactNode => {
  if (p.type === 9) {
    // Trigger: hollow circle for the resting state, filled when the default
    // is set to true (rare but legal).
    return <span className="unity-anim-glyph">{p.defaultBool ? '●' : '○'}</span>
  }
  if (p.type === 4) {
    return <span className="unity-anim-glyph">{p.defaultBool ? '☑' : '☐'}</span>
  }
  if (p.type === 3) {
    return <span className="unity-anim-num">{p.defaultInt}</span>
  }
  return <span className="unity-anim-num">{formatNumber(p.defaultFloat)}</span>
}

/**
 * Render one value node, or a strike-through before → bold after pair when
 * the two sides differ. `equal` is the caller's own equality — used because
 * some types compare loosely (strings) and some strictly (numbers with
 * epsilon).
 */
const diffNode = <T,>(
  before: T | undefined,
  after: T | undefined,
  equal: (a: T, b: T) => boolean,
  format: (v: T) => React.ReactNode
): React.ReactNode => {
  if (before === undefined && after === undefined) return null
  if (before === undefined) return <b className="unity-value-after">{format(after!)}</b>
  if (after === undefined) return <s className="unity-value-before">{format(before)}</s>
  if (equal(before, after)) return format(after)
  return (
    <>
      <s className="unity-value-before">{format(before)}</s>
      {' → '}
      <b className="unity-value-after">{format(after)}</b>
    </>
  )
}

const strEq = (a: string, b: string): boolean => a === b
const numEq = (a: number, b: number): boolean => a === b
const boolEq = (a: boolean, b: boolean): boolean => a === b

export class AnimatorControllerInspector extends React.Component<IProps, IState> {
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private graphRef = React.createRef<AnimatorGraph>()
  private splitterDrag: {
    which: 'params' | 'detail'
    startX: number
    startWidth: number
  } | null = null

  public constructor(props: IProps) {
    super(props)
    const controller = currentController(props.controllerDiff)
    const initialLayer = controller?.layers[0]
    this.state = {
      activeLayerIndex: 0,
      stateMachinePath: initialLayer !== undefined ? [initialLayer.stateMachineFileId] : [],
      selection: null,
      parametersOpen: false,
      toast: null,
      paramsWidth: 240,
      detailWidth: 280,
    }
  }

  public componentWillUnmount() {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    document.removeEventListener('pointermove', this.onSplitterMove)
    document.removeEventListener('pointerup', this.onSplitterEnd)
  }

  public componentDidUpdate(prev: IProps) {
    if (prev.controllerDiff.fileId !== this.props.controllerDiff.fileId) {
      const controller = currentController(this.props.controllerDiff)
      const layer = controller?.layers[0]
      this.setState({
        activeLayerIndex: 0,
        stateMachinePath: layer !== undefined ? [layer.stateMachineFileId] : [],
        selection: null,
      })
    }
  }

  private onSelectLayer = (index: number) => {
    const controller = currentController(this.props.controllerDiff)
    const layer = controller?.layers[index]
    if (layer === undefined) return
    this.setState({
      activeLayerIndex: index,
      stateMachinePath: [layer.stateMachineFileId],
      selection: null,
    })
  }

  private onEnterStateMachine = (fileId: UnityFileId) => {
    this.setState(s => ({
      stateMachinePath: [...s.stateMachinePath, fileId],
      selection: null,
    }))
  }

  private onBreadcrumbClick = (depth: number) => {
    this.setState(s => ({
      stateMachinePath: s.stateMachinePath.slice(0, depth + 1),
      selection: null,
    }))
  }

  private onSelectionChange = (selection: IAnimatorGraphSelection | null) => {
    this.setState({ selection })
  }

  private onFit = () => {
    this.graphRef.current?.fitToCurrent()
  }

  private onToggleParameters = () => {
    this.setState(s => ({ parametersOpen: !s.parametersOpen }))
  }

  private copy = (text: string) => {
    clipboard.writeText(text)
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.setState({ toast: `Copied: ${text}` })
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null
      this.setState({ toast: null })
    }, TOAST_MS)
  }

  private onSplitterStart = (which: 'params' | 'detail') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      this.splitterDrag = {
        which,
        startX: e.clientX,
        startWidth: which === 'params' ? this.state.paramsWidth : this.state.detailWidth,
      }
      document.addEventListener('pointermove', this.onSplitterMove)
      document.addEventListener('pointerup', this.onSplitterEnd)
    }

  private onSplitterMove = (e: PointerEvent) => {
    if (this.splitterDrag === null) return
    const dx = e.clientX - this.splitterDrag.startX
    // Params grip sits at the RIGHT edge of the params panel (delta positive
    // = wider). Detail grip sits at the LEFT edge of the detail panel (delta
    // positive = narrower). Reverse the sign for detail.
    const raw =
      this.splitterDrag.which === 'params'
        ? this.splitterDrag.startWidth + dx
        : this.splitterDrag.startWidth - dx
    const w = clamp(raw, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH)
    if (this.splitterDrag.which === 'params') {
      this.setState({ paramsWidth: w })
    } else {
      this.setState({ detailWidth: w })
    }
  }

  private onSplitterEnd = () => {
    this.splitterDrag = null
    document.removeEventListener('pointermove', this.onSplitterMove)
    document.removeEventListener('pointerup', this.onSplitterEnd)
  }

  public render() {
    const { controllerDiff, showUnchanged } = this.props
    const controller = currentController(controllerDiff)
    if (controller === undefined) {
      return (
        <div className="unity-anim-controller">
          <div className="unity-diff-message">Controller unavailable.</div>
        </div>
      )
    }
    const status = controllerDiff.status
    const statusByFileId = buildStatusMap(controllerDiff)
    const path = this.state.stateMachinePath
    const currentSMId = path[path.length - 1]
    const currentSM = currentSMId !== undefined
      ? controller.stateMachines.get(currentSMId)
      : undefined

    const visibleFileIds =
      !showUnchanged && currentSM !== undefined
        ? computeRelevantFileIds(controller, currentSM, statusByFileId)
        : null

    const paramsW = this.state.paramsWidth
    const detailW = this.state.detailWidth

    return (
      <div className="unity-anim-controller">
        <h2 className="unity-inspector-title">
          <span className={statusClass(status)}>
            {controller.name || '(AnimatorController)'}
          </span>
        </h2>
        {this.renderLayerToolbar(controller, controllerDiff)}
        {this.renderBreadcrumbs(controller, path)}
        <div className="unity-anim-controller-body">
          {this.state.parametersOpen ? (
            <>
              <div
                className="unity-anim-controller-params"
                style={{ flex: `0 0 ${paramsW}px` }}
              >
                {this.renderParameters(controllerDiff, showUnchanged)}
              </div>
              <div
                className="unity-anim-controller-splitter"
                onPointerDown={this.onSplitterStart('params')}
                title="Drag to resize"
              />
            </>
          ) : null}
          <div className="unity-anim-controller-graph-wrap">
            {currentSM !== undefined ? (
              <AnimatorGraph
                ref={this.graphRef}
                controller={controller}
                currentStateMachineFileId={currentSM.fileId}
                statusByFileId={statusByFileId}
                visibleFileIds={visibleFileIds}
                selectedFileId={this.state.selection?.fileId ?? null}
                onSelect={this.onSelectionChange}
                onEnterStateMachine={this.onEnterStateMachine}
              />
            ) : (
              <div className="unity-diff-message">Empty layer.</div>
            )}
          </div>
          <div
            className="unity-anim-controller-splitter"
            onPointerDown={this.onSplitterStart('detail')}
            title="Drag to resize"
          />
          <div
            className="unity-anim-controller-detail"
            style={{ flex: `0 0 ${detailW}px` }}
          >
            {this.renderDetail(controller, controllerDiff)}
          </div>
        </div>
        {this.state.toast !== null ? (
          <div className="unity-anim-toast" role="status">{this.state.toast}</div>
        ) : null}
      </div>
    )
  }

  private renderLayerToolbar(
    controller: IUnityAnimatorController,
    diff: IUnityAnimatorControllerDiff
  ) {
    const layerStatus = new Map<number, UnityAnimEntityStatus>()
    for (const l of diff.layers) layerStatus.set(l.index, l.status)
    return (
      <div className="unity-anim-controller-toolbar">
        <div className="unity-anim-controller-layers" role="tablist">
          {controller.layers.map((layer, i) => {
            const s = layerStatus.get(i) ?? 'unchanged'
            const active = this.state.activeLayerIndex === i
            return (
              <button
                key={i}
                role="tab"
                aria-selected={active}
                className={`unity-anim-controller-layer ${statusClass(s)}${active ? ' is-active' : ''}`}
                onClick={() => this.onSelectLayer(i)}
                title={`Layer ${i}: ${layer.name}`}
              >
                {layer.name || `Layer ${i}`}
              </button>
            )
          })}
        </div>
        <div className="unity-anim-controller-actions">
          <button className="unity-anim-icon-btn" onClick={this.onFit} title="Fit graph">
            Fit
          </button>
          <button
            className="unity-anim-icon-btn"
            onClick={this.onToggleParameters}
            title="Toggle parameters panel"
          >
            {this.state.parametersOpen ? 'Hide' : 'Show'} params
            {' '}({diff.parameters.length})
          </button>
        </div>
      </div>
    )
  }

  private renderBreadcrumbs(
    controller: IUnityAnimatorController,
    path: ReadonlyArray<UnityFileId>
  ) {
    if (path.length <= 1) return null
    return (
      <div className="unity-anim-controller-breadcrumbs">
        {path.map((smId, depth) => {
          const sm = controller.stateMachines.get(smId)
          return (
            <React.Fragment key={smId}>
              {depth > 0 ? <span className="sep">›</span> : null}
              <button
                className="unity-anim-controller-crumb"
                onClick={() => this.onBreadcrumbClick(depth)}
                disabled={depth === path.length - 1}
              >
                {sm?.name || '(unnamed)'}
              </button>
            </React.Fragment>
          )
        })}
      </div>
    )
  }

  private renderParameters(
    diff: IUnityAnimatorControllerDiff,
    showUnchanged: boolean
  ) {
    const visible = showUnchanged
      ? diff.parameters
      : diff.parameters.filter(p => p.status !== 'unchanged')
    if (visible.length === 0) {
      return (
        <>
          <div className="unity-anim-controller-params-title">Parameters</div>
          <div className="unity-diff-message">No parameter changes.</div>
        </>
      )
    }
    return (
      <>
        <div className="unity-anim-controller-params-title">Parameters</div>
        <ul>
          {visible.map(p => this.renderParameterRow(p))}
        </ul>
      </>
    )
  }

  private renderParameterRow(p: IUnityAnimParamDiff): React.ReactNode {
    const raw = p.after ?? p.before
    if (raw === undefined) return null
    // Modified parameters render the value with strike-through + bold diff.
    let valueNode: React.ReactNode
    if (p.status === 'modified' && p.before !== undefined && p.after !== undefined) {
      valueNode = diffNode<IUnityAnimParameter>(
        p.before,
        p.after,
        paramsEqualDefault,
        paramValueGlyph
      )
    } else {
      valueNode = paramValueGlyph(raw)
    }
    return (
      <li
        key={p.name}
        className={`unity-anim-controller-param ${statusClass(p.status)}`}
      >
        <span
          className={`unity-anim-controller-param-stripe ${statusClass(p.status)}`}
          aria-hidden={true}
        />
        <span className="unity-anim-controller-param-name">{p.name}</span>
        <span className="unity-anim-controller-param-value">{valueNode}</span>
      </li>
    )
  }

  private renderDetail(
    controller: IUnityAnimatorController,
    diff: IUnityAnimatorControllerDiff
  ) {
    const selection = this.state.selection
    if (selection === null) {
      return (
        <div className="unity-diff-message">
          Click a state or transition to inspect.
        </div>
      )
    }
    if (selection.kind === 'state') {
      const state = controller.states.get(selection.fileId)
      if (state === undefined) return null
      return this.renderStateDetail(state, diff, controller)
    }
    if (selection.kind === 'transition') {
      const t = controller.transitions.get(selection.fileId)
      if (t === undefined) return null
      return this.renderTransitionDetail(t, controller, diff)
    }
    if (selection.kind === 'stateMachine') {
      const sm = controller.stateMachines.get(selection.fileId)
      if (sm === undefined) return null
      return this.renderStateMachineDetail(sm)
    }
    return (
      <div className="unity-diff-message">{selection.kind}</div>
    )
  }

  private renderStateDetail(
    state: IUnityAnimState,
    diff: IUnityAnimatorControllerDiff,
    controller: IUnityAnimatorController
  ) {
    const stateDiff = diff.states.find(s => s.fileId === state.fileId)
    const status = stateDiff?.status ?? 'unchanged'
    const before = stateDiff?.before
    const after = stateDiff?.after ?? state

    // Motion label (with cross-file GUID resolution).
    const motionLabelOf = (s: IUnityAnimState): string => {
      if (s.motionFileId === '0') return 'None'
      if (s.motionGuid !== undefined) {
        const p = pathForGuid(this.props.result.resolvedGuids, s.motionGuid)
        if (p !== undefined) return p
        return `guid:${s.motionGuid}`
      }
      return `fileID:${s.motionFileId}`
    }
    const motionLabel = motionLabelOf(after)
    const motionCopy = () => this.copy(motionLabel)

    return (
      <>
        <div className="unity-anim-controller-detail-title">
          <span className={`unity-anim-controller-tag ${statusClass(status)}`}>
            {status}
          </span>
          State · {after.name || '(unnamed)'}
        </div>
        <dl className="unity-anim-controller-detail-fields">
          <dt>Motion</dt>
          <dd>
            {status === 'modified' && before !== undefined ? (
              diffNode<string>(motionLabelOf(before), motionLabel, strEq, v => (
                <button
                  className="unity-anim-controller-copyable"
                  onClick={() => this.copy(v)}
                  title="Click to copy"
                >
                  {v}
                </button>
              ))
            ) : (
              <button
                className="unity-anim-controller-copyable"
                onClick={motionCopy}
                title="Click to copy"
                disabled={motionLabel === 'None'}
              >
                {motionLabel}
              </button>
            )}
          </dd>
          <dt>Speed</dt>
          <dd>
            {diffNode<number>(before?.speed, after.speed, numEq, v => formatNumber(v))}
          </dd>
          <dt>Cycle offset</dt>
          <dd>
            {diffNode<number>(
              before?.cycleOffset,
              after.cycleOffset,
              numEq,
              v => formatNumber(v)
            )}
          </dd>
          <dt>Write defaults</dt>
          <dd>
            {diffNode<boolean>(
              before?.writeDefaultValues,
              after.writeDefaultValues,
              boolEq,
              v => (v ? 'on' : 'off')
            )}
          </dd>
          {(after.tag.length > 0 || (before?.tag ?? '').length > 0) ? (
            <>
              <dt>Tag</dt>
              <dd>{diffNode<string>(before?.tag, after.tag, strEq, v => v || '(none)')}</dd>
            </>
          ) : null}
          <dt>Transitions</dt>
          <dd>
            {after.transitionFileIds.length === 0 ? (
              <span className="unity-diff-message-inline">(none)</span>
            ) : (
              <ul className="unity-anim-controller-transition-list">
                {after.transitionFileIds.map(tid => {
                  const t = controller.transitions.get(tid)
                  if (t === undefined) return null
                  const dstName = this.transitionTargetName(t, controller)
                  return (
                    <li key={tid}>→ {dstName}</li>
                  )
                })}
              </ul>
            )}
          </dd>
          {after.behaviourFileIds.length > 0 ? (
            <>
              <dt>Behaviours</dt>
              <dd>{after.behaviourFileIds.length} script(s)</dd>
            </>
          ) : null}
        </dl>
      </>
    )
  }

  private renderTransitionDetail(
    t: IUnityAnimTransition,
    controller: IUnityAnimatorController,
    diff: IUnityAnimatorControllerDiff
  ) {
    const tDiff = diff.transitions.find(x => x.fileId === t.fileId)
    const status = tDiff?.status ?? 'unchanged'
    const before = tDiff?.before
    const after = tDiff?.after ?? t

    const fromLabel = (tr: IUnityAnimTransition): string =>
      controller.states.get(tr.ownerFileId)?.name ??
      controller.stateMachines.get(tr.ownerFileId)?.name ??
      (tr.kind === 'anystate' ? 'Any State' : tr.kind === 'entry' ? 'Entry' : '(unknown)')

    return (
      <>
        <div className="unity-anim-controller-detail-title">
          <span className={`unity-anim-controller-tag ${statusClass(status)}`}>
            {status}
          </span>
          Transition · {fromLabel(after)} → {this.transitionTargetName(after, controller)}
        </div>
        <dl className="unity-anim-controller-detail-fields">
          <dt>Destination</dt>
          <dd>
            {diffNode<string>(
              before !== undefined ? this.transitionTargetName(before, controller) : undefined,
              this.transitionTargetName(after, controller),
              strEq,
              v => v
            )}
          </dd>
          <dt>Has exit time</dt>
          <dd>
            {diffNode<boolean>(before?.hasExitTime, after.hasExitTime, boolEq, v =>
              v ? 'yes' : 'no'
            )}
          </dd>
          <dt>Exit time</dt>
          <dd>
            {diffNode<number>(before?.exitTime, after.exitTime, numEq, v =>
              formatNumber(v, 4)
            )}
          </dd>
          <dt>Duration</dt>
          <dd>
            {diffNode<number>(before?.duration, after.duration, numEq, v =>
              formatNumber(v, 4)
            )}
          </dd>
          <dt>Offset</dt>
          <dd>
            {diffNode<number>(before?.offset, after.offset, numEq, v =>
              formatNumber(v, 4)
            )}
          </dd>
          <dt>Conditions</dt>
          <dd>{this.renderConditionsDiff(before?.conditions, after.conditions)}</dd>
        </dl>
      </>
    )
  }

  private renderStateMachineDetail(sm: IUnityAnimStateMachine) {
    return (
      <>
        <div className="unity-anim-controller-detail-title">
          Sub-state machine · {sm.name || '(unnamed)'}
        </div>
        <p className="unity-diff-message-inline">
          Double-click the node to drill in.
        </p>
        <dl className="unity-anim-controller-detail-fields">
          <dt>States</dt>
          <dd>{sm.stateFileIds.length}</dd>
          <dt>Child SMs</dt>
          <dd>{sm.childStateMachines.length}</dd>
        </dl>
      </>
    )
  }

  private transitionTargetName(
    t: IUnityAnimTransition,
    controller: IUnityAnimatorController
  ): string {
    if (t.isExit) return 'Exit'
    if (t.dstStateFileId !== undefined && t.dstStateFileId !== '0') {
      return controller.states.get(t.dstStateFileId)?.name ?? `state:${t.dstStateFileId}`
    }
    if (t.dstStateMachineFileId !== undefined && t.dstStateMachineFileId !== '0') {
      return controller.stateMachines.get(t.dstStateMachineFileId)?.name ??
        `SM:${t.dstStateMachineFileId}`
    }
    return '(none)'
  }

  private formatCondition = (c: IUnityAnimCondition): string => {
    const op = CONDITION_MODE_LABEL[c.mode] ?? `mode ${c.mode}`
    const showThreshold = c.mode === 3 || c.mode === 4 || c.mode === 6 || c.mode === 7
    return `${c.parameter} ${op}${showThreshold ? ' ' + formatNumber(c.threshold, 4) : ''}`
  }

  private renderConditionsDiff(
    before: ReadonlyArray<IUnityAnimCondition> | undefined,
    after: ReadonlyArray<IUnityAnimCondition>
  ) {
    // Match by (parameter, mode) — a threshold-only change reads as a modify
    // on the same condition, not add+remove.
    const key = (c: IUnityAnimCondition): string => `${c.parameter}|${c.mode}`
    const beforeMap = new Map<string, IUnityAnimCondition>()
    for (const c of before ?? []) beforeMap.set(key(c), c)
    const afterMap = new Map<string, IUnityAnimCondition>()
    for (const c of after) afterMap.set(key(c), c)
    const seen = new Set<string>()
    const rows: React.ReactNode[] = []
    const push = (k: string) => {
      if (seen.has(k)) return
      seen.add(k)
      const b = beforeMap.get(k)
      const a = afterMap.get(k)
      if (b !== undefined && a !== undefined) {
        rows.push(
          <li key={k}>
            {diffNode<string>(this.formatCondition(b), this.formatCondition(a), strEq, v => (
              <code>{v}</code>
            ))}
          </li>
        )
      } else if (a !== undefined) {
        rows.push(
          <li key={k} className="unity-status-added">
            <b className="unity-value-after"><code>{this.formatCondition(a)}</code></b>
          </li>
        )
      } else if (b !== undefined) {
        rows.push(
          <li key={k} className="unity-status-removed">
            <s className="unity-value-before"><code>{this.formatCondition(b)}</code></s>
          </li>
        )
      }
    }
    for (const c of after) push(key(c))
    for (const c of before ?? []) push(key(c))
    if (rows.length === 0) {
      return <span className="unity-diff-message-inline">(none)</span>
    }
    return <ul className="unity-anim-controller-condition-list">{rows}</ul>
  }
}
