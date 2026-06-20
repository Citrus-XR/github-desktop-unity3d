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
  IUnityPropertyDiff,
  IUnitySemanticDiffResult,
  UnityChangeStatus,
} from '../../../models/unity/semantic-diff'
import { valueEquals } from '../../../lib/unity/semantic-diff'
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
  IComponentSchema,
  isVectorLikeMap,
  resolveLayerName,
  scalarSide,
  schemaFor,
  statusClass,
  toggleFieldFor,
} from './inspector-fields'

interface IUnityInspectorProps {
  readonly result: IUnitySemanticDiffResult
  readonly selectedFileId: UnityFileId | null
  readonly showUnchanged: boolean
  readonly repository: Repository
  readonly docCache: ReadonlyMap<UnityFileId, IUnityDocumentDiff>
  readonly prefabByNode: ReadonlyMap<UnityFileId, IUnityPrefabInstanceDiff>
  /** Select (and reveal) a hierarchy node, e.g. when a reference is clicked. */
  readonly onNavigate: (fileId: UnityFileId) => void
}

interface IUnityInspectorState {
  /** Inspector component sections (by document fileId) the user collapsed. */
  readonly collapsedComponents: ReadonlySet<UnityFileId>
}

export class UnityInspector extends React.Component<
  IUnityInspectorProps,
  IUnityInspectorState
> {
  public state: IUnityInspectorState = { collapsedComponents: new Set() }

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
    { readonly owner: string; readonly ownerFileId: UnityFileId; readonly type: string }
  >()

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

  private renderInspector(result: IUnitySemanticDiffResult) {
    const selected = this.props.selectedFileId
    if (selected === null) {
      return <div className="unity-diff-message">Nothing selected</div>
    }

    // A prefab instance node selected in the hierarchy shows its override diff.
    const prefabAtNode = this.props.prefabByNode.get(selected)
    if (prefabAtNode !== undefined) {
      return this.renderPrefabInspector(prefabAtNode)
    }

    const prefab = result.prefabInstances.find(p => p.fileId === selected)
    if (prefab !== undefined) {
      return this.renderPrefabInspector(prefab)
    }

    const docs = this.documentsById()

    const gameObject = findGameObject(result.roots, selected)
    if (gameObject !== null) {
      const own = docs.get(gameObject.fileId)
      // With unchanged hidden, drop the GameObject's own section and any
      // component with no property changes, rather than showing empty sections.
      const showOwn =
        own !== undefined &&
        (this.props.showUnchanged || own.status !== 'unchanged')
      const visibleComponents = this.props.showUnchanged
        ? gameObject.components
        : gameObject.components.filter(c => c.status !== 'unchanged')
      const hasContent = showOwn || visibleComponents.length > 0
      return (
        <>
          <h2 className="unity-inspector-title">
            {gameObject.name.length > 0 ? gameObject.name : '(unnamed)'}
          </h2>
          {showOwn ? this.renderDocumentSection('GameObject', own, result) : null}
          {visibleComponents.map(component => {
            const doc = docs.get(component.fileId)
            return doc !== undefined
              ? this.renderDocumentSection(component.typeName, doc, result)
              : null
          })}
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
    return (
      <>
        <h2 className="unity-inspector-title">{doc.typeName}</h2>
        {doc.typeName === 'Material'
          ? this.renderMaterialBody(doc, result)
          : this.renderProperties(
              doc.properties.filter(
                p =>
                  !(
                    alwaysHiddenFields.has(p.key) && p.status !== 'modified'
                  )
              ),
              result
            )}
      </>
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
        {show(shader) ? this.renderLabeledValue('Shader', shader!, result) : null}
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
    const visible = this.props.showUnchanged
      ? prefab.overrides
      : prefab.overrides.filter(o => o.status !== 'unchanged')
    return (
      <>
        <h2 className="unity-inspector-title">{prefab.name}</h2>
        <div className="unity-inspector-meta">
          Prefab: {prefab.sourcePrefabPath ?? prefab.sourcePrefabGuid ?? 'unknown'}
        </div>
        <div className="unity-component-title">Overrides</div>
        {visible.length === 0 ? (
          <div className="unity-properties unity-properties-empty">
            No override changes
          </div>
        ) : (
          <div className="unity-properties">
            {visible.map((override, index) => (
              <div
                key={`${override.targetFileId}-${override.propertyPath}-${index}`}
                className={`unity-property ${statusClass(override.status)}`}
              >
                <span
                  className="unity-property-key"
                  title={`target ${override.targetLabel}`}
                >
                  {override.propertyPath}
                </span>
                <span className="unity-property-value">
                  {override.status === 'modified' ? (
                    <>
                      <span className="unity-value-before">
                        {override.before ?? ''}
                      </span>
                      {' → '}
                      <span className="unity-value-after">
                        {override.after ?? ''}
                      </span>
                    </>
                  ) : (
                    override.after ?? override.before ?? ''
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  private renderDocumentSection(
    typeName: string,
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult
  ) {
    const collapsed = this.state.collapsedComponents.has(doc.fileId)
    const toggleKey = toggleFieldFor(typeName, doc)
    const toggleProp =
      toggleKey !== undefined
        ? doc.properties.find(p => p.key === toggleKey)
        : undefined
    const scriptName = this.componentScriptName(typeName, doc, result)

    // Fields consumed by the header (the toggle becomes a checkbox, the script
    // becomes the title) never appear in the body. Plumbing fields are handled
    // per-body: dropped unless they changed.
    const hidden = new Set<string>()
    if (toggleKey !== undefined) {
      hidden.add(toggleKey)
    }
    if (scriptName !== null) {
      hidden.add('m_Script')
    }

    return (
      <div
        key={doc.fileId}
        className={`unity-component ${statusClass(doc.status)}`}
      >
        <div
          className="unity-component-title"
          data-fileid={doc.fileId}
          onClick={this.onToggleComponent}
        >
          <span className="unity-component-toggle">{collapsed ? '▸' : '▾'}</span>
          {toggleProp !== undefined
            ? this.renderEnabledCheckbox(toggleProp)
            : null}
          <span className="unity-component-name">{scriptName ?? typeName}</span>
        </div>
        {collapsed ? null : this.renderComponentBody(typeName, doc, result, hidden)}
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
    const find = (key: string) => doc.properties.find(p => p.key === key)
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
    return (
      <div className="unity-properties">
        {this.renderScalarField('Name', find('m_Name'))}
        <div className="unity-go-tag-layer">
          {this.renderScalarField('Tag', find('m_TagString'))}
          {this.renderScalarField('Layer', find('m_Layer'), layerName)}
          {this.renderScalarField('Static', find('m_StaticEditorFlags'), staticBox)}
        </div>
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
    const find = (key: string) => doc.properties.find(p => p.key === key)
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
    const find = (key: string) => doc.properties.find(p => p.key === key)
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
          const row =
            field.kind === 'vector'
              ? this.renderVectorRow(field.label, prop)
              : field.kind === 'bool'
              ? this.renderScalarField(field.label, prop, checkboxGlyph)
              : this.renderLabeledValue(field.label, prop, result)
          return <React.Fragment key={field.key}>{row}</React.Fragment>
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
      p =>
        !hidden.has(p.key) &&
        !primary.has(p.key) &&
        p.status === 'modified'
    )
    return extras.map(prop => this.renderPropertyRow(prop, result, true))
  }

  /** A labeled scalar field with diff (used for GameObject name/tag/layer). */
  private renderScalarField(
    label: string,
    prop: IUnityPropertyDiff | undefined,
    mapValue: (s: string | undefined) => string = s => s ?? ''
  ) {
    if (prop === undefined) {
      return null
    }
    return (
      <div className={`unity-property ${statusClass(prop.status)}`}>
        <span className="unity-property-key">{label}</span>
        <span className="unity-property-value">
          {prop.status === 'modified' ? (
            <>
              <span className="unity-value-before">
                {mapValue(scalarSide(prop.before))}
              </span>
              {' → '}
              <span className="unity-value-after">
                {mapValue(scalarSide(prop.after))}
              </span>
            </>
          ) : (
            mapValue(scalarSide(prop.after ?? prop.before))
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
    const keys = ['x', 'y', 'z', 'w'].filter(
      k => before.has(k) || after.has(k)
    )
    return (
      <div className={`unity-property unity-vector ${statusClass(prop.status)}`}>
        <span className="unity-property-key">{label}</span>
        <span className="unity-property-value unity-vector-axes">
          {keys.map(k => {
            const b = scalarSide(before.get(k) ?? null)
            const a = scalarSide(after.get(k) ?? null)
            const changed =
              prop.status === 'modified' && before.has(k) && after.has(k) && b !== a
            return (
              <span
                key={k}
                className={`unity-axis ${changed ? 'unity-status-modified' : ''}`}
              >
                <span className="unity-axis-label">{k.toUpperCase()}</span>
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
      </div>
    )
  }


  /** The MonoBehaviour script's file name (resolved via GUID), or null. */
  private componentScriptName(
    typeName: string,
    doc: IUnityDocumentDiff,
    result: IUnitySemanticDiffResult
  ): string | null {
    if (typeName !== 'MonoBehaviour') {
      return null
    }
    const scriptProp = doc.properties.find(p => p.key === 'm_Script')
    const ref = scriptProp?.after ?? scriptProp?.before ?? null
    if (ref === null || ref.kind !== 'reference' || ref.reference.guid === undefined) {
      return null
    }
    const resolved = result.resolvedGuids.find(g => g.guid === ref.reference.guid)
    return resolved !== undefined ? basenameWithoutExtension(resolved.path) : null
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
    return value !== null ? this.renderValue(value, result) : ''
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
          {after !== null ? this.renderValue(after, result) : ''}
        </span>
      )
    }
    if (after === null) {
      return (
        <span className="unity-value-before">
          {this.renderValue(before, result)}
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
          {this.renderValue(before, result)}
        </span>
        {' → '}
        <span className="unity-value-after">
          {this.renderValue(after, result)}
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
          ? this.renderValue((after ?? before) as UnityPropertyValue, result)
          : this.renderValueDiff(before, after, result)}
      </span>
    )
  }

  private renderMapDiff(
    before: ReadonlyArray<{ readonly key: string; readonly value: UnityPropertyValue }>,
    after: ReadonlyArray<{ readonly key: string; readonly value: UnityPropertyValue }>,
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
            const changed = beforeByKey.has(key) && afterByKey.has(key) && b !== a
            return (
              <span
                key={index}
                className={`unity-axis ${changed ? 'unity-status-modified' : ''}`}
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
    const length = Math.max(before.length, after.length)
    const rows = new Array<{
      index: number
      b: UnityPropertyValue | null
      a: UnityPropertyValue | null
      status: UnityChangeStatus
    }>()
    for (let index = 0; index < length; index++) {
      const b = before[index] ?? null
      const a = after[index] ?? null
      const status: UnityChangeStatus =
        b === null
          ? 'added'
          : a === null
          ? 'removed'
          : valueEquals(b, a)
          ? 'unchanged'
          : 'modified'
      if (this.props.showUnchanged || status !== 'unchanged') {
        rows.push({ index, b, a, status })
      }
    }
    return (
      <CollapsibleArray
        summary={
          rows.length === length
            ? `[${length} item${length === 1 ? '' : 's'}]`
            : `[${rows.length} of ${length} changed]`
        }
        defaultExpanded={!this.forceCollapseArrays && rows.length <= 8}
      >
        <span className="unity-sequence">
          {rows.map(r => (
            <React.Fragment key={r.index}>
              {this.renderEntryDiff(
                r.index,
                r.b,
                r.a,
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
    result: IUnitySemanticDiffResult
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
              label={`${owner.owner.length > 0 ? owner.owner : '(unnamed)'} (${owner.type})`}
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
                {this.renderValue(entry.value, result)}
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
          >
            <span className="unity-sequence">
              {value.items.map((item, index) => (
                <span key={index} className="unity-sequence-item">
                  <span className="unity-sequence-index">{index}:</span>{' '}
                  {this.renderValue(item, result)}
                </span>
              ))}
            </span>
          </CollapsibleArray>
        )
    }
  }
}
