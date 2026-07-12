import * as React from 'react'
import { PathLabel } from '../lib/path-label'
import { AppFileStatus } from '../../models/status'
import { IDiff, DiffType } from '../../models/diff'
import { Octicon, iconForStatus } from '../octicons'
import { mapStatus } from '../../lib/status'
import { DiffOptions } from './diff-options'

interface IDiffHeaderProps {
  readonly path: string
  readonly status: AppFileStatus
  readonly diff: IDiff | null

  /** Whether we should display side by side diffs. */
  readonly showSideBySideDiff: boolean

  /** Called when the user changes the side by side diffs setting. */
  readonly onShowSideBySideDiffChanged: (checked: boolean) => void

  /** Whether we should hide whitespace in diffs. */
  readonly hideWhitespaceInDiff: boolean

  /** Called when the user changes the hide whitespace in diffs setting. */
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => Promise<void>

  /** Whether a Unity semantic diff is being shown as a raw text diff. */
  readonly showUnityAsText?: boolean
  readonly onShowUnityAsTextChanged?: (showUnityAsText: boolean) => void

  /**
   * Whether Unity's floating-point re-serialization noise is filtered from the
   * override list in the semantic Inspector. Default `true`.
   */
  readonly hideUnityFloatDrift?: boolean
  readonly onHideUnityFloatDriftChanged?: (hide: boolean) => void

  /** Called when the user opens the diff options popover */
  readonly onDiffOptionsOpened: () => void
}

/** Displays information about a file */
export class DiffHeader extends React.Component<IDiffHeaderProps, {}> {
  public render() {
    const status = this.props.status
    const fileStatus = mapStatus(status)

    return (
      <div className="header">
        <PathLabel path={this.props.path} status={this.props.status} />

        {this.renderDiffOptions()}

        <Octicon
          symbol={iconForStatus(status)}
          className={'status status-' + fileStatus.toLowerCase()}
          title={fileStatus}
        />
      </div>
    )
  }

  private renderDiffOptions() {
    if (this.props.diff?.kind === DiffType.Submodule) {
      return null
    }

    const showUnityAsText =
      this.props.diff?.kind === DiffType.Unity
        ? this.props.showUnityAsText
        : undefined
    const hideUnityFloatDrift =
      this.props.diff?.kind === DiffType.Unity
        ? this.props.hideUnityFloatDrift
        : undefined

    return (
      <DiffOptions
        isInteractiveDiff={true}
        onHideWhitespaceChangesChanged={
          this.props.onHideWhitespaceInDiffChanged
        }
        hideWhitespaceChanges={this.props.hideWhitespaceInDiff}
        onShowSideBySideDiffChanged={this.props.onShowSideBySideDiffChanged}
        showSideBySideDiff={this.props.showSideBySideDiff}
        showUnityAsText={showUnityAsText}
        onShowUnityAsTextChanged={this.props.onShowUnityAsTextChanged}
        hideUnityFloatDrift={hideUnityFloatDrift}
        onHideUnityFloatDriftChanged={this.props.onHideUnityFloatDriftChanged}
        onDiffOptionsOpened={this.props.onDiffOptionsOpened}
      />
    )
  }
}
