/**
 * Small presentational widgets used by the Unity Inspector's value rendering:
 * a height-clamped collapsible value, a collapsible array box, and a reference
 * label. They hold only their own local UI state and are driven entirely by
 * props, so they live apart from the main `UnityDiff` component.
 */

import * as React from 'react'

/** A property value taller than this many lines collapses behind a toggle. */
const maxValueLines = 6

interface ICollapsibleValueState {
  readonly overflowing: boolean
  readonly expanded: boolean
  readonly capPx: number
}

/**
 * Wraps a property value and, when it renders taller than `maxValueLines` of
 * visible text (counting soft wraps), clips it and offers a Show more/less
 * toggle. The cap is measured from the element's own line height so it tracks
 * the actual rendered rows rather than a guessed character count.
 */
export class CollapsibleValue extends React.Component<
  { readonly children: React.ReactNode },
  ICollapsibleValueState
> {
  private readonly ref = React.createRef<HTMLDivElement>()
  public state: ICollapsibleValueState = {
    overflowing: false,
    expanded: false,
    capPx: 0,
  }

  public componentDidMount() {
    this.measure()
  }

  public componentDidUpdate() {
    this.measure()
  }

  private measure() {
    const el = this.ref.current
    if (el === null) {
      return
    }
    const style = getComputedStyle(el)
    let lineHeight = parseFloat(style.lineHeight)
    if (!isFinite(lineHeight)) {
      lineHeight = (parseFloat(style.fontSize) || 13) * 1.4
    }
    const capPx = Math.round(lineHeight * maxValueLines)
    const overflowing = el.scrollHeight > capPx + 1
    // Only commit real changes so the post-update measure can't loop.
    if (overflowing !== this.state.overflowing || capPx !== this.state.capPx) {
      this.setState({ overflowing, capPx })
    }
  }

  private onToggle = () => this.setState(s => ({ expanded: !s.expanded }))

  public render() {
    const { overflowing, expanded, capPx } = this.state
    const collapsed = overflowing && !expanded
    return (
      <span className="unity-collapsible-value">
        <div
          ref={this.ref}
          className="unity-collapsible-value-body"
          style={
            collapsed ? { maxHeight: capPx, overflow: 'hidden' } : undefined
          }
        >
          {this.props.children}
        </div>
        {overflowing ? (
          <button
            type="button"
            className="unity-value-toggle"
            onClick={this.onToggle}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        ) : null}
      </span>
    )
  }
}

/**
 * A box around an array value with a header that toggles its contents. Small
 * arrays start expanded; larger ones start collapsed so a property with many
 * elements (e.g. a Material's `m_TexEnvs`) doesn't flood the Inspector.
 */
export class CollapsibleArray extends React.Component<
  {
    readonly summary: string
    readonly defaultExpanded: boolean
    readonly children: React.ReactNode
  },
  { readonly expanded: boolean }
> {
  public state = { expanded: this.props.defaultExpanded }

  private onToggle = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation()
    this.setState(s => ({ expanded: !s.expanded }))
  }

  public render() {
    const { expanded } = this.state
    return (
      <span className="unity-array">
        <button
          type="button"
          className="unity-array-header"
          onClick={this.onToggle}
        >
          <span className="unity-array-toggle">{expanded ? '▾' : '▸'}</span>
          {this.props.summary}
        </button>
        {expanded ? this.props.children : null}
      </span>
    )
  }
}

/**
 * A same-asset object reference rendered by a friendly label (the target's
 * GameObject name and type). Hovering shows the raw fileID; clicking navigates
 * to (and selects) the target in the hierarchy.
 */
export class ReferenceValue extends React.Component<{
  readonly label: string
  readonly fileId: string
  /** The hierarchy node to select on click; omit to make the reference inert. */
  readonly navigateFileId?: string
  readonly onNavigate?: (fileId: string) => void
}> {
  private onClick = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation()
    if (this.props.navigateFileId !== undefined) {
      this.props.onNavigate?.(this.props.navigateFileId)
    }
  }

  public render() {
    const navigable =
      this.props.onNavigate !== undefined &&
      this.props.navigateFileId !== undefined
    return (
      <span
        className={`unity-ref${navigable ? ' is-navigable' : ''}`}
        title={`fileID ${this.props.fileId}`}
        onClick={navigable ? this.onClick : undefined}
      >
        {this.props.label}
      </span>
    )
  }
}
