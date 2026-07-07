import * as React from 'react'

import { Repository } from '../../../models/repository'
import {
  CommittedFileChange,
  WorkingDirectoryFileChange,
} from '../../../models/status'
import { UnityFileId } from '../../../models/unity/serialized-asset'
import {
  IUnityDocumentDiff,
  IUnityGameObjectDiffNode,
  IUnityPrefabInstanceDiff,
  IUnitySemanticDiffRequest,
  IUnitySemanticDiffResult,
} from '../../../models/unity/semantic-diff'
import { diffUnityAsset, diffUnityAssetDocuments } from '../../main-process-proxy'
import {
  countNodes,
  findGameObject,
  statusClass,
} from './inspector-fields'
import { UnityInspector } from './unity-inspector'
import { Button } from '../../lib/button'
import { Resizable } from '../../resizable'

type ChangedFile = WorkingDirectoryFileChange | CommittedFileChange

const defaultHierarchyWidth = 250

interface IUnityDiffProps {
  readonly repository: Repository
  readonly file: ChangedFile
  /** Whether unchanged hierarchy nodes and properties are shown. */
  readonly showUnchanged: boolean
  /** Turn on "Show unchanged" (e.g. to reveal a navigated-to reference target). */
  readonly onEnableShowUnchanged?: () => void
  /** Whether to parse even when a side exceeds the default size limit. */
  readonly alwaysOpenLarge: boolean
}

interface IUnityDiffState {
  readonly phase: 'loading' | 'loaded' | 'error'
  readonly result: IUnitySemanticDiffResult | null
  readonly errorMessage: string | null
  readonly selectedFileId: UnityFileId | null
  /** Nodes whose children are rendered. Default: paths to changed nodes. */
  readonly expanded: ReadonlySet<UnityFileId>
  /** Nodes whose subtree (self or descendant) contains a change. */
  readonly changedSubtree: ReadonlySet<UnityFileId>
  /** Changed prefab instances keyed by their hierarchy node fileId. */
  readonly prefabByNode: ReadonlyMap<UnityFileId, IUnityPrefabInstanceDiff>
  /**
   * Document property diffs available to the Inspector, keyed by fileId. Seeded
   * with the changed documents the diff returns eagerly; an unchanged node's
   * documents are fetched on demand when it's selected and merged in here.
   */
  readonly docCache: ReadonlyMap<UnityFileId, IUnityDocumentDiff>
  readonly search: string
  readonly hierarchyWidth: number
}

const beforeRefForFile = (file: ChangedFile): string =>
  file instanceof CommittedFileChange ? file.parentCommitish : 'HEAD'

const afterRefForFile = (file: ChangedFile): string | null =>
  file instanceof CommittedFileChange ? file.commitish : null

/**
 * Compute the initial expansion: every node whose subtree contains a change is
 * recorded in `changedSubtree`, and every node on the path to a change is
 * `expanded` so the diff is visible without manual expansion. Collapsing by
 * default keeps a huge scene tree renderable — only expanded nodes recurse.
 */
const computeExpansion = (
  roots: ReadonlyArray<IUnityGameObjectDiffNode>,
  extraChanged: ReadonlySet<UnityFileId>
): { expanded: Set<UnityFileId>; changedSubtree: Set<UnityFileId> } => {
  const expanded = new Set<UnityFileId>()
  const changedSubtree = new Set<UnityFileId>()
  const visit = (node: IUnityGameObjectDiffNode): boolean => {
    let childChanged = false
    for (const child of node.children) {
      if (visit(child)) {
        childChanged = true
      }
    }
    const hasChange =
      node.status !== 'unchanged' || extraChanged.has(node.fileId) || childChanged
    if (hasChange) {
      changedSubtree.add(node.fileId)
    }
    if (childChanged) {
      expanded.add(node.fileId)
    }
    return hasChange
  }
  roots.forEach(visit)
  return { expanded, changedSubtree }
}

/**
 * The Unity semantic diff view: a resizable hierarchy whose nodes are colored
 * by change status, beside an inspector that shows each GameObject's component
 * and property changes (before → after). Parsing problems degrade to a local
 * message; the surrounding Diff component still offers the plain-text diff.
 */
export class UnityDiff extends React.Component<
  IUnityDiffProps,
  IUnityDiffState
> {
  private loadToken = 0
  // Guards async setState after the component unmounts (e.g. switching commits).
  private mounted = false

  public constructor(props: IUnityDiffProps) {
    super(props)
    this.state = {
      phase: 'loading',
      result: null,
      errorMessage: null,
      selectedFileId: null,
      expanded: new Set(),
      changedSubtree: new Set(),
      prefabByNode: new Map(),
      docCache: new Map(),
      search: '',
      hierarchyWidth: defaultHierarchyWidth,
    }
  }

  public componentDidMount() {
    this.mounted = true
    this.load(false)
  }

  public componentWillUnmount() {
    this.mounted = false
  }

  public componentDidUpdate(
    prevProps: IUnityDiffProps,
    prevState: IUnityDiffState
  ) {
    if (
      prevProps.file.path !== this.props.file.path ||
      prevProps.repository.path !== this.props.repository.path ||
      beforeRefForFile(prevProps.file) !== beforeRefForFile(this.props.file) ||
      afterRefForFile(prevProps.file) !== afterRefForFile(this.props.file) ||
      // Re-parse when the user enables always-open for a previously-skipped file.
      (!prevProps.alwaysOpenLarge && this.props.alwaysOpenLarge)
    ) {
      this.load(false)
      return
    }
    if (prevState.selectedFileId !== this.state.selectedFileId) {
      this.ensureDocumentsLoaded(this.state.selectedFileId)
    }
  }

  private currentRequest(): IUnitySemanticDiffRequest {
    return {
      repositoryPath: this.props.repository.path,
      filePath: this.props.file.path,
      beforeRef: beforeRefForFile(this.props.file),
      afterRef: afterRefForFile(this.props.file),
      force: this.props.alwaysOpenLarge,
    }
  }

  /**
   * Ensure the Inspector has the document diffs for a selected node — its own
   * GameObject document and each component. Changed documents are already in the
   * cache (seeded from the eager result); any missing (unchanged) ones are
   * fetched on demand and merged in. A no-op when nothing is missing. Failures
   * surface as the same error banner the initial load uses, so a worker crash
   * on document fetch doesn't become an unhandled rejection.
   */
  private async ensureDocumentsLoaded(fileId: UnityFileId | null) {
    const { result } = this.state
    if (fileId === null || result === null) {
      return
    }
    const node = findGameObject(result.roots, fileId)
    const wanted =
      node !== null
        ? [node.fileId, ...node.components.map(c => c.fileId)]
        : [fileId]
    const missing = wanted.filter(id => !this.state.docCache.has(id))
    if (missing.length === 0) {
      return
    }
    const token = this.loadToken
    try {
      const documents = await diffUnityAssetDocuments(this.currentRequest(), missing)
      if (token !== this.loadToken || !this.mounted) {
        return
      }
      this.setState(prev => {
        const docCache = new Map(prev.docCache)
        for (const doc of documents) {
          docCache.set(doc.fileId, doc)
        }
        return { docCache }
      })
    } catch (e) {
      if (token !== this.loadToken || !this.mounted) {
        return
      }
      this.setState({
        phase: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      })
    }
  }

  private async load(force: boolean) {
    const useForce = force || this.props.alwaysOpenLarge
    // Supersede any in-flight request: only the latest token may apply state.
    const token = ++this.loadToken
    this.setState({ phase: 'loading', result: null, errorMessage: null })

    try {
      const result = await diffUnityAsset({
        repositoryPath: this.props.repository.path,
        filePath: this.props.file.path,
        beforeRef: beforeRefForFile(this.props.file),
        afterRef: afterRefForFile(this.props.file),
        force: useForce,
      })
      if (token !== this.loadToken || !this.mounted) {
        return
      }
      // Changed prefab instances surfaced at their hierarchy node.
      const prefabByNode = new Map<UnityFileId, IUnityPrefabInstanceDiff>()
      for (const instance of result.prefabInstances) {
        if (instance.nodeFileId !== undefined && instance.status !== 'unchanged') {
          prefabByNode.set(instance.nodeFileId, instance)
        }
      }
      const { expanded, changedSubtree } = computeExpansion(
        result.roots,
        new Set(prefabByNode.keys())
      )
      // The diff returns only the changed documents eagerly; seed the cache with
      // them so changed nodes render instantly, and fetch the rest on selection.
      const docCache = new Map<UnityFileId, IUnityDocumentDiff>()
      for (const doc of result.documents) {
        docCache.set(doc.fileId, doc)
      }
      const selectedFileId = this.defaultSelection(result)
      this.setState({
        phase: 'loaded',
        result,
        selectedFileId,
        expanded,
        changedSubtree,
        prefabByNode,
        docCache,
      })
      this.ensureDocumentsLoaded(selectedFileId)
    } catch (e) {
      if (token !== this.loadToken || !this.mounted) {
        return
      }
      this.setState({
        phase: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      })
    }
  }

  private defaultSelection(result: IUnitySemanticDiffResult): UnityFileId | null {
    // Prefer a changed thing so the Inspector opens on real content rather
    // than an unchanged root that renders as "No changes in this object" and
    // hides that anything changed at all. Order: a modified hierarchy node,
    // then a modified prefab instance (at its node when we could locate one,
    // otherwise at its own fileId so it selects in the bottom prefab list),
    // then a changed standalone document, and finally the first root/document
    // when nothing changed.
    const findChangedNode = (
      nodes: ReadonlyArray<IUnityGameObjectDiffNode>
    ): UnityFileId | null => {
      for (const node of nodes) {
        if (node.status !== 'unchanged') {
          return node.fileId
        }
        const found = findChangedNode(node.children)
        if (found !== null) {
          return found
        }
      }
      return null
    }
    const changedNode = findChangedNode(result.roots)
    if (changedNode !== null) {
      return changedNode
    }
    const changedPrefab = result.prefabInstances.find(
      p => p.status !== 'unchanged'
    )
    if (changedPrefab !== undefined) {
      return changedPrefab.nodeFileId ?? changedPrefab.fileId
    }
    const changedDoc = result.documents.find(d => d.status !== 'unchanged')
    if (changedDoc !== undefined) {
      return changedDoc.fileId
    }
    if (result.roots.length > 0) {
      return result.roots[0].fileId
    }
    if (result.documents.length > 0) {
      return result.documents[0].fileId
    }
    return null
  }

  /** Root→node fileId path to a hierarchy node, or null if not in the forest. */
  private pathToNode(
    nodes: ReadonlyArray<IUnityGameObjectDiffNode>,
    fileId: UnityFileId,
    ancestors: ReadonlyArray<UnityFileId> = []
  ): ReadonlyArray<UnityFileId> | null {
    for (const node of nodes) {
      const trail = [...ancestors, node.fileId]
      if (node.fileId === fileId) {
        return trail
      }
      const found = this.pathToNode(node.children, fileId, trail)
      if (found !== null) {
        return found
      }
    }
    return null
  }

  /**
   * Select a GameObject in the hierarchy (a reference click target): expand its
   * ancestors and, if it's currently hidden because "Show unchanged" is off,
   * turn that toggle on so the target becomes visible.
   */
  private navigateTo = (fileId: UnityFileId) => {
    const result = this.state.result
    if (result === null) {
      return
    }
    const path = this.pathToNode(result.roots, fileId)
    if (path === null) {
      return
    }
    const expanded = new Set(this.state.expanded)
    for (const id of path) {
      expanded.add(id)
    }
    const visible =
      this.props.showUnchanged || this.state.changedSubtree.has(fileId)
    if (!visible) {
      this.props.onEnableShowUnchanged?.()
    }
    this.setState({ selectedFileId: fileId, expanded })
  }

  private onSelect = (e: React.MouseEvent<HTMLElement>) => {
    const fileId = e.currentTarget.dataset.fileid
    if (fileId !== undefined) {
      this.setState({ selectedFileId: fileId })
    }
  }

  private onToggleExpand = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation()
    const fileId = e.currentTarget.dataset.fileid
    if (fileId === undefined) {
      return
    }
    const expanded = new Set(this.state.expanded)
    if (expanded.has(fileId)) {
      expanded.delete(fileId)
    } else {
      expanded.add(fileId)
    }
    this.setState({ expanded })
  }

  private onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ search: e.currentTarget.value })
  }

  private onHierarchyResize = (width: number) => {
    this.setState({ hierarchyWidth: width })
  }

  private onHierarchyReset = () => {
    this.setState({ hierarchyWidth: defaultHierarchyWidth })
  }

  private onForcePreview = () => {
    this.load(true)
  }

  public render() {
    if (this.state.phase === 'loading') {
      return <div className="unity-diff-message">Parsing Unity asset…</div>
    }
    if (this.state.phase === 'error' || this.state.result === null) {
      return (
        <div className="unity-diff-message">
          Could not parse this Unity asset
          {this.state.errorMessage !== null
            ? `: ${this.state.errorMessage}`
            : ''}
          . Switch to Raw diff to view the raw changes.
        </div>
      )
    }

    const result = this.state.result

    if (result.status === 'too-large') {
      return (
        <div className="unity-diff-message">
          <p>This Unity asset is large and was not parsed automatically.</p>
          <Button onClick={this.onForcePreview}>
            {__DARWIN__ ? 'Preview Anyway' : 'Preview anyway'}
          </Button>
        </div>
      )
    }

    if (result.status !== 'parsed' && result.status !== 'partially-parsed') {
      return (
        <div className="unity-diff-message">
          This asset is not viewable as Unity YAML ({result.status}). Switch to
          Raw diff to view the raw changes.
        </div>
      )
    }

    // The left panel adds nothing when it would list a single item. Two cases:
    // a one-node GameObject hierarchy, or a flat asset (materials, MonoBehaviour
    // documents) whose visible document list — after the Show unchanged filter —
    // holds at most one entry. Show just the Inspector then.
    const prefabList = this.renderPrefabInstances(result)
    const hierarchyOnlyNode =
      result.roots.length > 0 &&
      countNodes(result.roots) === 1 &&
      prefabList === null
    if (hierarchyOnlyNode) {
      return (
        <div className="unity-diff">
          <div className="unity-diff-pane unity-inspector unity-inspector-only">
            {this.renderInspectorPane(result, this.state.selectedFileId)}
          </div>
        </div>
      )
    }

    const flat = result.roots.length === 0 && result.prefabInstances.length === 0
    const visibleDocs = flat
      ? result.documents.filter(
          d => this.props.showUnchanged || d.status !== 'unchanged'
        )
      : null
    if (visibleDocs !== null && visibleDocs.length <= 1) {
      const only = visibleDocs[0]
      return (
        <div className="unity-diff">
          <div className="unity-diff-pane unity-inspector unity-inspector-only">
            {only !== undefined ? (
              this.renderInspectorPane(result, only.fileId)
            ) : (
              <div className="unity-diff-message">No changes</div>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="unity-diff">
        <Resizable
          width={this.state.hierarchyWidth}
          minimumWidth={170}
          maximumWidth={520}
          onResize={this.onHierarchyResize}
          onReset={this.onHierarchyReset}
          description="Unity hierarchy"
        >
          <div className="unity-diff-pane unity-hierarchy">
            <input
              type="search"
              className="unity-hierarchy-search"
              placeholder="Search hierarchy"
              value={this.state.search}
              onChange={this.onSearchChange}
            />
            <div className="unity-hierarchy-tree">
              {this.renderHierarchy(result)}
              {prefabList}
            </div>
          </div>
        </Resizable>
        <div className="unity-diff-pane unity-inspector">
          {this.renderInspectorPane(result, this.state.selectedFileId)}
        </div>
      </div>
    )
  }

  private renderInspectorPane(
    result: IUnitySemanticDiffResult,
    selectedFileId: UnityFileId | null
  ) {
    return (
      <UnityInspector
        result={result}
        selectedFileId={selectedFileId}
        showUnchanged={this.props.showUnchanged}
        repository={this.props.repository}
        docCache={this.state.docCache}
        prefabByNode={this.state.prefabByNode}
        onNavigate={this.navigateTo}
      />
    )
  }

  private renderHierarchy(result: IUnitySemanticDiffResult) {
    if (result.roots.length > 0) {
      const search = this.state.search.trim().toLowerCase()
      return result.roots.map(root => this.renderGameObject(root, 0, search))
    }
    // A prefab-instance asset with no own GameObjects: its instances render
    // separately, so don't dump every document as a flat list.
    if (result.prefabInstances.length > 0) {
      return null
    }
    // Assets without a hierarchy (materials, scriptable objects): list docs.
    return result.documents
      .filter(doc => this.props.showUnchanged || doc.status !== 'unchanged')
      .map(doc => (
        <div
          key={doc.fileId}
          className={`${this.rowClassName(doc.fileId)} ${statusClass(doc.status)}`}
          data-fileid={doc.fileId}
          onClick={this.onSelect}
        >
          {doc.typeName}
        </div>
      ))
  }

  private renderGameObject(
    node: IUnityGameObjectDiffNode,
    depth: number,
    search: string
  ): JSX.Element | null {
    const searching = search.length > 0

    // Hide unchanged subtrees unless asked, or unless searching.
    if (
      !searching &&
      !this.props.showUnchanged &&
      !this.state.changedSubtree.has(node.fileId)
    ) {
      return null
    }

    const matches = !searching || node.name.toLowerCase().includes(search)
    const hasChildren = node.children.length > 0
    const isExpanded = searching || this.state.expanded.has(node.fileId)
    // A changed prefab instance shows as modified at its hierarchy node.
    const status = this.state.prefabByNode.has(node.fileId)
      ? 'modified'
      : node.status

    // Only recurse into children when expanded (or searching). This is what
    // keeps a scene with 100k+ nodes renderable.
    const renderedChildren =
      hasChildren && isExpanded
        ? node.children
            .map(child => this.renderGameObject(child, depth + 1, search))
            .filter((c): c is JSX.Element => c !== null)
        : []
    const hasVisibleDescendant = renderedChildren.length > 0

    // Search filter: keep a node if it or a descendant matches.
    if (searching && !matches && !hasVisibleDescendant) {
      return null
    }

    return (
      <div key={node.fileId}>
        <div
          className={`${this.rowClassName(node.fileId)} ${statusClass(status)}`}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          data-fileid={node.fileId}
          onClick={this.onSelect}
        >
          {hasChildren ? (
            <span
              className="unity-tree-toggle"
              data-fileid={node.fileId}
              onClick={this.onToggleExpand}
            >
              {isExpanded ? '▾' : '▸'}
            </span>
          ) : (
            <span className="unity-tree-toggle unity-tree-leaf" />
          )}
          <span>{node.name.length > 0 ? node.name : '(unnamed)'}</span>
          {node.isModel ? (
            <span className="unity-model-tag">model</span>
          ) : null}
        </div>
        {hasVisibleDescendant ? renderedChildren : null}
      </div>
    )
  }

  private rowClassName(fileId: UnityFileId): string {
    return this.state.selectedFileId === fileId
      ? 'unity-row unity-row-selected'
      : 'unity-row'
  }

  private renderPrefabInstances(result: IUnitySemanticDiffResult) {
    const search = this.state.search.trim().toLowerCase()
    // Changed instances placed in the hierarchy are shown there; only list those
    // we couldn't locate a hierarchy node for.
    const instances = result.prefabInstances.filter(
      inst =>
        inst.status !== 'unchanged' &&
        inst.nodeFileId === undefined &&
        (search.length === 0 || inst.name.toLowerCase().includes(search))
    )
    if (instances.length === 0) {
      return null
    }
    return instances.map(inst => (
      <div
        key={`prefab-${inst.fileId}`}
        className={`${this.rowClassName(inst.fileId)} ${statusClass(inst.status)}`}
        data-fileid={inst.fileId}
        onClick={this.onSelect}
      >
        <span className="unity-tree-toggle unity-tree-leaf" />
        <span>
          {inst.name} <span className="unity-prefab-tag">prefab</span>
        </span>
      </div>
    ))
  }


}
