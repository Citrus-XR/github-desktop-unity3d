/**
 * The Unity Inspector pane: renders the selected hierarchy node's components and
 * properties (or a standalone asset such as a Material) from a precomputed diff.
 * It is a pure-render view — `UnityDiff` owns the data, hierarchy, selection
 * state, and lazy document fetching, and passes everything in via props.
 */

import * as React from 'react'
import * as Path from 'path'
import { clipboard } from 'electron'
import { Repository } from '../../../models/repository'
import {
  UnityFileId,
  UnityPropertyValue,
} from '../../../models/unity/serialized-asset'
import {
  IUnityDocumentDiff,
  IUnityGameObjectDiffNode,
  IUnityPrefabInstanceDiff,
  IUnityPrefabOverrideDiff,
  IUnityPropertyDiff,
  IUnitySemanticDiffResult,
  UnityChangeStatus,
} from '../../../models/unity/semantic-diff'
import {
  diffPropertySequence,
  valueEquals,
} from '../../../lib/unity/semantic-diff'
import { AnimationClipInspector } from './animation-clip-inspector'
import {
  CollapsibleArray,
  CollapsibleValue,
  ReferenceValue,
} from './unity-inspector-widgets'
import {
  alwaysHiddenFields,
  basenameWithoutExtension,
  checkboxGlyph,
  findGameObject,
  friendlyOverridePathLabel,
  IComponentSchema,
  IFieldSpec,
  isColorMap,
  isMinMaxCurve,
  isMinMaxGradient,
  isMultiModeParameter,
  isVectorLikeMap,
  resolveLayerName,
  scalarSide,
  displayScalar,
  isModelDefault,
  schemaFor,
  statusClass,
  toggleFieldFor,
  vectorAxisFromPropertyPath,
} from './inspector-fields'
import {
  particleSystemHeaderSchema,
  particleSystemModules,
  particleSystemRendererGroups,
  IParticleSystemModuleSchema,
  IParticleSystemRendererGroup,
} from './particle-system-schema'
import {
  ColorFieldDisplay,
  EnumFieldDisplay,
  MinMaxCurveDisplay,
  MinMaxGradientDisplay,
  MultiModeParameterDisplay,
} from './particle-system-widgets'

interface IUnityInspectorProps {
  readonly result: IUnitySemanticDiffResult
  readonly selectedFileId: UnityFileId | null
  readonly showUnchanged: boolean
  /**
   * Hide Prefab override rows flagged as Unity's floating-point
   * re-serialization noise from the Inspector. Controlled by the Diff options.
   */
  readonly hideFloatDrift: boolean
  readonly repository: Repository
  readonly docCache: ReadonlyMap<UnityFileId, IUnityDocumentDiff>
  /**
   * Individual Prefab overrides keyed by the target GameObject's fileID in
   * the merged hierarchy. Lets a nested-instance object show its own overrides
   * when selected rather than only surfacing them at the instance root.
   */
  readonly overridesByNode: ReadonlyMap<
    UnityFileId,
    ReadonlyArray<IUnityPrefabOverrideDiff>
  >
  /**
   * Repository-relative path of the file being diffed. Used as the fallback
   * "Prefab:" badge for nodes that are native to this file (i.e. not in
   * `result.sourcePrefabByExpandedNode`).
   */
  readonly currentFilePath: string
  /** Select (and reveal) a hierarchy node, e.g. when a reference is clicked. */
  readonly onNavigate: (fileId: UnityFileId) => void
}

interface IUnityInspectorState {
  /** Inspector component sections (by document fileId) the user collapsed. */
  readonly collapsedComponents: ReadonlySet<UnityFileId>
  /** Override-tree nodes (keyed by hierarchy path) the user collapsed. */
  readonly collapsedOverrideNodes: ReadonlySet<string>
  /**
   * Nested module / group sub-sections the user collapsed, keyed by
   * `${docFileId}::${moduleKey}` so the same module in two different
   * ParticleSystem documents keeps independent collapse state.
   */
  readonly collapsedModules: ReadonlySet<string>
}

/**
 * A group of Prefab overrides that all target the same (GameObject, component)
 * pair — the unit the Inspector renders as one section. `gameObjectPath` and
 * `componentType` come from the enrichment pass; an unresolved target lands in
 * the fallback bucket with an empty path and the raw fileID as its label.
 */
interface IOverrideSection {
  readonly key: string
  readonly gameObjectPath: string
  readonly gameObjectName: string
  readonly componentType: string
  readonly status: UnityChangeStatus
  readonly rows: ReadonlyArray<IOverrideRow>
  /** False when the override target couldn't be resolved to a real object. */
  readonly targetResolved: boolean
}

/**
 * A node in the Prefab-override tree — one GameObject in the source prefab
 * hierarchy. Every modified GameObject and every ancestor on the path to a
 * modified GameObject gets a node so the tree reads like Unity's Overrides
 * panel: expand from the root, drill into changed subtrees, land on the
 * object whose components you're inspecting.
 */
interface IOverrideTreeNode {
  readonly key: string
  /** Last segment of the hierarchy path, i.e. the object's own name. */
  readonly name: string
  /** Full hierarchy path from the source-prefab root. */
  readonly path: string
  /**
   * True when this node has its own override sections (the modified object),
   * false for pure spine nodes present only to reach a deeper modification.
   */
  readonly hasOverrides: boolean
  readonly sections: ReadonlyArray<IOverrideSection>
  readonly children: ReadonlyArray<IOverrideTreeNode>
  readonly status: UnityChangeStatus
  /** True when any override under this subtree could not be resolved. */
  readonly containsUnresolved: boolean
}

interface IOverrideVectorRow {
  readonly kind: 'vector'
  readonly label: string
  readonly status: UnityChangeStatus
  readonly axes: ReadonlyArray<{
    readonly axis: string
    readonly override: IUnityPrefabOverrideDiff
  }>
}

interface IOverrideScalarRow {
  readonly kind: 'scalar'
  readonly override: IUnityPrefabOverrideDiff
}

type IOverrideRow = IOverrideVectorRow | IOverrideScalarRow

// Sections that describe the GameObject itself (Name, Active, Tag, ...) render
// before its components, then Transform, then everything else. Mirrors Unity's
// own order in the Overrides panel.
const overrideComponentOrder = (typeName: string): number => {
  if (typeName === 'GameObject') {
    return 0
  }
  if (typeName === 'Transform' || typeName === 'RectTransform') {
    return 1
  }
  return 2
}

/**
 * Roll up the enriched flat override list into per-section rows: group by
 * target GameObject → target component, and inside each section coalesce
 * `foo.x/.y/.z/.w` (or `.r/.g/.b/.a`) siblings into a single vector row that
 * renders the way Unity's Inspector shows a Vector3/Quaternion field. Insertion
 * order is preserved throughout so the sections read in serialized order.
 *
 * `guidToBasename` names the source prefab a target belongs to so the fallback
 * bucket (targets we couldn't resolve to a GameObject in that source) still
 * reads as "sign_bord_s.fbx #<id>" rather than a bare "Unresolved" tag. It's
 * called only for the unresolved path, so an empty implementation is fine
 * when the caller has no way to resolve GUIDs.
 */
const groupOverrideSections = (
  overrides: ReadonlyArray<IUnityPrefabOverrideDiff>,
  guidToBasename: (guid: string) => string | undefined = () => undefined
): ReadonlyArray<IOverrideSection> => {
  interface IMutableVectorRow {
    readonly kind: 'vector'
    readonly label: string
    status: UnityChangeStatus
    readonly axes: Array<{
      readonly axis: string
      readonly override: IUnityPrefabOverrideDiff
    }>
  }

  interface IMutableSection {
    readonly key: string
    readonly gameObjectPath: string
    readonly gameObjectName: string
    readonly componentType: string
    readonly targetResolved: boolean
    status: UnityChangeStatus
    readonly ordinal: number
    readonly gameObjectOrdinal: number
    readonly rows: Array<IOverrideRow>
    readonly vectorByBase: Map<string, IMutableVectorRow>
  }

  const sectionByKey = new Map<string, IMutableSection>()
  const gameObjectOrdinals = new Map<string, number>()
  const unresolvedKey = '__unresolved__'
  const unresolvedOrdinalBase = Number.MAX_SAFE_INTEGER / 2
  let unresolvedCounter = 0
  let nextSectionOrdinal = 0

  const promoteStatus = (
    current: UnityChangeStatus,
    incoming: UnityChangeStatus
  ): UnityChangeStatus => {
    if (current === incoming) {
      return current
    }
    if (current === 'unchanged') {
      return incoming
    }
    if (incoming === 'unchanged') {
      return current
    }
    return 'modified'
  }

  for (const override of overrides) {
    const isResolved = override.targetKind !== undefined
    const gameObjectKey = isResolved
      ? override.targetGameObjectFileId ?? override.targetGameObjectPath ?? ''
      : `${unresolvedKey}::${override.targetGuid ?? ''}::${
          override.targetFileId
        }`
    const componentType = isResolved
      ? override.targetComponentType ?? override.targetKind ?? 'GameObject'
      : `#${override.targetFileId}`
    const sectionKey = isResolved
      ? `${gameObjectKey}::${componentType}`
      : gameObjectKey

    let section = sectionByKey.get(sectionKey)
    if (section === undefined) {
      let goOrdinal = gameObjectOrdinals.get(gameObjectKey)
      if (goOrdinal === undefined) {
        goOrdinal = isResolved
          ? gameObjectOrdinals.size
          : unresolvedOrdinalBase + unresolvedCounter++
        gameObjectOrdinals.set(gameObjectKey, goOrdinal)
      }
      const sourceBasename =
        !isResolved && override.targetGuid !== undefined
          ? guidToBasename(override.targetGuid)
          : undefined
      section = {
        key: sectionKey,
        gameObjectPath: isResolved ? override.targetGameObjectPath ?? '' : '',
        gameObjectName: isResolved
          ? override.targetGameObjectName ?? ''
          : sourceBasename ?? `fileID ${override.targetFileId}`,
        componentType,
        targetResolved: isResolved,
        status: 'unchanged',
        ordinal: nextSectionOrdinal++,
        gameObjectOrdinal: goOrdinal,
        rows: [],
        vectorByBase: new Map(),
      }
      sectionByKey.set(sectionKey, section)
    }
    section.status = promoteStatus(section.status, override.status)

    const vectorInfo = vectorAxisFromPropertyPath(override.propertyPath)
    if (vectorInfo !== null) {
      const { base, axis } = vectorInfo
      let vectorRow = section.vectorByBase.get(base)
      if (vectorRow === undefined) {
        vectorRow = {
          kind: 'vector',
          label: friendlyOverridePathLabel(base),
          status: 'unchanged',
          axes: [],
        }
        section.vectorByBase.set(base, vectorRow)
        section.rows.push(vectorRow)
      }
      vectorRow.axes.push({ axis, override })
      vectorRow.status = promoteStatus(vectorRow.status, override.status)
    } else {
      section.rows.push({ kind: 'scalar', override })
    }
  }

  // Sort so sibling GameObjects sit next to each other (segment-wise path
  // comparison, so `A/B` beats `A/C` and both beat `AA`), components under one
  // GameObject follow Unity's inspector order, and everything with an
  // unresolved target lands together at the end. Insertion order breaks ties
  // to keep the output stable.
  const comparePaths = (a: string, b: string): number => {
    const as = a.split('/')
    const bs = b.split('/')
    const n = Math.min(as.length, bs.length)
    for (let i = 0; i < n; i++) {
      if (as[i] !== bs[i]) {
        return as[i] < bs[i] ? -1 : 1
      }
    }
    return as.length - bs.length
  }
  const resolvedBucket = (o: number) => o < unresolvedOrdinalBase
  return Array.from(sectionByKey.values()).sort((a, b) => {
    const aResolved = resolvedBucket(a.gameObjectOrdinal)
    const bResolved = resolvedBucket(b.gameObjectOrdinal)
    if (aResolved !== bResolved) {
      return aResolved ? -1 : 1
    }
    if (aResolved) {
      const pathDelta = comparePaths(a.gameObjectPath, b.gameObjectPath)
      if (pathDelta !== 0) {
        return pathDelta
      }
    }
    if (a.gameObjectOrdinal !== b.gameObjectOrdinal) {
      return a.gameObjectOrdinal - b.gameObjectOrdinal
    }
    const componentDelta =
      overrideComponentOrder(a.componentType) -
      overrideComponentOrder(b.componentType)
    if (componentDelta !== 0) {
      return componentDelta
    }
    return a.ordinal - b.ordinal
  })
}

const promoteStatusFn = (
  current: UnityChangeStatus,
  incoming: UnityChangeStatus
): UnityChangeStatus => {
  if (current === incoming) {
    return current
  }
  if (current === 'unchanged') {
    return incoming
  }
  if (incoming === 'unchanged') {
    return current
  }
  return 'modified'
}

/**
 * Fold a flat list of override sections (each targeting one GameObject) into a
 * hierarchical tree by splitting `gameObjectPath` on `/`. The tree mirrors the
 * source prefab's GameObject hierarchy: every modified object gets a node and
 * every ancestor on the path to a modified object is included as a spine node.
 * Sections whose target couldn't be resolved go under a single "Unresolved"
 * bucket at the end. Two different GameObjects that happen to share the same
 * name-path (Unity permits duplicate names) are kept in ONE node — their
 * component sections stack inside it, since we have no better way to tell them
 * apart in the UI without exposing raw fileIDs.
 */
const buildOverrideTree = (
  sections: ReadonlyArray<IOverrideSection>
): ReadonlyArray<IOverrideTreeNode> => {
  interface IMutableNode {
    readonly name: string
    readonly path: string
    readonly key: string
    hasOverrides: boolean
    readonly sections: Array<IOverrideSection>
    readonly childByName: Map<string, IMutableNode>
    readonly children: Array<IMutableNode>
    status: UnityChangeStatus
    containsUnresolved: boolean
  }
  const makeNode = (name: string, path: string, key: string): IMutableNode => ({
    name,
    path,
    key,
    hasOverrides: false,
    sections: [],
    childByName: new Map(),
    children: [],
    status: 'unchanged',
    containsUnresolved: false,
  })
  const roots = new Array<IMutableNode>()
  const rootsByName = new Map<string, IMutableNode>()
  const unresolvedRoot: IMutableNode = makeNode(
    'Unresolved targets',
    '',
    '__unresolved__'
  )
  const insertResolved = (section: IOverrideSection) => {
    const segments = section.gameObjectPath.split('/').filter(s => s.length > 0)
    if (segments.length === 0) {
      // Section on the root object itself — attach as a synthetic single-node.
      const name = section.gameObjectName || '(root)'
      let node = rootsByName.get(name)
      if (node === undefined) {
        node = makeNode(name, name, name)
        rootsByName.set(name, node)
        roots.push(node)
      }
      node.sections.push(section)
      node.hasOverrides = true
      node.status = promoteStatusFn(node.status, section.status)
      return
    }
    // Build/reuse spine down to the target.
    let node: IMutableNode | undefined
    let path = ''
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      path = path.length === 0 ? segment : `${path}/${segment}`
      if (node === undefined) {
        node = rootsByName.get(segment)
        if (node === undefined) {
          node = makeNode(segment, path, path)
          rootsByName.set(segment, node)
          roots.push(node)
        }
      } else {
        let child = node.childByName.get(segment)
        if (child === undefined) {
          child = makeNode(segment, path, path)
          node.childByName.set(segment, child)
          node.children.push(child)
        }
        node = child
      }
    }
    if (node !== undefined) {
      node.sections.push(section)
      node.hasOverrides = true
      node.status = promoteStatusFn(node.status, section.status)
    }
  }
  const insertUnresolved = (section: IOverrideSection) => {
    unresolvedRoot.sections.push(section)
    unresolvedRoot.hasOverrides = true
    unresolvedRoot.status = promoteStatusFn(
      unresolvedRoot.status,
      section.status
    )
    unresolvedRoot.containsUnresolved = true
  }
  for (const section of sections) {
    if (section.targetResolved) {
      insertResolved(section)
    } else {
      insertUnresolved(section)
    }
  }
  // Post-process: aggregate status and containsUnresolved bottom-up.
  const finalize = (node: IMutableNode): IOverrideTreeNode => {
    const children = node.children.map(finalize)
    let status = node.status
    let containsUnresolved = node.containsUnresolved
    for (const child of children) {
      status = promoteStatusFn(status, child.status)
      if (child.containsUnresolved) {
        containsUnresolved = true
      }
    }
    return {
      key: node.key,
      name: node.name,
      path: node.path,
      hasOverrides: node.hasOverrides,
      sections: node.sections,
      children,
      status,
      containsUnresolved,
    }
  }
  const finalized = roots.map(finalize)
  if (unresolvedRoot.hasOverrides) {
    finalized.push(finalize(unresolvedRoot))
  }
  return finalized
}

export class UnityInspector extends React.Component<
  IUnityInspectorProps,
  IUnityInspectorState
> {
  public state: IUnityInspectorState = {
    collapsedComponents: new Set(),
    collapsedOverrideNodes: new Set(),
    collapsedModules: new Set(),
  }

  // Set while rendering a structural field so its arrays start collapsed. Read
  // synchronously during value-element construction (see renderPropertyRow).
  private forceCollapseArrays = false
  // Friendly labels for same-asset references, derived from the merged hierarchy
  // (memoized per result): a GameObject fileId → its name, and a component
  // fileId → its owning GameObject name + component type.
  private refLookupResult: IUnitySemanticDiffResult | null = null
  private gameObjectNameById = new Map<UnityFileId, string>()
  private componentOwnerById = new Map<
    UnityFileId,
    {
      readonly owner: string
      readonly ownerFileId: UnityFileId
      readonly type: string
    }
  >()
  // Memoized fileID → source-prefab path for the current result. Built lazily
  // and re-derived when the underlying result changes.
  private sourcePrefabByExpandedNodeCache: ReadonlyMap<
    UnityFileId,
    string
  > | null = null
  private sourcePrefabResult: IUnitySemanticDiffResult | null = null

  private sourcePrefabByExpandedNode(
    result: IUnitySemanticDiffResult
  ): ReadonlyMap<UnityFileId, string> {
    if (
      this.sourcePrefabByExpandedNodeCache !== null &&
      this.sourcePrefabResult === result
    ) {
      return this.sourcePrefabByExpandedNodeCache
    }
    this.sourcePrefabResult = result
    this.sourcePrefabByExpandedNodeCache = new Map(
      result.sourcePrefabByExpandedNode ?? []
    )
    return this.sourcePrefabByExpandedNodeCache
  }

  /**
   * Which repository-relative prefab path a hierarchy node belongs to. Nodes
   * expanded from a nested PrefabInstance report their source prefab; nodes
   * native to the file being diffed report that file. Basename is what the
   * badge renders — full path is the tooltip.
   */
  private prefabOriginFor(
    result: IUnitySemanticDiffResult,
    nodeFileId: UnityFileId
  ): string {
    return (
      this.sourcePrefabByExpandedNode(result).get(nodeFileId) ??
      this.props.currentFilePath
    )
  }

  public render() {
    return this.renderInspector(this.props.result)
  }

  private documentsById(): ReadonlyMap<UnityFileId, IUnityDocumentDiff> {
    return this.props.docCache
  }

  /** Build (once per result) the fileId → friendly-label maps for references. */
  private ensureRefLookup(result: IUnitySemanticDiffResult) {
    if (this.refLookupResult === result) {
      return
    }
    this.refLookupResult = result
    this.gameObjectNameById = new Map()
    this.componentOwnerById = new Map()
    const walk = (node: IUnityGameObjectDiffNode) => {
      this.gameObjectNameById.set(node.fileId, node.name)
      for (const component of node.components) {
        this.componentOwnerById.set(component.fileId, {
          owner: node.name,
          ownerFileId: node.fileId,
          type: component.typeName,
        })
      }
      node.children.forEach(walk)
    }
    result.roots.forEach(walk)
  }

  /**
   * An asset reference shown by file name only; hovering reveals the full disk
   * path with a copy hint, and clicking copies that absolute path to the
   * clipboard. `Path.join` keeps the path native to the host platform.
   */
  private renderAssetReference(relativePath: string) {
    const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1)
    const absolute = Path.join(this.props.repository.path, relativePath)
    return (
      <span
        className="unity-asset-ref"
        title={`${absolute}\nClick to copy path`}
        data-path={absolute}
        onClick={this.onCopyAssetPath}
      >
        {fileName}
      </span>
    )
  }

  private onCopyAssetPath = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation()
    const path = e.currentTarget.dataset.path
    if (path !== undefined) {
      clipboard.writeText(path)
    }
  }

  /** Collapse/expand an Inspector component section (keyed by its fileId). */
  private onToggleComponent = (e: React.MouseEvent<HTMLElement>) => {
    const fileId = e.currentTarget.dataset.fileid
    if (fileId === undefined) {
      return
    }
    const collapsedComponents = new Set(this.state.collapsedComponents)
    if (collapsedComponents.has(fileId)) {
      collapsedComponents.delete(fileId)
    } else {
      collapsedComponents.add(fileId)
    }
    this.setState({ collapsedComponents })
  }

  /** Collapse/expand a nested module or renderer group. */
  private onToggleModule = (e: React.MouseEvent<HTMLElement>) => {
    const key = e.currentTarget.dataset.moduleKey
    if (key === undefined) {
      return
    }
    const collapsedModules = new Set(this.state.collapsedModules)
    if (collapsedModules.has(key)) {
      collapsedModules.delete(key)
    } else {
      collapsedModules.add(key)
    }
    this.setState({ collapsedModules })
  }

  private renderInspector(result: IUnitySemanticDiffResult) {
    const selected = this.props.selectedFileId
    if (selected === null) {
      return <div className="unity-diff-message">Nothing selected</div>
    }

    // A PrefabInstance whose root landed in the merged hierarchy renders as a
    // normal GameObject — the tree already carries every one of its overrides
    // spread across the specific nested objects they affect, so a summary tree
    // at the root would just duplicate the tree with worse navigation. Only
    // orphan instances (no `nodeFileId`, surfaced by the top-level fallback
    // list) still use the standalone override-tree view since they have no
    // hierarchy position to attach to.
    const prefab = result.prefabInstances.find(
      p => p.fileId === selected && p.nodeFileId === undefined
    )
    if (prefab !== undefined) {
      return this.renderPrefabInspector(prefab)
    }

    const docs = this.documentsById()

    const gameObject = findGameObject(result.roots, selected)
    if (gameObject !== null) {
      const own = docs.get(gameObject.fileId)
      // Prefab overrides that specifically target THIS GameObject (from any
      // enclosing PrefabInstance). Route each into its target's component
      // section so a nested-instance node's inspector reads like a real
      // Inspector — one GameObject box, one Transform box, each carrying its
      // own component-level overrides — rather than a separate "Prefab
      // overrides" preamble that visually competes with the real components.
      const overridesHere = this.props.overridesByNode.get(gameObject.fileId)
      const visibleOverrides =
        overridesHere !== undefined
          ? overridesHere.filter(o => {
              if (!this.props.showUnchanged && o.status === 'unchanged') {
                return false
              }
              if (this.props.hideFloatDrift && o.trivialFloatDrift === true) {
                return false
              }
              return true
            })
          : []
      const guidToBasename = (guid: string): string | undefined => {
        const resolved = this.props.result.resolvedGuids.find(
          r => r.guid === guid
        )
        return resolved !== undefined
          ? basenameWithoutExtension(resolved.path)
          : undefined
      }
      // Partition overrides by their specific target fileID: those targeting
      // the GameObject itself, those matching one of its components, and the
      // rest (unresolved to a specific object — attached as a final section
      // so they aren't silently dropped).
      const overridesForTarget = new Map<
        UnityFileId,
        IUnityPrefabOverrideDiff[]
      >()
      const unresolvedOverrides: IUnityPrefabOverrideDiff[] = []
      for (const o of visibleOverrides) {
        const target = o.expandedTargetFileId
        if (target === undefined) {
          unresolvedOverrides.push(o)
          continue
        }
        const list = overridesForTarget.get(target) ?? []
        list.push(o)
        overridesForTarget.set(target, list)
      }
      const topLevelKeyOfPath = (path: string): string => {
        // "m_LocalPosition.x" → "m_LocalPosition", "urls.Array.data[0].url" →
        // "urls", "m_Name" → "m_Name". Everything before the first `.` or `[`.
        const idx = path.search(/[.[]/)
        return idx === -1 ? path : path.slice(0, idx)
      }
      const renderOverridesFor = (
        fileId: UnityFileId
      ): {
        readonly node: JSX.Element | null
        readonly hiddenKeys: ReadonlySet<string>
      } => {
        const overrides = overridesForTarget.get(fileId)
        if (overrides === undefined || overrides.length === 0) {
          return { node: null, hiddenKeys: new Set() }
        }
        const hiddenKeys = new Set<string>()
        for (const o of overrides) {
          hiddenKeys.add(topLevelKeyOfPath(o.propertyPath))
        }
        const sections = groupOverrideSections(overrides, guidToBasename)
        // Each override group's own component header is redundant when it
        // sits inside its owner component's section — the header above
        // already names the component. Just render the rows.
        const node = (
          <>
            {sections.map(section => (
              <div key={section.key} className="unity-properties">
                {section.rows.map((row, index) => (
                  <React.Fragment key={index}>
                    {row.kind === 'vector'
                      ? this.renderOverrideVectorRow(row)
                      : this.renderOverrideScalarRow(row.override)}
                  </React.Fragment>
                ))}
              </div>
            ))}
          </>
        )
        return { node, hiddenKeys }
      }
      // With unchanged hidden, drop the GameObject's own section and any
      // component with no property changes, rather than showing empty sections.
      // But a section still shows if any override targets it — the user needs
      // to see the diff even when the component's own state is unchanged.
      const showOwn =
        own !== undefined &&
        (this.props.showUnchanged ||
          own.status !== 'unchanged' ||
          overridesForTarget.has(gameObject.fileId))
      const visibleComponents = gameObject.components.filter(c => {
        if (this.props.showUnchanged || c.status !== 'unchanged') {
          return true
        }
        return overridesForTarget.has(c.fileId)
      })
      const unresolvedSections =
        unresolvedOverrides.length > 0
          ? groupOverrideSections(unresolvedOverrides, guidToBasename)
          : []
      const hasContent =
        showOwn || visibleComponents.length > 0 || unresolvedSections.length > 0
      const prefabPath = this.prefabOriginFor(result, gameObject.fileId)
      return (
        <>
          <h2 className="unity-inspector-title">
            <span className="unity-inspector-title-name">
              {gameObject.name.length > 0 ? gameObject.name : '(unnamed)'}
            </span>
            <span className="unity-inspector-title-prefab">
              Prefab: {this.renderAssetReference(prefabPath)}
            </span>
          </h2>
          {(() => {
            if (!showOwn || own === undefined) {
              return null
            }
            const { node, hiddenKeys } = renderOverridesFor(gameObject.fileId)
            return this.renderDocumentSection(
              'GameObject',
              own,
              result,
              node,
              hiddenKeys
            )
          })()}
          {visibleComponents.map(component => {
            const doc = docs.get(component.fileId)
            if (doc === undefined) {
              return null
            }
            const { node, hiddenKeys } = renderOverridesFor(component.fileId)
            return this.renderDocumentSection(
              component.typeName,
              doc,
              result,
              node,
              hiddenKeys
            )
          })}
          {unresolvedSections.length > 0 ? (
            <>
              <div
                className="unity-override-unresolved-divider"
                title={
                  'Prefab overrides whose target could not be traced to a ' +
                  'GameObject or component in this file — typically FBX-internal ' +
                  'ids Unity assigned without a name-table entry, or orphan ' +
                  'overrides on objects that no longer exist.'
                }
              >
                Unresolved overrides
              </div>
              {unresolvedSections.map(section =>
                this.renderOverrideSection(section, false)
              )}
            </>
          ) : null}
          {!hasContent ? (
            <div className="unity-properties unity-properties-empty">
              No changes in this object
            </div>
          ) : null}
        </>
      )
    }

    const document = docs.get(selected)
    if (document !== undefined) {
      return this.renderAssetInspector(document, result)
    }

    return <div className="unity-diff-message">Nothing selected</div>
  }

  /** Inspector for a standalone document (material, ScriptableObject, …). */
  private renderAssetInspector(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult
  ) {
    if (doc.typeName === 'AnimationClip') {
      return this.renderAnimationClipInspector(doc, result)
    }
    return (
      <>
        <h2 className="unity-inspector-title">{doc.typeName}</h2>
        {doc.typeName === 'Material'
          ? this.renderMaterialBody(doc, result)
          : this.renderProperties(
              doc.properties.filter(
                p => !(alwaysHiddenFields.has(p.key) && p.status !== 'modified')
              ),
              result
            )}
      </>
    )
  }

  /**
   * Friendly AnimationClip view — replaces both the standalone `.anim` path
   * and any embedded !u!74 doc inside a `.controller`. Falls back gracefully
   * when the semantic-diff result predates the animationClips field.
   */
  private renderAnimationClipInspector(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult
  ) {
    const clip = result.animationClips.find(c => c.fileId === doc.fileId)
    return (
      <AnimationClipInspector
        doc={doc}
        clip={clip}
        showUnchanged={this.props.showUnchanged}
      />
    )
  }

  /**
   * Material body: Shader and Render Queue, then the saved properties unpacked
   * into Textures / Floats / Colors sections (each only when changed if
   * unchanged are hidden). Plumbing is dropped; the rest shows when modified.
   */
  private renderMaterialBody(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult
  ) {
    const find = (key: string) => doc.properties.find(p => p.key === key)
    const handled = new Set([
      'm_Shader',
      'm_SavedProperties',
      'm_CustomRenderQueue',
    ])
    const sections: ReadonlyArray<readonly [string, string]> = [
      ['Textures', 'm_TexEnvs'],
      ['Floats', 'm_Floats'],
      ['Ints', 'm_Ints'],
      ['Colors', 'm_Colors'],
    ]
    const show = (prop: IUnityPropertyDiff | undefined) =>
      prop !== undefined &&
      (this.props.showUnchanged || prop.status !== 'unchanged')
    const shader = find('m_Shader')
    const renderQueue = find('m_CustomRenderQueue')
    const rest = doc.properties.filter(
      p => !handled.has(p.key) && p.status === 'modified'
    )
    return (
      <div className="unity-properties">
        {show(shader)
          ? this.renderLabeledValue('Shader', shader!, result)
          : null}
        {show(renderQueue)
          ? this.renderScalarField('Render Queue', renderQueue)
          : null}
        {sections.map(([label, key]) => {
          const prop = this.nestedProperty(doc, 'm_SavedProperties', key)
          return show(prop) ? (
            <React.Fragment key={key}>
              {this.renderLabeledValue(label, prop!, result)}
            </React.Fragment>
          ) : null
        })}
        {rest.map(prop => this.renderPropertyRow(prop, result, true))}
      </div>
    )
  }

  /** A synthetic property diff for a nested child (e.g. m_SavedProperties.m_Floats). */
  private nestedProperty(
    doc: IUnityDocumentDiff,
    parentKey: string,
    childKey: string
  ): IUnityPropertyDiff | undefined {
    const parent = doc.properties.find(p => p.key === parentKey)
    if (parent === undefined) {
      return undefined
    }
    const childOf = (value: UnityPropertyValue | null) =>
      value !== null && value.kind === 'map'
        ? value.entries.find(e => e.key === childKey)?.value ?? null
        : null
    const before = childOf(parent.before)
    const after = childOf(parent.after)
    if (before === null && after === null) {
      return undefined
    }
    const status: UnityChangeStatus =
      before === null
        ? 'added'
        : after === null
        ? 'removed'
        : valueEquals(before, after)
        ? 'unchanged'
        : 'modified'
    return { key: childKey, status, before, after }
  }

  private renderPrefabInspector(prefab: IUnityPrefabInstanceDiff) {
    const visible = prefab.overrides.filter(o => {
      if (!this.props.showUnchanged && o.status === 'unchanged') {
        return false
      }
      if (this.props.hideFloatDrift && o.trivialFloatDrift === true) {
        return false
      }
      return true
    })
    const guidToBasename = (guid: string): string | undefined => {
      const resolved = this.props.result.resolvedGuids.find(
        r => r.guid === guid
      )
      return resolved !== undefined
        ? basenameWithoutExtension(resolved.path)
        : undefined
    }
    const sections = groupOverrideSections(visible, guidToBasename)
    const tree = buildOverrideTree(sections)
    const sourceLabel =
      prefab.sourcePrefabPath !== undefined
        ? this.renderAssetReference(prefab.sourcePrefabPath)
        : prefab.sourcePrefabGuid ?? 'unknown'
    return (
      <>
        <h2 className="unity-inspector-title">{prefab.name}</h2>
        <div className="unity-inspector-meta">Prefab: {sourceLabel}</div>
        {tree.length === 0 ? (
          <div className="unity-properties unity-properties-empty">
            No override changes
          </div>
        ) : (
          <div className="unity-override-tree">
            {tree.map(node => this.renderOverrideTreeNode(node, 0))}
          </div>
        )}
      </>
    )
  }

  /**
   * Render one node of the Prefab-override tree: a click target that toggles
   * expansion, the node's own component-override sections when expanded, and
   * the recursively-rendered children. The unresolved bucket surfaces as a
   * distinguishable node (its `containsUnresolved` flag lets the CSS tint the
   * header differently).
   */
  private renderOverrideTreeNode(node: IOverrideTreeNode, depth: number) {
    const collapsed = this.state.collapsedOverrideNodes.has(node.key)
    const hasChildren = node.children.length > 0
    const hasContent = node.hasOverrides || hasChildren
    const toggleGlyph = !hasContent ? '·' : collapsed ? '▸' : '▾'
    const isUnresolvedRoot = node.key === '__unresolved__'
    return (
      <div
        key={node.key}
        className={`unity-override-node ${statusClass(node.status)} ${
          isUnresolvedRoot ? 'is-unresolved-root' : ''
        }`}
      >
        <div
          className="unity-override-node-header"
          data-node-key={node.key}
          onClick={hasContent ? this.onToggleOverrideNode : undefined}
          style={{ paddingLeft: `${depth * 12}px` }}
          title={
            isUnresolvedRoot
              ? 'Objects with no name in the source prefab — typically imported from an FBX with an empty internal name table, or Unity orphan overrides on objects that no longer exist.'
              : node.path
          }
        >
          <span className="unity-override-node-toggle">{toggleGlyph}</span>
          <span className="unity-override-node-name">{node.name}</span>
          {node.containsUnresolved && !isUnresolvedRoot && collapsed ? (
            <span className="unity-override-node-hint">
              contains unresolved
            </span>
          ) : null}
        </div>
        {collapsed ? null : (
          <>
            {node.sections.map(section => (
              <div
                key={section.key}
                className="unity-override-node-section"
                style={{ paddingLeft: `${(depth + 1) * 12}px` }}
              >
                {this.renderOverrideSection(section, false)}
              </div>
            ))}
            {node.children.map(child =>
              this.renderOverrideTreeNode(child, depth + 1)
            )}
          </>
        )}
      </div>
    )
  }

  private onToggleOverrideNode = (e: React.MouseEvent<HTMLElement>) => {
    const key = e.currentTarget.dataset.nodeKey
    if (key === undefined) {
      return
    }
    const collapsed = new Set(this.state.collapsedOverrideNodes)
    if (collapsed.has(key)) {
      collapsed.delete(key)
    } else {
      collapsed.add(key)
    }
    this.setState({ collapsedOverrideNodes: collapsed })
  }

  /**
   * Overrides for one (GameObject, component) pair. Rendered like a component
   * section in the regular Inspector — same header/box styling — with a
   * hierarchy breadcrumb showing where the target lives in the source prefab.
   * Adjacent sections that target the same GameObject only render the
   * breadcrumb once (`showPath: false` on the followers) so it doesn't read
   * as a wall of duplicated paths.
   */
  private renderOverrideSection(section: IOverrideSection, showPath: boolean) {
    return (
      <div
        key={section.key}
        className={`unity-component ${statusClass(section.status)}`}
      >
        <div className="unity-component-title">
          <span className="unity-component-name">{section.componentType}</span>
          {showPath && section.gameObjectPath.length > 0 ? (
            <span
              className="unity-override-path"
              title={section.gameObjectPath}
            >
              {section.gameObjectPath}
            </span>
          ) : null}
        </div>
        <div className="unity-properties">
          {section.rows.map((row, index) => (
            <React.Fragment key={index}>
              {row.kind === 'vector'
                ? this.renderOverrideVectorRow(row)
                : this.renderOverrideScalarRow(row.override)}
            </React.Fragment>
          ))}
        </div>
      </div>
    )
  }

  private renderOverrideVectorRow(row: IOverrideVectorRow) {
    const axisOrder = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a']
    const axes = [...row.axes].sort(
      (a, b) => axisOrder.indexOf(a.axis) - axisOrder.indexOf(b.axis)
    )
    return (
      <div
        className={`unity-property unity-vector ${statusClass(row.status)}`}
        title={axes[0]?.override.targetLabel ?? ''}
      >
        <span className="unity-property-key">{row.label}</span>
        <span className="unity-property-value unity-vector-axes">
          {axes.map(({ axis, override }) => {
            const b = scalarSide(override.before)
            const a = scalarSide(override.after)
            const changed = override.status === 'modified' && b !== a
            return (
              <span
                key={axis}
                className={`unity-axis ${
                  changed ? 'unity-status-modified' : ''
                }`}
              >
                <span className="unity-axis-label">{axis.toUpperCase()}</span>
                {override.status === 'modified' ? (
                  <>
                    <span className="unity-value-before">{b ?? ''}</span>
                    {' → '}
                    <span className="unity-value-after">{a ?? ''}</span>
                  </>
                ) : (
                  a ?? b ?? ''
                )}
              </span>
            )
          })}
        </span>
      </div>
    )
  }

  private renderOverrideScalarRow(override: IUnityPrefabOverrideDiff) {
    const label = friendlyOverridePathLabel(override.propertyPath)
    const synthetic: IUnityPropertyDiff = {
      key: override.propertyPath,
      status: override.status,
      before: override.before,
      after: override.after,
    }
    return (
      <div
        className={`unity-property ${statusClass(override.status)}`}
        title={override.targetLabel}
      >
        <span className="unity-property-key">{label}</span>
        <span className="unity-property-value">
          {this.renderPropertyValue(synthetic, this.props.result)}
        </span>
      </div>
    )
  }

  private renderDocumentSection(
    typeName: string,
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    overrideExtras: React.ReactNode = null,
    hiddenFromOverrides: ReadonlySet<string> = new Set()
  ) {
    const collapsed = this.state.collapsedComponents.has(doc.fileId)
    const toggleKey = toggleFieldFor(typeName, doc)
    const toggleProp =
      toggleKey !== undefined
        ? doc.properties.find(p => p.key === toggleKey)
        : undefined
    const scriptName = this.resolveMonoScriptFilename(typeName, doc, result)

    // Fields consumed by the header (the toggle becomes a checkbox, the script
    // becomes the title) never appear in the body. Plumbing fields are handled
    // per-body: dropped unless they changed. Fields overridden by an enclosing
    // PrefabInstance are also hidden from the body — the override row above is
    // the source of truth for their effective state; showing both would read
    // as duplication (a struck-through "Name" alongside the same field in the
    // component's regular property list).
    const hidden = new Set<string>(hiddenFromOverrides)
    if (toggleKey !== undefined) {
      hidden.add(toggleKey)
    }
    if (scriptName !== null) {
      hidden.add('m_Script')
    }

    // A component whose STATUS is unchanged but which receives Prefab
    // overrides from an enclosing instance should still tint modified — the
    // effective state has changed even though the component's own document
    // didn't. Override rows are shown ahead of the component's own body.
    const effectiveStatus =
      doc.status === 'unchanged' && overrideExtras !== null
        ? 'modified'
        : doc.status
    return (
      <div
        key={doc.fileId}
        className={`unity-component ${statusClass(effectiveStatus)}`}
      >
        <div
          className="unity-component-title"
          data-fileid={doc.fileId}
          onClick={this.onToggleComponent}
        >
          <span className="unity-component-toggle">
            {collapsed ? '▸' : '▾'}
          </span>
          {toggleProp !== undefined
            ? this.renderEnabledCheckbox(toggleProp)
            : null}
          <span className="unity-component-name">{scriptName ?? typeName}</span>
        </div>
        {collapsed ? null : (
          <>
            {overrideExtras}
            {this.renderComponentBody(typeName, doc, result, hidden)}
          </>
        )}
      </div>
    )
  }

  private renderComponentBody(
    typeName: string,
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    hidden: ReadonlySet<string>
  ) {
    if (typeName === 'GameObject') {
      return this.renderGameObjectBody(doc, result, hidden)
    }
    if (typeName === 'Transform' || typeName === 'RectTransform') {
      return this.renderTransformBody(typeName, doc, result, hidden)
    }
    if (typeName === 'AnimationClip') {
      return this.renderAnimationClipInspector(doc, result)
    }
    if (typeName === 'ParticleSystem') {
      return this.renderParticleSystemBody(doc, result, hidden)
    }
    if (typeName === 'ParticleSystemRenderer') {
      return this.renderParticleSystemRendererBody(doc, result, hidden)
    }
    const schema = schemaFor(typeName)
    if (schema !== undefined) {
      return this.renderSchemaBody(schema, doc, result, hidden)
    }
    // Plumbing and an empty m_Name show only when modified; the rest follows
    // the Show-unchanged toggle.
    const props = doc.properties.filter(
      p =>
        !hidden.has(p.key) &&
        !(
          (alwaysHiddenFields.has(p.key) || p.key === 'm_Name') &&
          p.status !== 'modified'
        )
    )
    return this.renderProperties(props, result)
  }

  /**
   * GameObject body in Unity's order: Name, then Tag / Layer / Static on one
   * row (Layer resolved to its project name, Static shown as a checkbox). Any
   * other field shows only when modified (collapsed).
   */
  private renderGameObjectBody(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    hidden: ReadonlySet<string>
  ) {
    const find = (key: string) =>
      hidden.has(key) ? undefined : doc.properties.find(p => p.key === key)
    const primary = new Set([
      'm_Name',
      'm_StaticEditorFlags',
      'm_TagString',
      'm_Layer',
    ])
    const layerName = (s: string | undefined) =>
      s === undefined ? '' : resolveLayerName(Number(s), result.layerNames)
    const staticBox = (s: string | undefined) =>
      s === undefined ? '' : s !== '0' ? '☑' : '☐'
    const name = find('m_Name')
    const tag = find('m_TagString')
    const layer = find('m_Layer')
    const staticFlags = find('m_StaticEditorFlags')
    const tagLayerStaticRow =
      tag !== undefined || layer !== undefined || staticFlags !== undefined ? (
        <div className="unity-go-tag-layer">
          {this.renderScalarField('Tag', tag)}
          {this.renderScalarField('Layer', layer, layerName)}
          {this.renderScalarField('Static', staticFlags, staticBox)}
        </div>
      ) : null
    return (
      <div className="unity-properties">
        {this.renderScalarField('Name', name)}
        {tagLayerStaticRow}
        {this.renderModifiedExtras(doc, result, hidden, primary)}
      </div>
    )
  }

  /**
   * Transform / RectTransform body as labeled vector rows (rotation shown as the
   * raw quaternion x y z w, no euler conversion). Other fields show only when
   * modified (collapsed).
   */
  private renderTransformBody(
    typeName: string,
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    hidden: ReadonlySet<string>
  ) {
    const find = (key: string) =>
      hidden.has(key) ? undefined : doc.properties.find(p => p.key === key)
    const rows =
      typeName === 'RectTransform'
        ? ([
            ['Anchor Min', 'm_AnchorMin'],
            ['Anchor Max', 'm_AnchorMax'],
            ['Anchored Position', 'm_AnchoredPosition'],
            ['Size Delta', 'm_SizeDelta'],
            ['Pivot', 'm_Pivot'],
            ['Rotation', 'm_LocalRotation'],
            ['Scale', 'm_LocalScale'],
          ] as const)
        : ([
            ['Position', 'm_LocalPosition'],
            ['Rotation', 'm_LocalRotation'],
            ['Scale', 'm_LocalScale'],
          ] as const)
    const primary = new Set<string>(rows.map(([, key]) => key))
    if (typeName === 'RectTransform') {
      primary.add('m_LocalPosition') // its Z folds into Anchored Position in Unity
    }
    return (
      <div className="unity-properties">
        {rows.map(([label, key]) => {
          const prop = find(key)
          return prop !== undefined ? (
            <React.Fragment key={key}>
              {this.renderVectorRow(label, prop)}
            </React.Fragment>
          ) : null
        })}
        {this.renderModifiedExtras(doc, result, hidden, primary)}
      </div>
    )
  }

  /**
   * Render one row of a typed schema field — the shared switch used by the
   * generic schema body, ParticleSystem modules, and ParticleSystemRenderer
   * groups. Auto-detects MinMaxCurve / MinMaxGradient / Color shapes when the
   * field is declared `value` so a schema entry without a specific `kind` still
   * gets the friendly widget when the value matches.
   */
  private renderTypedFieldRow(
    field: IFieldSpec,
    prop: IUnityPropertyDiff,
    result: IUnitySemanticDiffResult
  ): React.ReactNode {
    if (field.kind === 'vector') {
      return this.renderVectorRow(field.label, prop)
    }
    if (field.kind === 'bool') {
      return this.renderScalarField(field.label, prop, checkboxGlyph)
    }
    if (field.kind === 'enum') {
      const labels = field.enumLabels ?? new Map<string, string>()
      return (
        <div className={`unity-property ${statusClass(prop.status)}`}>
          <span className="unity-property-key">{field.label}</span>
          <span className="unity-property-value">
            <EnumFieldDisplay
              status={prop.status}
              before={prop.before}
              after={prop.after}
              labels={labels}
            />
          </span>
        </div>
      )
    }
    if (field.kind === 'color') {
      return (
        <div className={`unity-property ${statusClass(prop.status)}`}>
          <span className="unity-property-key">{field.label}</span>
          <span className="unity-property-value">
            <ColorFieldDisplay
              status={prop.status}
              before={prop.before}
              after={prop.after}
            />
          </span>
        </div>
      )
    }
    if (field.kind === 'minMaxCurve') {
      return (
        <div className={`unity-property ${statusClass(prop.status)}`}>
          <span className="unity-property-key">{field.label}</span>
          <span className="unity-property-value">
            <MinMaxCurveDisplay
              status={prop.status}
              before={prop.before}
              after={prop.after}
            />
          </span>
        </div>
      )
    }
    if (field.kind === 'minMaxGradient') {
      return (
        <div className={`unity-property ${statusClass(prop.status)}`}>
          <span className="unity-property-key">{field.label}</span>
          <span className="unity-property-value">
            <MinMaxGradientDisplay
              status={prop.status}
              before={prop.before}
              after={prop.after}
            />
          </span>
        </div>
      )
    }
    // 'value': auto-detect shape when possible so a schema that says `value` on
    // e.g. `startColor` still gets a swatch — keeps schemas compact.
    if (isMinMaxCurve(prop.after) || isMinMaxCurve(prop.before)) {
      return (
        <div className={`unity-property ${statusClass(prop.status)}`}>
          <span className="unity-property-key">{field.label}</span>
          <span className="unity-property-value">
            <MinMaxCurveDisplay
              status={prop.status}
              before={prop.before}
              after={prop.after}
            />
          </span>
        </div>
      )
    }
    if (isMinMaxGradient(prop.after) || isMinMaxGradient(prop.before)) {
      return (
        <div className={`unity-property ${statusClass(prop.status)}`}>
          <span className="unity-property-key">{field.label}</span>
          <span className="unity-property-value">
            <MinMaxGradientDisplay
              status={prop.status}
              before={prop.before}
              after={prop.after}
            />
          </span>
        </div>
      )
    }
    if (isColorMap(prop.after) || isColorMap(prop.before)) {
      return (
        <div className={`unity-property ${statusClass(prop.status)}`}>
          <span className="unity-property-key">{field.label}</span>
          <span className="unity-property-value">
            <ColorFieldDisplay
              status={prop.status}
              before={prop.before}
              after={prop.after}
            />
          </span>
        </div>
      )
    }
    if (
      isMultiModeParameter(prop.after) ||
      isMultiModeParameter(prop.before)
    ) {
      return (
        <div className={`unity-property ${statusClass(prop.status)}`}>
          <span className="unity-property-key">{field.label}</span>
          <span className="unity-property-value">
            <MultiModeParameterDisplay
              status={prop.status}
              before={prop.before}
              after={prop.after}
            />
          </span>
        </div>
      )
    }
    return this.renderLabeledValue(field.label, prop, result)
  }

  /**
   * Fallback row for a non-schema field inside a ParticleSystem module — same
   * auto-detection story, but starts from a plain property diff (no `label`
   * override). Uses the property's own key as the label after a light
   * friendliness pass through `friendlyOverridePathLabel`.
   */
  private renderAutoDetectedRow(
    prop: IUnityPropertyDiff,
    result: IUnitySemanticDiffResult,
    restModifiedOnly: boolean
  ): React.ReactNode {
    if (isMinMaxCurve(prop.after) || isMinMaxCurve(prop.before)) {
      return this.renderTypedFieldRow(
        {
          key: prop.key,
          label: friendlyOverridePathLabel(prop.key),
          kind: 'minMaxCurve',
        },
        prop,
        result
      )
    }
    if (isMinMaxGradient(prop.after) || isMinMaxGradient(prop.before)) {
      return this.renderTypedFieldRow(
        {
          key: prop.key,
          label: friendlyOverridePathLabel(prop.key),
          kind: 'minMaxGradient',
        },
        prop,
        result
      )
    }
    if (isColorMap(prop.after) || isColorMap(prop.before)) {
      return this.renderTypedFieldRow(
        {
          key: prop.key,
          label: friendlyOverridePathLabel(prop.key),
          kind: 'color',
        },
        prop,
        result
      )
    }
    if (
      isMultiModeParameter(prop.after) ||
      isMultiModeParameter(prop.before)
    ) {
      return this.renderTypedFieldRow(
        {
          key: prop.key,
          label: friendlyOverridePathLabel(prop.key),
          kind: 'value',
        },
        prop,
        result
      )
    }
    return this.renderPropertyRow(prop, result, restModifiedOnly)
  }

  /**
   * The ParticleSystem body: header row above a stack of collapsible module
   * boxes. Each module is a nested `unity-component` with its own optional
   * enabled checkbox — visually identical to the top-level component list, so
   * the eye can navigate this monster document one module at a time. Unknown
   * fields at the ParticleSystem root fall into a final "More" bucket shown
   * only when modified.
   */
  private renderParticleSystemBody(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    hidden: ReadonlySet<string>
  ) {
    const moduleKeys = new Set(particleSystemModules.map(m => m.key))
    const headerHandled = new Set(particleSystemHeaderSchema.fields.map(f => f.key))
    const headerRows = particleSystemHeaderSchema.fields
      .map(field => {
        if (hidden.has(field.key)) {
          return null
        }
        const prop = doc.properties.find(p => p.key === field.key)
        if (prop === undefined) {
          return null
        }
        if (
          !this.props.showUnchanged &&
          prop.status === 'unchanged' &&
          particleSystemHeaderSchema.restModifiedOnly
        ) {
          return null
        }
        return (
          <React.Fragment key={field.key}>
            {this.renderTypedFieldRow(field, prop, result)}
          </React.Fragment>
        )
      })
      .filter(row => row !== null)
    const moduleSections = particleSystemModules
      .map(module => this.renderParticleSystemModule(doc, result, module, hidden))
      .filter(section => section !== null)
    const restRows = doc.properties
      .filter(
        p =>
          !hidden.has(p.key) &&
          !moduleKeys.has(p.key) &&
          !headerHandled.has(p.key) &&
          this.restFieldVisible(p, true)
      )
      .map(p => (
        <React.Fragment key={p.key}>
          {this.renderAutoDetectedRow(p, result, true)}
        </React.Fragment>
      ))
    return (
      <>
        {headerRows.length > 0 ? (
          <div className="unity-properties unity-ps-header">{headerRows}</div>
        ) : null}
        <div className="unity-ps-modules">{moduleSections}</div>
        {restRows.length > 0 ? (
          <div className="unity-properties">{restRows}</div>
        ) : null}
      </>
    )
  }

  /**
   * Render one ParticleSystem module as a nested collapsible section. Returns
   * `null` when the module is absent from the document, or when it has no
   * visible content (unchanged + Show-unchanged off).
   */
  private renderParticleSystemModule(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    module: IParticleSystemModuleSchema,
    hidden: ReadonlySet<string>
  ): React.ReactNode {
    if (hidden.has(module.key)) {
      return null
    }
    const moduleProp = doc.properties.find(p => p.key === module.key)
    if (moduleProp === undefined) {
      return null
    }
    const moduleMap = moduleProp.after ?? moduleProp.before
    if (moduleMap === null || moduleMap.kind !== 'map') {
      return null
    }
    // Extract per-field property diffs by drilling one level into the module
    // map. Each entry becomes a synthetic `IUnityPropertyDiff` so the shared
    // row renderers can consume it just like a top-level property.
    const beforeEntries =
      moduleProp.before !== null && moduleProp.before.kind === 'map'
        ? new Map(moduleProp.before.entries.map(e => [e.key, e.value]))
        : new Map<string, UnityPropertyValue>()
    const afterEntries =
      moduleProp.after !== null && moduleProp.after.kind === 'map'
        ? new Map(moduleProp.after.entries.map(e => [e.key, e.value]))
        : new Map<string, UnityPropertyValue>()
    const childKeys = new Array<string>()
    const seen = new Set<string>()
    for (const key of [...afterEntries.keys(), ...beforeEntries.keys()]) {
      if (!seen.has(key)) {
        seen.add(key)
        childKeys.push(key)
      }
    }
    const childOf = (key: string): IUnityPropertyDiff => {
      const b = beforeEntries.get(key) ?? null
      const a = afterEntries.get(key) ?? null
      const status: UnityChangeStatus =
        b === null
          ? 'added'
          : a === null
          ? 'removed'
          : valueEquals(b, a)
          ? 'unchanged'
          : 'modified'
      return { key, status, before: b, after: a }
    }
    const enabledProp =
      module.enabledField !== undefined
        ? childOf(module.enabledField)
        : undefined
    const handledKeys = new Set(module.fields.map(f => f.key))
    if (module.enabledField !== undefined) {
      handledKeys.add(module.enabledField)
    }
    handledKeys.add('serializedVersion')

    const schemaRows = module.fields
      .map(field => {
        if (!childKeys.includes(field.key)) {
          return null
        }
        const prop = childOf(field.key)
        return (
          <React.Fragment key={field.key}>
            {this.renderTypedFieldRow(field, prop, result)}
          </React.Fragment>
        )
      })
      .filter(row => row !== null)
    const restRows = childKeys
      .filter(k => !handledKeys.has(k))
      .map(k => childOf(k))
      .filter(p =>
        p.key === 'm_Name' || alwaysHiddenFields.has(p.key)
          ? p.status === 'modified'
          : module.restModifiedOnly
          ? p.status === 'modified'
          : this.props.showUnchanged || p.status !== 'unchanged'
      )
      .map(p => (
        <React.Fragment key={p.key}>
          {this.renderAutoDetectedRow(p, result, module.restModifiedOnly)}
        </React.Fragment>
      ))

    const status: UnityChangeStatus = moduleProp.status
    const hasVisibleContent = schemaRows.length > 0 || restRows.length > 0
    if (
      !hasVisibleContent &&
      status === 'unchanged' &&
      !this.props.showUnchanged
    ) {
      return null
    }
    return this.renderNestedSection(
      `${doc.fileId}::${module.key}`,
      module.label,
      status,
      enabledProp,
      hasVisibleContent
        ? (
          <div className="unity-properties">
            {schemaRows}
            {restRows}
          </div>
        )
        : (
          <div className="unity-properties unity-properties-empty">
            No changes in this module
          </div>
        )
    )
  }

  /**
   * ParticleSystemRenderer body: grouped sub-sections
   * (Render / Sorting / Materials / Lighting / Probes) with the same nested
   * collapsible visual as ParticleSystem modules. Fields not enumerated in a
   * group fall into a final "More" bucket that shows only when modified —
   * Renderers carry a lot of lightmap plumbing users rarely touch.
   */
  private renderParticleSystemRendererBody(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    hidden: ReadonlySet<string>
  ) {
    const handled = new Set<string>()
    for (const group of particleSystemRendererGroups) {
      for (const field of group.fields) {
        handled.add(field.key)
      }
    }
    const sections = particleSystemRendererGroups
      .map(group => this.renderRendererGroup(doc, result, group, hidden))
      .filter(section => section !== null)
    const restRows = doc.properties
      .filter(
        p =>
          !hidden.has(p.key) &&
          !handled.has(p.key) &&
          this.restFieldVisible(p, true)
      )
      .map(p => (
        <React.Fragment key={p.key}>
          {this.renderAutoDetectedRow(p, result, true)}
        </React.Fragment>
      ))
    return (
      <>
        <div className="unity-ps-modules">{sections}</div>
        {restRows.length > 0 ? (
          <div className="unity-properties">{restRows}</div>
        ) : null}
      </>
    )
  }

  private renderRendererGroup(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    group: IParticleSystemRendererGroup,
    hidden: ReadonlySet<string>
  ): React.ReactNode {
    const rows = group.fields
      .map(field => {
        if (hidden.has(field.key)) {
          return null
        }
        const prop = doc.properties.find(p => p.key === field.key)
        if (prop === undefined) {
          return null
        }
        if (!this.props.showUnchanged && prop.status === 'unchanged') {
          return null
        }
        return (
          <React.Fragment key={field.key}>
            {this.renderTypedFieldRow(field, prop, result)}
          </React.Fragment>
        )
      })
      .filter(row => row !== null)
    // Aggregate status across the group's actual field diffs so the group
    // border reflects "did anything visible change here".
    let status: UnityChangeStatus = 'unchanged'
    for (const field of group.fields) {
      const prop = doc.properties.find(p => p.key === field.key)
      if (prop === undefined) {
        continue
      }
      if (prop.status !== 'unchanged') {
        status = 'modified'
        break
      }
    }
    if (rows.length === 0) {
      return null
    }
    return this.renderNestedSection(
      `${doc.fileId}::psr::${group.key}`,
      group.label,
      status,
      undefined,
      <div className="unity-properties">{rows}</div>
    )
  }

  /**
   * Nested collapsible sub-section (a module inside ParticleSystem, a group
   * inside ParticleSystemRenderer). Shares its visual language with the
   * top-level `.unity-component` box; a `.is-nested` modifier tightens the
   * header spacing so the two levels are visually distinct.
   */
  private renderNestedSection(
    stateKey: string,
    label: string,
    status: UnityChangeStatus,
    enabledProp: IUnityPropertyDiff | undefined,
    body: React.ReactNode
  ): React.ReactNode {
    const collapsed = this.state.collapsedModules.has(stateKey)
    return (
      <div
        key={stateKey}
        className={`unity-component is-nested ${statusClass(status)}`}
      >
        <div
          className="unity-component-title"
          data-module-key={stateKey}
          onClick={this.onToggleModule}
        >
          <span className="unity-component-toggle">
            {collapsed ? '▸' : '▾'}
          </span>
          {enabledProp !== undefined
            ? this.renderEnabledCheckbox(enabledProp)
            : null}
          <span className="unity-component-name">{label}</span>
        </div>
        {collapsed ? null : body}
      </div>
    )
  }

  /**
   * Whether a non-primary field appears: plumbing fields and an (empty) m_Name
   * only when modified; everything else either always-when-modified (mostly
   * internal sections) or per the global Show-unchanged toggle.
   */
  private restFieldVisible(
    prop: IUnityPropertyDiff,
    restModifiedOnly: boolean
  ): boolean {
    if (alwaysHiddenFields.has(prop.key) || prop.key === 'm_Name') {
      return prop.status === 'modified'
    }
    if (restModifiedOnly) {
      return prop.status === 'modified'
    }
    return this.props.showUnchanged || prop.status !== 'unchanged'
  }

  /**
   * Schema-driven body: render the listed fields with friendly labels (vectors
   * as X/Y/Z rows, bools as checkboxes), then the remaining fields either
   * filtered normally or only when modified (collapsed), per the schema.
   */
  private renderSchemaBody(
    schema: IComponentSchema,
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    hidden: ReadonlySet<string>
  ) {
    const find = (key: string) =>
      hidden.has(key) ? undefined : doc.properties.find(p => p.key === key)
    const handled = new Set(schema.fields.map(f => f.key))
    const restRows = doc.properties
      .filter(
        p =>
          !hidden.has(p.key) &&
          !handled.has(p.key) &&
          this.restFieldVisible(p, schema.restModifiedOnly)
      )
      .map(p => this.renderPropertyRow(p, result, schema.restModifiedOnly))
    return (
      <div className="unity-properties">
        {schema.fields.map(field => {
          const prop = find(field.key)
          if (prop === undefined) {
            return null
          }
          return (
            <React.Fragment key={field.key}>
              {this.renderTypedFieldRow(field, prop, result)}
            </React.Fragment>
          )
        })}
        {restRows}
      </div>
    )
  }

  /** A labeled row whose value uses the full value renderer (arrays, refs, …). */
  private renderLabeledValue(
    label: string,
    prop: IUnityPropertyDiff,
    result: IUnitySemanticDiffResult
  ) {
    return (
      <div className={`unity-property ${statusClass(prop.status)}`}>
        <span className="unity-property-key">{label}</span>
        <span className="unity-property-value">
          {this.renderPropertyValue(prop, result)}
        </span>
      </div>
    )
  }

  /** Remaining fields of a special section: shown only when modified, collapsed. */
  private renderModifiedExtras(
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult,
    hidden: ReadonlySet<string>,
    primary: ReadonlySet<string>
  ) {
    const extras = doc.properties.filter(
      p => !hidden.has(p.key) && !primary.has(p.key) && p.status === 'modified'
    )
    return extras.map(prop => this.renderPropertyRow(prop, result, true))
  }

  /** A labeled scalar field with diff (used for GameObject name/tag/layer). */
  private renderScalarField(
    label: string,
    prop: IUnityPropertyDiff | undefined,
    mapValue: (s: string | undefined) => string = s => displayScalar(s)
  ) {
    if (prop === undefined) {
      return null
    }
    const modelDefaultClass = (raw: string | undefined) =>
      isModelDefault(raw) ? ' unity-model-default' : ''
    return (
      <div className={`unity-property ${statusClass(prop.status)}`}>
        <span className="unity-property-key">{label}</span>
        <span className="unity-property-value">
          {prop.status === 'modified' ? (
            <>
              <span
                className={`unity-value-before${modelDefaultClass(
                  scalarSide(prop.before)
                )}`}
              >
                {mapValue(scalarSide(prop.before))}
              </span>
              {' → '}
              <span
                className={`unity-value-after${modelDefaultClass(
                  scalarSide(prop.after)
                )}`}
              >
                {mapValue(scalarSide(prop.after))}
              </span>
            </>
          ) : (
            (() => {
              const raw = scalarSide(prop.after ?? prop.before)
              return (
                <span className={modelDefaultClass(raw).trim()}>
                  {mapValue(raw)}
                </span>
              )
            })()
          )}
        </span>
      </div>
    )
  }

  /** A labeled vector row (X Y Z [W]); modified axes show before → after. */
  private renderVectorRow(label: string, prop: IUnityPropertyDiff) {
    const axesOf = (value: UnityPropertyValue | null) =>
      value !== null && value.kind === 'map'
        ? new Map(value.entries.map(e => [e.key, e.value]))
        : new Map<string, UnityPropertyValue>()
    const before = axesOf(prop.before)
    const after = axesOf(prop.after)
    const keys = ['x', 'y', 'z', 'w'].filter(k => before.has(k) || after.has(k))
    return (
      <div
        className={`unity-property unity-vector ${statusClass(prop.status)}`}
      >
        <span className="unity-property-key">{label}</span>
        <span className="unity-property-value unity-vector-axes">
          {keys.map(k => {
            const b = scalarSide(before.get(k) ?? null)
            const a = scalarSide(after.get(k) ?? null)
            const changed =
              prop.status === 'modified' &&
              before.has(k) &&
              after.has(k) &&
              b !== a
            const shown = a ?? b
            const modelDefaultClass = isModelDefault(shown)
              ? ' unity-model-default'
              : ''
            return (
              <span
                key={k}
                className={`unity-axis ${
                  changed ? 'unity-status-modified' : ''
                }${modelDefaultClass}`}
              >
                <span className="unity-axis-label">{k.toUpperCase()}</span>
                {changed ? (
                  <>
                    <span
                      className={`unity-value-before${
                        isModelDefault(b) ? ' unity-model-default' : ''
                      }`}
                    >
                      {displayScalar(b)}
                    </span>
                    {' → '}
                    <span
                      className={`unity-value-after${
                        isModelDefault(a) ? ' unity-model-default' : ''
                      }`}
                    >
                      {displayScalar(a)}
                    </span>
                  </>
                ) : (
                  displayScalar(shown)
                )}
              </span>
            )
          })}
        </span>
      </div>
    )
  }

  /** The MonoBehaviour script's file name (resolved via GUID), or null. */
  private resolveMonoScriptFilename(
    typeName: string,
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult
  ): string | null {
    if (typeName !== 'MonoBehaviour') {
      return null
    }
    const scriptProp = doc.properties.find(p => p.key === 'm_Script')
    const ref = scriptProp?.after ?? scriptProp?.before ?? null
    if (
      ref === null ||
      ref.kind !== 'reference' ||
      ref.reference.guid === undefined
    ) {
      return null
    }
    const resolved = result.resolvedGuids.find(
      g => g.guid === ref.reference.guid
    )
    return resolved !== undefined
      ? basenameWithoutExtension(resolved.path)
      : null
  }

  /** A Unity-style header checkbox for an enabled/active field's diff. */
  private renderEnabledCheckbox(prop: IUnityPropertyDiff) {
    const box = (value: string | undefined) => (value === '1' ? '☑' : '☐')
    if (prop.status === 'modified') {
      return (
        <span
          className="unity-enabled-checkbox is-modified"
          title={`${prop.key} changed`}
        >
          {box(scalarSide(prop.before))} → {box(scalarSide(prop.after))}
        </span>
      )
    }
    return (
      <span className="unity-enabled-checkbox" title={prop.key}>
        {box(scalarSide(prop.after ?? prop.before))}
      </span>
    )
  }

  private renderProperties(
    properties: ReadonlyArray<IUnityPropertyDiff>,
    result: IUnitySemanticDiffResult
  ) {
    const visible = this.props.showUnchanged
      ? properties
      : properties.filter(p => p.status !== 'unchanged')

    if (visible.length === 0) {
      return (
        <div className="unity-properties unity-properties-empty">
          No property changes
        </div>
      )
    }

    return (
      <div className="unity-properties">
        {visible.map(prop => this.renderPropertyRow(prop, result))}
      </div>
    )
  }

  private renderPropertyRow(
    prop: IUnityPropertyDiff,
    result: IUnitySemanticDiffResult,
    collapseArrays = false
  ) {
    // Render the value with arrays forced collapsed when asked. The flag is read
    // synchronously while the value's elements are built (each array's
    // defaultExpanded prop is computed now), so set-render-restore is safe.
    const previous = this.forceCollapseArrays
    this.forceCollapseArrays = collapseArrays
    const value = this.renderPropertyValue(prop, result)
    this.forceCollapseArrays = previous
    return (
      <div
        key={prop.key}
        className={`unity-property ${statusClass(prop.status)}`}
      >
        <span className="unity-property-key">{prop.key}</span>
        <span className="unity-property-value">{value}</span>
      </div>
    )
  }

  private renderPropertyValue(
    prop: IUnityPropertyDiff,
    result: IUnitySemanticDiffResult
  ): React.ReactNode {
    if (prop.status === 'modified') {
      return this.renderValueDiff(prop.before, prop.after, result)
    }
    const value = prop.after ?? prop.before
    return value !== null ? this.renderValue(value, result, prop.status) : ''
  }

  /**
   * Render a changed value. The flat property diff marks a whole container
   * (e.g. a Material's `m_SavedProperties`) modified when anything nested
   * changes; recursing here drills into maps and sequences so only the leaves
   * that actually differ are shown (struck-through before → after), instead of
   * dumping the entire subtree as one crossed-out blob.
   */
  private renderValueDiff(
    before: UnityPropertyValue | null,
    after: UnityPropertyValue | null,
    result: IUnitySemanticDiffResult
  ): React.ReactNode {
    if (before === null) {
      return (
        <span className="unity-value-after">
          {after !== null ? this.renderValue(after, result, 'added') : ''}
        </span>
      )
    }
    if (after === null) {
      return (
        <span className="unity-value-before">
          {this.renderValue(before, result, 'removed')}
        </span>
      )
    }
    if (before.kind === 'map' && after.kind === 'map') {
      return this.renderMapDiff(before.entries, after.entries, result)
    }
    if (before.kind === 'sequence' && after.kind === 'sequence') {
      return this.renderSequenceDiff(before.items, after.items, result)
    }
    return (
      <>
        <span className="unity-value-before">
          {this.renderValue(before, result, 'removed')}
        </span>
        {' → '}
        <span className="unity-value-after">
          {this.renderValue(after, result, 'added')}
        </span>
      </>
    )
  }

  private renderEntryDiff(
    label: string | number,
    before: UnityPropertyValue | null,
    after: UnityPropertyValue | null,
    status: UnityChangeStatus,
    keyClass: string,
    result: IUnitySemanticDiffResult
  ): React.ReactNode {
    return (
      <span className={`unity-diff-entry ${statusClass(status)}`}>
        <span className={keyClass}>{label}:</span>{' '}
        {status === 'unchanged'
          ? this.renderValue(
              (after ?? before) as UnityPropertyValue,
              result,
              status
            )
          : this.renderValueDiff(before, after, result)}
      </span>
    )
  }

  private renderMapDiff(
    before: ReadonlyArray<{
      readonly key: string
      readonly value: UnityPropertyValue
    }>,
    after: ReadonlyArray<{
      readonly key: string
      readonly value: UnityPropertyValue
    }>,
    result: IUnitySemanticDiffResult
  ): React.ReactNode {
    const beforeByKey = new Map(before.map(e => [e.key, e.value]))
    const afterByKey = new Map(after.map(e => [e.key, e.value]))
    const keys = new Array<string>()
    const seen = new Set<string>()
    for (const e of [...after, ...before]) {
      if (!seen.has(e.key)) {
        seen.add(e.key)
        keys.push(e.key)
      }
    }
    // A vector/color: lay the axes out horizontally, all shown with the changed
    // ones highlighted (rather than a vertical list of only the changed axes).
    if (isVectorLikeMap(before) || isVectorLikeMap(after)) {
      return (
        <span className="unity-vector-axes">
          {keys.map((key, index) => {
            const b = scalarSide(beforeByKey.get(key) ?? null)
            const a = scalarSide(afterByKey.get(key) ?? null)
            const changed =
              beforeByKey.has(key) && afterByKey.has(key) && b !== a
            return (
              <span
                key={index}
                className={`unity-axis ${
                  changed ? 'unity-status-modified' : ''
                }`}
              >
                <span className="unity-axis-label">{key.toUpperCase()}</span>
                {changed ? (
                  <>
                    <span className="unity-value-before">{b}</span>
                    {' → '}
                    <span className="unity-value-after">{a}</span>
                  </>
                ) : (
                  a ?? b ?? ''
                )}
              </span>
            )
          })}
        </span>
      )
    }
    const rows = keys
      .map(key => {
        const b = beforeByKey.get(key) ?? null
        const a = afterByKey.get(key) ?? null
        const status: UnityChangeStatus =
          b === null
            ? 'added'
            : a === null
            ? 'removed'
            : valueEquals(b, a)
            ? 'unchanged'
            : 'modified'
        return { key, b, a, status }
      })
      .filter(r => this.props.showUnchanged || r.status !== 'unchanged')
    return (
      <span className="unity-inline-map">
        {rows.map((r, index) => (
          <React.Fragment key={index}>
            {this.renderEntryDiff(
              r.key,
              r.b,
              r.a,
              r.status,
              'unity-map-key',
              result
            )}
          </React.Fragment>
        ))}
      </span>
    )
  }

  private renderSequenceDiff(
    before: ReadonlyArray<UnityPropertyValue>,
    after: ReadonlyArray<UnityPropertyValue>,
    result: IUnitySemanticDiffResult
  ): React.ReactNode {
    const allRows = diffPropertySequence(before, after)
    const rows = this.props.showUnchanged
      ? allRows
      : allRows.filter(r => r.status !== 'unchanged')
    const changedCount = allRows.filter(r => r.status !== 'unchanged').length
    const totalItems = Math.max(before.length, after.length)
    return (
      <CollapsibleArray
        summary={
          changedCount > 0
            ? `[${changedCount} of ${totalItems} changed]`
            : `[${totalItems} item${totalItems === 1 ? '' : 's'}]`
        }
        defaultExpanded={!this.forceCollapseArrays && rows.length <= 8}
        status="modified"
      >
        <span className="unity-sequence">
          {rows.map((r, i) => (
            <React.Fragment key={i}>
              {this.renderEntryDiff(
                r.index,
                r.before,
                r.after,
                r.status,
                'unity-sequence-index',
                result
              )}
            </React.Fragment>
          ))}
        </span>
      </CollapsibleArray>
    )
  }

  private renderValue(
    value: UnityPropertyValue,
    result: IUnitySemanticDiffResult,
    status: UnityChangeStatus
  ): React.ReactNode {
    switch (value.kind) {
      case 'scalar':
        // Long/multi-line scalars (serialized blobs, big text) collapse behind a
        // Show more toggle; short values render inline as-is.
        return value.value.length > 80 || value.value.includes('\n') ? (
          <CollapsibleValue>{value.value}</CollapsibleValue>
        ) : (
          value.value
        )
      case 'reference': {
        const ref = value.reference
        if (ref.guid !== undefined) {
          const resolved = result.resolvedGuids.find(g => g.guid === ref.guid)
          return resolved !== undefined
            ? this.renderAssetReference(resolved.path)
            : `guid ${ref.guid} (unresolved)`
        }
        if (ref.fileId === '0') {
          return 'None'
        }
        // A same-asset reference: show the target's GameObject name and type,
        // reveal the fileID on hover, and navigate to it on click. Fall back to
        // the document type, then the bare fileID when nothing resolves.
        this.ensureRefLookup(result)
        const goName = this.gameObjectNameById.get(ref.fileId)
        if (goName !== undefined) {
          return (
            <ReferenceValue
              label={`${goName.length > 0 ? goName : '(unnamed)'} (GameObject)`}
              fileId={ref.fileId}
              navigateFileId={ref.fileId}
              onNavigate={this.props.onNavigate}
            />
          )
        }
        const owner = this.componentOwnerById.get(ref.fileId)
        if (owner !== undefined) {
          return (
            <ReferenceValue
              label={`${owner.owner.length > 0 ? owner.owner : '(unnamed)'} (${
                owner.type
              })`}
              fileId={ref.fileId}
              navigateFileId={owner.ownerFileId}
              onNavigate={this.props.onNavigate}
            />
          )
        }
        const target = this.documentsById().get(ref.fileId)
        return target !== undefined ? (
          <ReferenceValue label={target.typeName} fileId={ref.fileId} />
        ) : (
          `fileID ${ref.fileId}`
        )
      }
      case 'map':
        if (value.entries.length === 0) {
          return '{}'
        }
        if (isVectorLikeMap(value.entries)) {
          return (
            <span className="unity-vector-axes">
              {value.entries.map((entry, index) => (
                <span key={index} className="unity-axis">
                  <span className="unity-axis-label">
                    {entry.key.toUpperCase()}
                  </span>
                  {scalarSide(entry.value)}
                </span>
              ))}
            </span>
          )
        }
        return (
          <span className="unity-inline-map">
            {value.entries.map((entry, index) => (
              <span key={index} className="unity-map-entry">
                <span className="unity-map-key">{entry.key}:</span>{' '}
                {this.renderValue(entry.value, result, status)}
              </span>
            ))}
          </span>
        )
      case 'sequence':
        if (value.items.length === 0) {
          return '[]'
        }
        return (
          <CollapsibleArray
            summary={`[${value.items.length} item${
              value.items.length === 1 ? '' : 's'
            }]`}
            defaultExpanded={
              !this.forceCollapseArrays && value.items.length <= 8
            }
            status={status}
          >
            <span className="unity-sequence">
              {value.items.map((item, index) => (
                <span key={index} className="unity-sequence-item">
                  <span className="unity-sequence-index">{index}:</span>{' '}
                  {this.renderValue(item, result, status)}
                </span>
              ))}
            </span>
          </CollapsibleArray>
        )
    }
  }
}
