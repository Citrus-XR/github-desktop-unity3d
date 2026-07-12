/**
 * Pure field-classification and value-formatting helpers shared by the Unity
 * hierarchy and Inspector renderers: which fields are plumbing, which component
 * types get a friendly field schema, how a layer index resolves to a name, etc.
 * No React and no component state — just data and formatting.
 */

import {
  IUnityPropertyNode,
  UnityFileId,
  UnityPropertyValue,
} from '../../../models/unity/serialized-asset'
import {
  IUnityDocumentDiff,
  IUnityGameObjectDiffNode,
  UnityChangeStatus,
} from '../../../models/unity/semantic-diff'
import { MODEL_DEFAULT_MARKER } from '../../../lib/unity/model-prefab'

export { basenameWithoutExtension } from '../../../lib/unity/asset-diff'

export const statusClass = (status: UnityChangeStatus): string =>
  `unity-status-${status}`

// Plumbing present on most objects that the Unity Inspector never shows; only
// surfaced when modified.
export const alwaysHiddenFields: ReadonlySet<string> = new Set([
  'm_ObjectHideFlags',
  'm_CorrespondingSourceObject',
  'm_PrefabInstance',
  'm_PrefabAsset',
  'm_GameObject',
  'm_EditorHideFlags',
  'm_EditorClassIdentifier',
  'serializedVersion',
])

// Built-in Unity layer names (0–7), the fallback when TagManager.asset can't be
// read. Indices 3, 6, 7 are reserved/unnamed.
const builtinLayerNames: ReadonlyArray<string> = [
  'Default',
  'TransparentFX',
  'Ignore Raycast',
  '',
  'Water',
  'UI',
  '',
  '',
]

/** Resolve a layer index to its name (project table, then built-ins). */
export const resolveLayerName = (
  index: number,
  layerNames: ReadonlyArray<string> | undefined
): string => {
  const fromProject = layerNames?.[index]
  if (fromProject !== undefined && fromProject.length > 0) {
    return fromProject
  }
  const builtin = builtinLayerNames[index]
  return builtin !== undefined && builtin.length > 0
    ? builtin
    : `Layer ${index}`
}

/** The scalar value of a property on one side, or undefined. */
export const scalarSide = (
  value: UnityPropertyValue | null
): string | undefined =>
  value !== null && value.kind === 'scalar' ? value.value : undefined

/** Human-readable label the Inspector shows in place of the raw model-default sentinel. */
export const MODEL_DEFAULT_LABEL = 'Model default'

/** Whether a raw scalar string is the model-default sentinel emitted for synthesized objects. */
export const isModelDefault = (value: string | undefined): boolean =>
  value === MODEL_DEFAULT_MARKER

/**
 * Format one side's scalar for display: translates the model-default sentinel
 * to its user-facing label, passes everything else through untouched. Use this
 * anywhere a synthesized value can flow into user-facing text.
 */
export const displayScalar = (value: string | undefined): string =>
  isModelDefault(value) ? MODEL_DEFAULT_LABEL : value ?? ''

/** The field whose value drives a component's header checkbox, if any. */
export const toggleFieldFor = (
  typeName: string,
  doc: IUnityDocumentDiff
): string | undefined => {
  if (typeName === 'GameObject') {
    return 'm_IsActive'
  }
  return doc.properties.some(p => p.key === 'm_Enabled')
    ? 'm_Enabled'
    : undefined
}

// A field-list schema for components that just need a friendly, ordered subset
// of fields (label + kind) with the rest either filtered normally or shown only
// when modified. Types with a bespoke layout (GameObject/Transform) don't use it.
type FieldKind = 'value' | 'bool' | 'vector'
export interface IFieldSpec {
  readonly key: string
  readonly label: string
  readonly kind: FieldKind
}
export interface IComponentSchema {
  readonly fields: ReadonlyArray<IFieldSpec>
  /** True to show non-schema fields only when modified (mostly-internal types). */
  readonly restModifiedOnly: boolean
}

// Collider family (Box/Sphere/Capsule/Mesh + 2D): friendly Center/Size/etc.;
// only the fields a given collider has render. Remaining fields use the normal
// filter (radius/material are user-facing, layer overrides are unchanged-noise).
const colliderSchema: IComponentSchema = {
  restModifiedOnly: false,
  fields: [
    { key: 'm_Center', label: 'Center', kind: 'vector' },
    { key: 'm_Size', label: 'Size', kind: 'vector' },
    { key: 'm_Radius', label: 'Radius', kind: 'value' },
    { key: 'm_Height', label: 'Height', kind: 'value' },
    { key: 'm_Direction', label: 'Direction', kind: 'value' },
    { key: 'm_Convex', label: 'Convex', kind: 'bool' },
    { key: 'm_IsTrigger', label: 'Is Trigger', kind: 'bool' },
    { key: 'm_Material', label: 'Material', kind: 'value' },
  ],
}

const componentSchemas: ReadonlyMap<string, IComponentSchema> = new Map([
  [
    'Rigidbody',
    {
      restModifiedOnly: true,
      fields: [
        { key: 'm_Mass', label: 'Mass', kind: 'value' },
        { key: 'm_Drag', label: 'Drag', kind: 'value' },
        { key: 'm_AngularDrag', label: 'Angular Drag', kind: 'value' },
        { key: 'm_UseGravity', label: 'Use Gravity', kind: 'bool' },
        { key: 'm_IsKinematic', label: 'Is Kinematic', kind: 'bool' },
        { key: 'm_Interpolate', label: 'Interpolate', kind: 'value' },
        {
          key: 'm_CollisionDetection',
          label: 'Collision Detection',
          kind: 'value',
        },
        { key: 'm_Constraints', label: 'Constraints', kind: 'value' },
      ],
    },
  ],
  [
    'MeshRenderer',
    {
      restModifiedOnly: true,
      fields: [
        { key: 'm_Materials', label: 'Materials', kind: 'value' },
        { key: 'm_CastShadows', label: 'Cast Shadows', kind: 'value' },
        { key: 'm_ReceiveShadows', label: 'Receive Shadows', kind: 'bool' },
        {
          key: 'm_StaticShadowCaster',
          label: 'Static Shadow Caster',
          kind: 'bool',
        },
        { key: 'm_MotionVectors', label: 'Motion Vectors', kind: 'value' },
        { key: 'm_DynamicOccludee', label: 'Dynamic Occlusion', kind: 'bool' },
        { key: 'm_ReceiveGI', label: 'Receive GI', kind: 'value' },
        { key: 'm_LightProbeUsage', label: 'Light Probes', kind: 'value' },
        {
          key: 'm_ReflectionProbeUsage',
          label: 'Reflection Probes',
          kind: 'value',
        },
        { key: 'm_ProbeAnchor', label: 'Anchor Override', kind: 'value' },
      ],
    },
  ],
])

export const schemaFor = (typeName: string): IComponentSchema | undefined =>
  typeName.includes('Collider')
    ? colliderSchema
    : componentSchemas.get(typeName)

/** Render a 0/1 scalar value as a checkbox glyph, passing anything else through. */
export const checkboxGlyph = (value: string | undefined): string =>
  value === '1' ? '☑' : value === '0' ? '☐' : value ?? ''

// A small all-scalar map keyed by axis/channel letters (a Vector2/3/4 or a
// Color), which reads better laid out horizontally than stacked.
const vectorAxisKeys = 'xyzwrgba'
export const isVectorLikeMap = (
  entries: ReadonlyArray<IUnityPropertyNode>
): boolean =>
  entries.length > 0 &&
  entries.length <= 4 &&
  entries.every(
    e =>
      e.value.kind === 'scalar' &&
      e.key.length === 1 &&
      vectorAxisKeys.includes(e.key)
  )

/**
 * Split a Prefab override propertyPath into its base and vector axis, e.g.
 * `m_LocalRotation.x` → `{ base: 'm_LocalRotation', axis: 'x' }`. Returns null
 * for a scalar path so the caller can render it without vector coalescing.
 */
const vectorAxisPattern = /^(.+)\.([xyzwrgba])$/
export const vectorAxisFromPropertyPath = (
  propertyPath: string
): { readonly base: string; readonly axis: string } | null => {
  const match = vectorAxisPattern.exec(propertyPath)
  return match === null ? null : { base: match[1], axis: match[2] }
}

// Friendly Inspector labels for common override property paths. Names Unity's
// own Overrides panel uses instead of the internal m_ field name.
const friendlyOverridePathLabels: ReadonlyMap<string, string> = new Map([
  ['m_Name', 'Name'],
  ['m_IsActive', 'Active'],
  ['m_Enabled', 'Enabled'],
  ['m_TagString', 'Tag'],
  ['m_Layer', 'Layer'],
  ['m_StaticEditorFlags', 'Static'],
  ['m_LocalPosition', 'Position'],
  ['m_LocalRotation', 'Rotation'],
  ['m_LocalScale', 'Scale'],
  ['m_LocalEulerAnglesHint', 'Euler Angles'],
  ['m_AnchoredPosition', 'Anchored Position'],
  ['m_AnchorMin', 'Anchor Min'],
  ['m_AnchorMax', 'Anchor Max'],
  ['m_SizeDelta', 'Size Delta'],
  ['m_Pivot', 'Pivot'],
  ['m_Size', 'Size'],
  ['m_Center', 'Center'],
  ['m_Radius', 'Radius'],
  ['m_Height', 'Height'],
  ['m_Materials', 'Materials'],
  ['m_Material', 'Material'],
  ['m_Mesh', 'Mesh'],
  ['m_Script', 'Script'],
])

/**
 * Friendlier label for an override propertyPath. Known field names are mapped
 * to their Inspector counterpart; a leading `m_` is stripped and the remainder
 * pretty-printed (`m_ProbeAnchor` → `Probe Anchor`) so unmapped fields still
 * read well. Nested paths (`urls.Array.data[0].url`) pass through unchanged.
 */
export const friendlyOverridePathLabel = (propertyPath: string): string => {
  const mapped = friendlyOverridePathLabels.get(propertyPath)
  if (mapped !== undefined) {
    return mapped
  }
  if (
    propertyPath.startsWith('m_') &&
    !propertyPath.includes('.') &&
    !propertyPath.includes('[')
  ) {
    const trimmed = propertyPath.slice(2)
    return trimmed
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^\w/, c => c.toUpperCase())
  }
  return propertyPath
}

/** Total number of GameObject nodes across a hierarchy forest. */
export const countNodes = (
  nodes: ReadonlyArray<IUnityGameObjectDiffNode>
): number => nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0)

/** Find a GameObject node by fileId in a hierarchy forest, or null. */
export const findGameObject = (
  nodes: ReadonlyArray<IUnityGameObjectDiffNode>,
  fileId: UnityFileId
): IUnityGameObjectDiffNode | null => {
  for (const node of nodes) {
    if (node.fileId === fileId) {
      return node
    }
    const found = findGameObject(node.children, fileId)
    if (found !== null) {
      return found
    }
  }
  return null
}
