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
  return builtin !== undefined && builtin.length > 0 ? builtin : `Layer ${index}`
}

/** The scalar value of a property on one side, or undefined. */
export const scalarSide = (
  value: UnityPropertyValue | null
): string | undefined =>
  value !== null && value.kind === 'scalar' ? value.value : undefined

/** The field whose value drives a component's header checkbox, if any. */
export const toggleFieldFor = (
  typeName: string,
  doc: IUnityDocumentDiff
): string | undefined => {
  if (typeName === 'GameObject') {
    return 'm_IsActive'
  }
  return doc.properties.some(p => p.key === 'm_Enabled') ? 'm_Enabled' : undefined
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
        { key: 'm_CollisionDetection', label: 'Collision Detection', kind: 'value' },
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
        { key: 'm_StaticShadowCaster', label: 'Static Shadow Caster', kind: 'bool' },
        { key: 'm_MotionVectors', label: 'Motion Vectors', kind: 'value' },
        { key: 'm_DynamicOccludee', label: 'Dynamic Occlusion', kind: 'bool' },
        { key: 'm_ReceiveGI', label: 'Receive GI', kind: 'value' },
        { key: 'm_LightProbeUsage', label: 'Light Probes', kind: 'value' },
        { key: 'm_ReflectionProbeUsage', label: 'Reflection Probes', kind: 'value' },
        { key: 'm_ProbeAnchor', label: 'Anchor Override', kind: 'value' },
      ],
    },
  ],
])

export const schemaFor = (typeName: string): IComponentSchema | undefined =>
  typeName.includes('Collider') ? colliderSchema : componentSchemas.get(typeName)

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
