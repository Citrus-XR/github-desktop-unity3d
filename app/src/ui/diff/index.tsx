import * as React from 'react'

import { assertNever } from '../../lib/fatal-error'
import { encodePathAsUrl } from '../../lib/path'

import { Repository } from '../../models/repository'
import {
  CommittedFileChange,
  WorkingDirectoryFileChange,
  AppFileStatusKind,
  isManualConflict,
  isConflictedFileStatus,
} from '../../models/status'
import {
  DiffSelection,
  DiffType,
  IDiff,
  IImageDiff,
  ITextDiff,
  ILargeTextDiff,
  ImageDiffType,
  ISubmoduleDiff,
  IUnityDiff,
} from '../../models/diff'
import { Button } from '../lib/button'
import { getBoolean, setBoolean } from '../../lib/local-storage'
import {
  unityAlwaysOpenLargeKey,
  unityShowUnchangedKey,
} from './unity-diff-preferences'
import {
  NewImageDiff,
  ModifiedImageDiff,
  DeletedImageDiff,
} from './image-diffs'
import { BinaryFile } from './binary-file'
import { SideBySideDiff } from './side-by-side-diff'
import { IFileContents } from './syntax-highlighting'
import { SubmoduleDiff } from './submodule-diff'
import { UnityDiff } from './unity/unity-diff'
import { Octicon } from '../octicons'
import * as OcticonSymbol from '../octicons/octicons.generated'

// image used when no diff is displayed
const NoDiffImage = encodePathAsUrl(__dirname, 'static/ufo-alert.svg')

type ChangedFile = WorkingDirectoryFileChange | CommittedFileChange

/** The props for the Diff component. */
interface IDiffProps {
  readonly repository: Repository

  /**
   * Whether the diff is readonly, e.g., displaying a historical diff, or the
   * diff's lines can be selected, e.g., displaying a change in the working
   * directory.
   */
  readonly readOnly: boolean

  /** The file whose diff should be displayed. */
  readonly file: ChangedFile

  /** Called when the includedness of lines or a range of lines has changed. */
  readonly onIncludeChanged?: (diffSelection: DiffSelection) => void

  /** The diff that should be rendered */
  readonly diff: IDiff

  /**
   * Contents of the old and new files related to the current text diff.
   */
  readonly fileContents: IFileContents | null

  /** The type of image diff to display. */
  readonly imageDiffType: ImageDiffType

  /** Hiding whitespace in diff. */
  readonly hideWhitespaceInDiff: boolean

  /** Whether we should display side by side diffs. */
  readonly showSideBySideDiff: boolean

  /** Whether we should show a confirmation dialog when the user discards changes */
  readonly askForConfirmationOnDiscardChanges?: boolean

  /** Whether or not to show the diff check marks indicating inclusion in a commit */
  readonly showDiffCheckMarks: boolean

  /**
   * Called when the user requests to open a binary file in an the
   * system-assigned application for said file type.
   */
  readonly onOpenBinaryFile: (fullPath: string) => void

  /** Called when the user requests to open a submodule. */
  readonly onOpenSubmodule?: (fullPath: string) => void

  /**
   * Called when the user is viewing an image diff and requests
   * to change the diff presentation mode.
   */
  readonly onChangeImageDiffType: (type: ImageDiffType) => void

  /*
   * Called when the user wants to discard a selection of the diff.
   * Only applicable when readOnly is false.
   */
  readonly onDiscardChanges?: (
    diff: ITextDiff,
    diffSelection: DiffSelection
  ) => void

  /** Called when the user changes the hide whitespace in diffs setting. */
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => void

  /** Whether a Unity semantic diff is being shown as a raw text diff. */
  readonly showUnityAsText?: boolean

  /** Called when the user changes the Unity diff presentation mode. */
  readonly onShowUnityAsTextChanged?: (showUnityAsText: boolean) => void

  /**
   * Whether Unity's floating-point re-serialization noise is filtered from the
   * override list in the Inspector. Default `true`.
   */
  readonly hideUnityFloatDrift?: boolean
}

interface IDiffState {
  readonly forceShowLargeDiff: boolean
  readonly showUnityAsText: boolean
  readonly showUnityUnchanged: boolean
  readonly unityAlwaysOpenLarge: boolean
}

/** A component which renders a diff for a file. */
export class Diff extends React.Component<IDiffProps, IDiffState> {
  public constructor(props: IDiffProps) {
    super(props)

    this.state = {
      forceShowLargeDiff: false,
      showUnityAsText: false,
      showUnityUnchanged: getBoolean(unityShowUnchangedKey, false),
      unityAlwaysOpenLarge: getBoolean(unityAlwaysOpenLargeKey, false),
    }
  }

  public render() {
    const diff = this.props.diff

    switch (diff.kind) {
      case DiffType.Text:
        return this.renderText(diff)
      case DiffType.Binary:
        return this.renderBinaryFile()
      case DiffType.Submodule:
        return this.renderSubmoduleDiff(diff)
      case DiffType.Image:
        return this.renderImage(diff)
      case DiffType.LargeText: {
        return this.state.forceShowLargeDiff
          ? this.renderLargeText(diff)
          : this.renderLargeTextDiff()
      }
      case DiffType.Unrenderable:
        return this.renderUnrenderableDiff()
      case DiffType.Unity:
        return this.renderUnityDiff(diff)
      default:
        return assertNever(diff, `Unsupported diff type: ${diff}`)
    }
  }

  private renderUnityDiff(diff: IUnityDiff) {
    const showUnityAsText = this.showUnityAsText

    return (
      <div className="unity-diff-container">
        {this.renderUnityToolbar(showUnityAsText)}
        {showUnityAsText ? (
          this.renderTextDiff({
            kind: DiffType.Text,
            text: diff.text,
            hunks: diff.hunks,
            lineEndingsChange: diff.lineEndingsChange,
            maxLineNumber: diff.maxLineNumber,
            hasHiddenBidiChars: diff.hasHiddenBidiChars,
          })
        ) : (
          <UnityDiff
            repository={this.props.repository}
            file={this.props.file}
            showUnchanged={this.state.showUnityUnchanged}
            onEnableShowUnchanged={this.enableUnityUnchanged}
            alwaysOpenLarge={this.state.unityAlwaysOpenLarge}
            hideFloatDrift={this.props.hideUnityFloatDrift !== false}
          />
        )}
      </div>
    )
  }

  private get showUnityAsText() {
    return this.isUnityDiffModeControlled
      ? this.props.showUnityAsText === true
      : this.state.showUnityAsText
  }

  private get isUnityDiffModeControlled() {
    return (
      this.props.showUnityAsText !== undefined &&
      this.props.onShowUnityAsTextChanged !== undefined
    )
  }

  private renderUnityToolbar(showUnityAsText: boolean) {
    const showInternalModeToggle = !this.isUnityDiffModeControlled

    if (showUnityAsText && !showInternalModeToggle) {
      return null
    }

    return (
      <div className="unity-diff-toolbar">
        {showUnityAsText ? null : (
          <div
            className={
              showInternalModeToggle
                ? 'unity-toolbar-options has-mode-toggle'
                : 'unity-toolbar-options'
            }
          >
            <Button
              className={
                this.state.showUnityUnchanged
                  ? 'unity-toolbar-toggle is-toggled'
                  : 'unity-toolbar-toggle'
              }
              onClick={this.toggleUnityUnchanged}
              ariaLabel="Toggle showing unchanged properties"
            >
              {__DARWIN__ ? 'Show Unchanged' : 'Show unchanged'}
            </Button>
            <Button
              className={
                this.state.unityAlwaysOpenLarge
                  ? 'unity-toolbar-toggle is-toggled'
                  : 'unity-toolbar-toggle'
              }
              onClick={this.toggleUnityAlwaysOpenLarge}
              ariaLabel="Toggle always opening large files"
            >
              {__DARWIN__ ? 'Always Open Large' : 'Always open large'}
            </Button>
          </div>
        )}
        {showInternalModeToggle && (
          <Button onClick={this.toggleUnityAsText}>
            {showUnityAsText
              ? __DARWIN__
                ? 'Show Semantic Diff'
                : 'Show semantic diff'
              : __DARWIN__
              ? 'Show Raw Diff'
              : 'Show raw diff'}
          </Button>
        )}
      </div>
    )
  }

  private toggleUnityAsText = () => {
    const showUnityAsText = !this.showUnityAsText

    if (this.isUnityDiffModeControlled) {
      this.props.onShowUnityAsTextChanged?.(showUnityAsText)
      return
    }

    this.setState({ showUnityAsText })
  }

  private toggleUnityUnchanged = () => {
    const value = !this.state.showUnityUnchanged
    setBoolean(unityShowUnchangedKey, value)
    this.setState({ showUnityUnchanged: value })
  }

  private enableUnityUnchanged = () => {
    if (!this.state.showUnityUnchanged) {
      setBoolean(unityShowUnchangedKey, true)
      this.setState({ showUnityUnchanged: true })
    }
  }

  private toggleUnityAlwaysOpenLarge = () => {
    const value = !this.state.unityAlwaysOpenLarge
    setBoolean(unityAlwaysOpenLargeKey, value)
    this.setState({ unityAlwaysOpenLarge: value })
  }

  private renderImage(imageDiff: IImageDiff) {
    if (imageDiff.current && imageDiff.previous) {
      return (
        <ModifiedImageDiff
          onChangeDiffType={this.props.onChangeImageDiffType}
          diffType={this.props.imageDiffType}
          current={imageDiff.current}
          previous={imageDiff.previous}
        />
      )
    }

    if (
      imageDiff.current &&
      (this.props.file.status.kind === AppFileStatusKind.New ||
        this.props.file.status.kind === AppFileStatusKind.Untracked)
    ) {
      return <NewImageDiff current={imageDiff.current} />
    }

    if (
      imageDiff.previous &&
      this.props.file.status.kind === AppFileStatusKind.Deleted
    ) {
      return <DeletedImageDiff previous={imageDiff.previous} />
    }

    return null
  }

  private renderLargeTextDiff() {
    return (
      <div className="panel empty large-diff">
        <img src={NoDiffImage} className="blankslate-image" alt="" />
        <div className="description">
          <p>The diff is too large to be displayed by default.</p>
          <p>
            You can try to show it anyway, but performance may be negatively
            impacted.
          </p>
        </div>
        <Button onClick={this.showLargeDiff}>
          {__DARWIN__ ? 'Show Diff' : 'Show diff'}
        </Button>
      </div>
    )
  }

  private renderUnrenderableDiff() {
    return (
      <div className="panel empty large-diff">
        <img src={NoDiffImage} alt="" />
        <p>The diff is too large to be displayed.</p>
      </div>
    )
  }

  private renderLargeText(diff: ILargeTextDiff) {
    // guaranteed to be set since this function won't be called if text or hunks are null
    const textDiff: ITextDiff = {
      text: diff.text,
      hunks: diff.hunks,
      kind: DiffType.Text,
      lineEndingsChange: diff.lineEndingsChange,
      maxLineNumber: diff.maxLineNumber,
      hasHiddenBidiChars: diff.hasHiddenBidiChars,
    }

    return this.renderTextDiff(textDiff)
  }

  private renderText(diff: ITextDiff) {
    if (diff.hunks.length === 0) {
      if (
        this.props.file.status.kind === AppFileStatusKind.New ||
        this.props.file.status.kind === AppFileStatusKind.Untracked
      ) {
        return <div className="panel empty">The file is empty</div>
      }

      if (this.props.file.status.kind === AppFileStatusKind.Renamed) {
        // Check if it was changed too
        if (this.props.file.status.renameIncludesModifications) {
          return (
            <div className="panel renamed">
              <Octicon symbol={OcticonSymbol.alert} />
              The file was renamed and includes changes.
            </div>
          )
        }
        return (
          <div className="panel renamed">
            The file was renamed but not changed
          </div>
        )
      }

      if (
        isConflictedFileStatus(this.props.file.status) &&
        isManualConflict(this.props.file.status)
      ) {
        return (
          <div className="panel empty">
            The file is in conflict and must be resolved via the command line.
          </div>
        )
      }

      if (this.props.hideWhitespaceInDiff) {
        return <div className="panel empty">Only whitespace changes found</div>
      }

      return <div className="panel empty">No content changes found</div>
    }

    return this.renderTextDiff(diff)
  }

  private renderSubmoduleDiff(diff: ISubmoduleDiff) {
    return (
      <SubmoduleDiff
        onOpenSubmodule={this.props.onOpenSubmodule}
        diff={diff}
        readOnly={this.props.readOnly}
      />
    )
  }

  private renderBinaryFile() {
    return (
      <BinaryFile
        path={this.props.file.path}
        repository={this.props.repository}
        onOpenBinaryFile={this.props.onOpenBinaryFile}
      />
    )
  }

  private renderTextDiff(diff: ITextDiff) {
    return (
      <SideBySideDiff
        file={this.props.file}
        diff={diff}
        fileContents={this.props.fileContents}
        hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
        showSideBySideDiff={this.props.showSideBySideDiff}
        onIncludeChanged={this.props.onIncludeChanged}
        onDiscardChanges={this.props.onDiscardChanges}
        askForConfirmationOnDiscardChanges={
          this.props.askForConfirmationOnDiscardChanges
        }
        onHideWhitespaceInDiffChanged={this.props.onHideWhitespaceInDiffChanged}
        showDiffCheckMarks={this.props.showDiffCheckMarks}
      />
    )
  }

  private showLargeDiff = () => {
    this.setState({ forceShowLargeDiff: true })
  }
}
