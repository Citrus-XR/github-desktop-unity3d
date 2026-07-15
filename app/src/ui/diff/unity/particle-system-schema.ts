/**
 * Schema tables for the friendly `ParticleSystem` and `ParticleSystemRenderer`
 * Inspector layouts.
 *
 * ParticleSystem is serialized as one giant document with ~25 named module
 * sub-maps (`InitialModule`, `ShapeModule`, `EmissionModule`, ...). Rendered
 * flat, that's an unreadable wall; the module list here drives a collapsible
 * sub-section per module — visually equivalent to how Unity's own Inspector
 * groups them. Each module schema enumerates only the fields worth ordering
 * and giving a friendly label; everything else falls through the Inspector's
 * auto-detector (which recognises MinMaxCurve / MinMaxGradient / Color shapes
 * without help from a schema).
 *
 * `restModifiedOnly: true` is the default for modules — a module rarely used
 * has dozens of internal fields (`m_ColorAxisEnableAxes`, `curveMultiplier`,
 * ...) that are just noise unless they changed. The "always show" modules
 * (Initial, Shape, Emission, Color, Size, Rotation, Trail, Noise) opt out so
 * their whole feature surface is visible.
 *
 * Source of truth for the field lists: a real ParticleSystem YAML (see the
 * `KiraParticle.prefab` reference in the plan file) plus Unity's public
 * ParticleSystem module API for the friendly labels.
 */

import { IComponentSchema, IFieldSpec } from './inspector-fields'

/** Ordered list of fields inside a single ParticleSystem module. */
export interface IParticleSystemModuleSchema {
  readonly key: string
  readonly label: string
  readonly enabledField?: string
  readonly fields: ReadonlyArray<IFieldSpec>
  /** True to show non-schema fields only when modified. */
  readonly restModifiedOnly: boolean
}

const startBox = new Map<string, string>([
  ['0', 'None'],
  ['1', 'Disable'],
  ['2', 'Destroy'],
  ['3', 'Callback'],
])

const cullingMode = new Map<string, string>([
  ['0', 'Automatic'],
  ['1', 'Pause and Catch-up'],
  ['2', 'Pause'],
  ['3', 'Always Simulate'],
])

const ringBufferMode = new Map<string, string>([
  ['0', 'Disabled'],
  ['1', 'Pause Until Replaced'],
  ['2', 'Loop Until Replaced'],
])

const emitterVelocityMode = new Map<string, string>([
  ['0', 'Transform'],
  ['1', 'Rigidbody'],
  ['2', 'Custom'],
])

const scalingMode = new Map<string, string>([
  ['0', 'Hierarchy'],
  ['1', 'Local'],
  ['2', 'Shape'],
])

const shapeType = new Map<string, string>([
  ['0', 'Sphere'],
  ['2', 'Hemisphere'],
  ['4', 'Cone'],
  ['5', 'Box'],
  ['6', 'Mesh'],
  ['7', 'ConeVolume'],
  ['8', 'Circle'],
  ['9', 'SingleSidedEdge'],
  ['10', 'MeshRenderer'],
  ['11', 'SkinnedMeshRenderer'],
  ['12', 'BoxShell'],
  ['13', 'BoxEdge'],
  ['14', 'Donut'],
  ['15', 'Rectangle'],
  ['16', 'Sprite'],
  ['17', 'SpriteRenderer'],
])

const renderMode = new Map<string, string>([
  ['0', 'Billboard'],
  ['1', 'Stretched Billboard'],
  ['2', 'Horizontal Billboard'],
  ['3', 'Vertical Billboard'],
  ['4', 'Mesh'],
  ['5', 'None'],
])

const sortMode = new Map<string, string>([
  ['0', 'None'],
  ['1', 'By Distance'],
  ['2', 'Oldest in Front'],
  ['3', 'Youngest in Front'],
  ['4', 'By Depth'],
])

const maskInteraction = new Map<string, string>([
  ['0', 'None'],
  ['1', 'Visible Inside Mask'],
  ['2', 'Visible Outside Mask'],
])

const castShadows = new Map<string, string>([
  ['0', 'Off'],
  ['1', 'On'],
  ['2', 'Two Sided'],
  ['3', 'Shadows Only'],
])

const probeUsage = new Map<string, string>([
  ['0', 'Off'],
  ['1', 'Blend Probes'],
  ['2', 'Use Proxy Volume'],
  ['3', 'Custom Provided'],
])

const meshDistribution = new Map<string, string>([
  ['0', 'Uniform Random'],
  ['1', 'Non-Uniform Random'],
])

const renderAlignment = new Map<string, string>([
  ['0', 'View'],
  ['1', 'World'],
  ['2', 'Local'],
  ['3', 'Facing'],
  ['4', 'Velocity'],
])

/**
 * Header row: fields that appear ABOVE the module list in Unity's Inspector
 * (Main section). Emitter meta lives here, not in `InitialModule`.
 */
export const particleSystemHeaderSchema: IComponentSchema = {
  restModifiedOnly: true,
  fields: [
    { key: 'lengthInSec', label: 'Duration', kind: 'value' },
    { key: 'looping', label: 'Looping', kind: 'bool' },
    { key: 'prewarm', label: 'Prewarm', kind: 'bool' },
    { key: 'startDelay', label: 'Start Delay', kind: 'minMaxCurve' },
    { key: 'playOnAwake', label: 'Play On Awake', kind: 'bool' },
    { key: 'simulationSpeed', label: 'Simulation Speed', kind: 'value' },
    { key: 'useUnscaledTime', label: 'Unscaled Time', kind: 'bool' },
    {
      key: 'scalingMode',
      label: 'Scaling Mode',
      kind: 'enum',
      enumLabels: scalingMode,
    },
    {
      key: 'stopAction',
      label: 'Stop Action',
      kind: 'enum',
      enumLabels: startBox,
    },
    {
      key: 'cullingMode',
      label: 'Culling Mode',
      kind: 'enum',
      enumLabels: cullingMode,
    },
    {
      key: 'ringBufferMode',
      label: 'Ring Buffer Mode',
      kind: 'enum',
      enumLabels: ringBufferMode,
    },
    {
      key: 'emitterVelocityMode',
      label: 'Emitter Velocity',
      kind: 'enum',
      enumLabels: emitterVelocityMode,
    },
    { key: 'autoRandomSeed', label: 'Auto Random Seed', kind: 'bool' },
    { key: 'randomSeed', label: 'Random Seed', kind: 'value' },
    { key: 'moveWithTransform', label: 'Move With Transform', kind: 'bool' },
  ],
}

/**
 * Module list — order matches Unity's Inspector. Every entry MUST correspond to
 * an actual sub-map on the ParticleSystem document; the auto-detector handles
 * fields we don't enumerate.
 */
export const particleSystemModules: ReadonlyArray<IParticleSystemModuleSchema> =
  [
    {
      key: 'InitialModule',
      label: 'Main',
      restModifiedOnly: false,
      fields: [
        {
          key: 'startLifetime',
          label: 'Start Lifetime',
          kind: 'minMaxCurve',
        },
        { key: 'startSpeed', label: 'Start Speed', kind: 'minMaxCurve' },
        { key: 'startSize', label: 'Start Size', kind: 'minMaxCurve' },
        { key: 'startSizeY', label: 'Start Size Y', kind: 'minMaxCurve' },
        { key: 'startSizeZ', label: 'Start Size Z', kind: 'minMaxCurve' },
        {
          key: 'startRotation',
          label: 'Start Rotation',
          kind: 'minMaxCurve',
        },
        {
          key: 'startRotationX',
          label: 'Start Rotation X',
          kind: 'minMaxCurve',
        },
        {
          key: 'startRotationY',
          label: 'Start Rotation Y',
          kind: 'minMaxCurve',
        },
        {
          key: 'randomizeRotationDirection',
          label: 'Randomize Rotation Direction',
          kind: 'value',
        },
        { key: 'startColor', label: 'Start Color', kind: 'minMaxGradient' },
        {
          key: 'gravityModifier',
          label: 'Gravity Modifier',
          kind: 'minMaxCurve',
        },
        { key: 'gravitySource', label: 'Gravity Source', kind: 'value' },
        { key: 'maxNumParticles', label: 'Max Particles', kind: 'value' },
        { key: 'size3D', label: '3D Start Size', kind: 'bool' },
        { key: 'rotation3D', label: '3D Start Rotation', kind: 'bool' },
      ],
    },
    {
      key: 'EmissionModule',
      label: 'Emission',
      enabledField: 'enabled',
      restModifiedOnly: false,
      fields: [
        {
          key: 'rateOverTime',
          label: 'Rate over Time',
          kind: 'minMaxCurve',
        },
        {
          key: 'rateOverDistance',
          label: 'Rate over Distance',
          kind: 'minMaxCurve',
        },
        { key: 'm_BurstCount', label: 'Bursts', kind: 'value' },
      ],
    },
    {
      key: 'ShapeModule',
      label: 'Shape',
      enabledField: 'enabled',
      // Shape carries a big set of fields that only apply to specific shape
      // types (mesh / sprite / texture inputs). Hiding unchanged rest fields
      // keeps a Circle emitter's Inspector focused on radius / angle rather
      // than dumping every mesh sampling knob.
      restModifiedOnly: true,
      fields: [
        {
          key: 'type',
          label: 'Shape',
          kind: 'enum',
          enumLabels: shapeType,
        },
        { key: 'angle', label: 'Angle', kind: 'value' },
        { key: 'length', label: 'Length', kind: 'value' },
        { key: 'radius', label: 'Radius', kind: 'value' },
        { key: 'arc', label: 'Arc', kind: 'value' },
        { key: 'radiusThickness', label: 'Radius Thickness', kind: 'value' },
        { key: 'donutRadius', label: 'Donut Radius', kind: 'value' },
        { key: 'boxThickness', label: 'Box Thickness', kind: 'vector' },
        { key: 'm_Position', label: 'Position', kind: 'vector' },
        { key: 'm_Rotation', label: 'Rotation', kind: 'vector' },
        { key: 'm_Scale', label: 'Scale', kind: 'vector' },
        { key: 'alignToDirection', label: 'Align to Direction', kind: 'bool' },
        { key: 'randomDirectionAmount', label: 'Random Direction', kind: 'value' },
        { key: 'sphericalDirectionAmount', label: 'Spherical Direction', kind: 'value' },
        { key: 'randomPositionAmount', label: 'Random Position', kind: 'value' },
      ],
    },
    {
      key: 'VelocityModule',
      label: 'Velocity over Lifetime',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'x', label: 'Linear X', kind: 'minMaxCurve' },
        { key: 'y', label: 'Linear Y', kind: 'minMaxCurve' },
        { key: 'z', label: 'Linear Z', kind: 'minMaxCurve' },
        { key: 'orbitalX', label: 'Orbital X', kind: 'minMaxCurve' },
        { key: 'orbitalY', label: 'Orbital Y', kind: 'minMaxCurve' },
        { key: 'orbitalZ', label: 'Orbital Z', kind: 'minMaxCurve' },
        { key: 'radial', label: 'Radial', kind: 'minMaxCurve' },
        { key: 'speedModifier', label: 'Speed Modifier', kind: 'minMaxCurve' },
        { key: 'inWorldSpace', label: 'World Space', kind: 'bool' },
      ],
    },
    {
      key: 'InheritVelocityModule',
      label: 'Inherit Velocity',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'm_Mode', label: 'Mode', kind: 'value' },
        { key: 'm_Curve', label: 'Multiplier', kind: 'minMaxCurve' },
      ],
    },
    {
      key: 'LifetimeByEmitterSpeedModule',
      label: 'Lifetime by Emitter Speed',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'm_Curve', label: 'Multiplier', kind: 'minMaxCurve' },
        { key: 'm_Range', label: 'Speed Range', kind: 'vector' },
      ],
    },
    {
      key: 'ForceModule',
      label: 'Force over Lifetime',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'x', label: 'X', kind: 'minMaxCurve' },
        { key: 'y', label: 'Y', kind: 'minMaxCurve' },
        { key: 'z', label: 'Z', kind: 'minMaxCurve' },
        { key: 'inWorldSpace', label: 'World Space', kind: 'bool' },
        { key: 'randomizePerFrame', label: 'Randomize', kind: 'bool' },
      ],
    },
    {
      key: 'ColorModule',
      label: 'Color over Lifetime',
      enabledField: 'enabled',
      restModifiedOnly: false,
      fields: [{ key: 'gradient', label: 'Color', kind: 'minMaxGradient' }],
    },
    {
      key: 'ColorBySpeedModule',
      label: 'Color by Speed',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'gradient', label: 'Color', kind: 'minMaxGradient' },
        { key: 'range', label: 'Speed Range', kind: 'vector' },
      ],
    },
    {
      key: 'SizeModule',
      label: 'Size over Lifetime',
      enabledField: 'enabled',
      restModifiedOnly: false,
      fields: [
        { key: 'curve', label: 'Size', kind: 'minMaxCurve' },
        { key: 'y', label: 'Size Y', kind: 'minMaxCurve' },
        { key: 'z', label: 'Size Z', kind: 'minMaxCurve' },
        { key: 'separateAxes', label: 'Separate Axes', kind: 'bool' },
      ],
    },
    {
      key: 'SizeBySpeedModule',
      label: 'Size by Speed',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'curve', label: 'Size', kind: 'minMaxCurve' },
        { key: 'y', label: 'Size Y', kind: 'minMaxCurve' },
        { key: 'z', label: 'Size Z', kind: 'minMaxCurve' },
        { key: 'range', label: 'Speed Range', kind: 'vector' },
        { key: 'separateAxes', label: 'Separate Axes', kind: 'bool' },
      ],
    },
    {
      key: 'RotationModule',
      label: 'Rotation over Lifetime',
      enabledField: 'enabled',
      restModifiedOnly: false,
      fields: [
        { key: 'x', label: 'Rotation X', kind: 'minMaxCurve' },
        { key: 'y', label: 'Rotation Y', kind: 'minMaxCurve' },
        { key: 'curve', label: 'Rotation', kind: 'minMaxCurve' },
        { key: 'separateAxes', label: 'Separate Axes', kind: 'bool' },
      ],
    },
    {
      key: 'RotationBySpeedModule',
      label: 'Rotation by Speed',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'x', label: 'Rotation X', kind: 'minMaxCurve' },
        { key: 'y', label: 'Rotation Y', kind: 'minMaxCurve' },
        { key: 'curve', label: 'Rotation', kind: 'minMaxCurve' },
        { key: 'range', label: 'Speed Range', kind: 'vector' },
        { key: 'separateAxes', label: 'Separate Axes', kind: 'bool' },
      ],
    },
    {
      key: 'ExternalForcesModule',
      label: 'External Forces',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'multiplier', label: 'Multiplier', kind: 'value' },
        {
          key: 'multiplierCurve',
          label: 'Multiplier Curve',
          kind: 'minMaxCurve',
        },
        { key: 'influenceFilter', label: 'Influence Filter', kind: 'value' },
        { key: 'influenceMask', label: 'Influence Mask', kind: 'value' },
      ],
    },
    {
      key: 'NoiseModule',
      label: 'Noise',
      enabledField: 'enabled',
      restModifiedOnly: false,
      fields: [
        { key: 'strength', label: 'Strength', kind: 'minMaxCurve' },
        { key: 'strengthY', label: 'Strength Y', kind: 'minMaxCurve' },
        { key: 'strengthZ', label: 'Strength Z', kind: 'minMaxCurve' },
        { key: 'frequency', label: 'Frequency', kind: 'value' },
        { key: 'damping', label: 'Damping', kind: 'bool' },
        { key: 'octaves', label: 'Octaves', kind: 'value' },
        {
          key: 'octaveMultiplier',
          label: 'Octave Multiplier',
          kind: 'value',
        },
        { key: 'octaveScale', label: 'Octave Scale', kind: 'value' },
        { key: 'quality', label: 'Quality', kind: 'value' },
        {
          key: 'scrollSpeed',
          label: 'Scroll Speed',
          kind: 'minMaxCurve',
        },
        { key: 'remap', label: 'Remap', kind: 'minMaxCurve' },
        { key: 'remapEnabled', label: 'Remap Enabled', kind: 'bool' },
        { key: 'separateAxes', label: 'Separate Axes', kind: 'bool' },
      ],
    },
    {
      key: 'CollisionModule',
      label: 'Collision',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'type', label: 'Type', kind: 'value' },
        { key: 'collisionMode', label: 'Mode', kind: 'value' },
        { key: 'dampen', label: 'Dampen', kind: 'minMaxCurve' },
        { key: 'bounce', label: 'Bounce', kind: 'minMaxCurve' },
        {
          key: 'energyLossOnCollision',
          label: 'Lifetime Loss',
          kind: 'minMaxCurve',
        },
        { key: 'minKillSpeed', label: 'Min Kill Speed', kind: 'value' },
        { key: 'maxKillSpeed', label: 'Max Kill Speed', kind: 'value' },
        { key: 'radiusScale', label: 'Radius Scale', kind: 'value' },
        {
          key: 'collidesWith',
          label: 'Collides With',
          kind: 'value',
        },
        { key: 'sendCollisionMessages', label: 'Send Messages', kind: 'bool' },
        { key: 'maxCollisionShapes', label: 'Max Shapes', kind: 'value' },
        { key: 'quality', label: 'Quality', kind: 'value' },
        { key: 'voxelSize', label: 'Voxel Size', kind: 'value' },
      ],
    },
    {
      key: 'TriggerModule',
      label: 'Triggers',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'inside', label: 'Inside', kind: 'value' },
        { key: 'outside', label: 'Outside', kind: 'value' },
        { key: 'enter', label: 'Enter', kind: 'value' },
        { key: 'exit', label: 'Exit', kind: 'value' },
        { key: 'colliderQueryMode', label: 'Collider Query', kind: 'value' },
        { key: 'radiusScale', label: 'Radius Scale', kind: 'value' },
      ],
    },
    {
      key: 'SubModule',
      label: 'Sub Emitters',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [{ key: 'subEmitters', label: 'Sub Emitters', kind: 'value' }],
    },
    {
      key: 'UVModule',
      label: 'Texture Sheet Animation',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'mode', label: 'Mode', kind: 'value' },
        { key: 'timeMode', label: 'Time Mode', kind: 'value' },
        { key: 'animationType', label: 'Animation', kind: 'value' },
        { key: 'tilesX', label: 'Tiles X', kind: 'value' },
        { key: 'tilesY', label: 'Tiles Y', kind: 'value' },
        { key: 'rowIndex', label: 'Row', kind: 'value' },
        { key: 'useRandomRow', label: 'Random Row', kind: 'bool' },
        { key: 'frameOverTime', label: 'Frame over Time', kind: 'minMaxCurve' },
        { key: 'startFrame', label: 'Start Frame', kind: 'minMaxCurve' },
        { key: 'cycles', label: 'Cycles', kind: 'value' },
        { key: 'flipU', label: 'Flip U', kind: 'value' },
        { key: 'flipV', label: 'Flip V', kind: 'value' },
        { key: 'uvChannelMask', label: 'UV Channel Mask', kind: 'value' },
        { key: 'fps', label: 'FPS', kind: 'value' },
        { key: 'speedRange', label: 'Speed Range', kind: 'vector' },
      ],
    },
    {
      key: 'LightsModule',
      label: 'Lights',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'ratio', label: 'Ratio', kind: 'value' },
        { key: 'light', label: 'Light', kind: 'value' },
        { key: 'randomDistribution', label: 'Random Distribution', kind: 'bool' },
        { key: 'color', label: 'Use Particle Color', kind: 'bool' },
        { key: 'range', label: 'Use Particle Size', kind: 'bool' },
        { key: 'intensity', label: 'Use Particle Intensity', kind: 'bool' },
        {
          key: 'rangeCurve',
          label: 'Range Multiplier',
          kind: 'minMaxCurve',
        },
        {
          key: 'intensityCurve',
          label: 'Intensity Multiplier',
          kind: 'minMaxCurve',
        },
        { key: 'maxLights', label: 'Max Lights', kind: 'value' },
      ],
    },
    {
      key: 'TrailModule',
      label: 'Trails',
      enabledField: 'enabled',
      restModifiedOnly: false,
      fields: [
        { key: 'mode', label: 'Mode', kind: 'value' },
        { key: 'ratio', label: 'Ratio', kind: 'value' },
        { key: 'lifetime', label: 'Lifetime', kind: 'minMaxCurve' },
        { key: 'minVertexDistance', label: 'Min Vertex Distance', kind: 'value' },
        { key: 'textureMode', label: 'Texture Mode', kind: 'value' },
        {
          key: 'ribbonCount',
          label: 'Ribbon Count',
          kind: 'value',
        },
        {
          key: 'shadowBias',
          label: 'Shadow Bias',
          kind: 'value',
        },
        {
          key: 'worldSpace',
          label: 'World Space',
          kind: 'bool',
        },
        {
          key: 'dieWithParticles',
          label: 'Die With Particles',
          kind: 'bool',
        },
        { key: 'sizeAffectsWidth', label: 'Size Affects Width', kind: 'bool' },
        {
          key: 'sizeAffectsLifetime',
          label: 'Size Affects Lifetime',
          kind: 'bool',
        },
        {
          key: 'inheritParticleColor',
          label: 'Inherit Particle Color',
          kind: 'bool',
        },
        { key: 'colorOverLifetime', label: 'Color over Lifetime', kind: 'minMaxGradient' },
        { key: 'widthOverTrail', label: 'Width over Trail', kind: 'minMaxCurve' },
        { key: 'colorOverTrail', label: 'Color over Trail', kind: 'minMaxGradient' },
        {
          key: 'generateLightingData',
          label: 'Generate Lighting Data',
          kind: 'bool',
        },
        {
          key: 'splitSubEmitterRibbons',
          label: 'Split Sub Emitter Ribbons',
          kind: 'bool',
        },
        {
          key: 'attachRibbonsToTransform',
          label: 'Attach Ribbons to Transform',
          kind: 'bool',
        },
      ],
    },
    {
      key: 'CustomDataModule',
      label: 'Custom Data',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [],
    },
    {
      key: 'ClampVelocityModule',
      label: 'Limit Velocity over Lifetime',
      enabledField: 'enabled',
      restModifiedOnly: true,
      fields: [
        { key: 'x', label: 'Limit X', kind: 'minMaxCurve' },
        { key: 'y', label: 'Limit Y', kind: 'minMaxCurve' },
        { key: 'z', label: 'Limit Z', kind: 'minMaxCurve' },
        { key: 'magnitude', label: 'Speed', kind: 'minMaxCurve' },
        { key: 'separateAxis', label: 'Separate Axes', kind: 'bool' },
        { key: 'inWorldSpace', label: 'World Space', kind: 'bool' },
        { key: 'multiplyDragByParticleSize', label: 'Drag ∝ Size', kind: 'bool' },
        { key: 'multiplyDragByParticleVelocity', label: 'Drag ∝ Velocity', kind: 'bool' },
        { key: 'dampen', label: 'Dampen', kind: 'value' },
        { key: 'drag', label: 'Drag', kind: 'minMaxCurve' },
      ],
    },
  ]

/**
 * Ordered groups for the ParticleSystemRenderer body. Each group renders as a
 * collapsible sub-section with the same visual language as ParticleSystem's
 * modules. Fields not listed here fall through to a "More" bucket shown only
 * when modified — Renderers carry a lot of lightmap plumbing users rarely
 * touch.
 */
export interface IParticleSystemRendererGroup {
  readonly key: string
  readonly label: string
  readonly fields: ReadonlyArray<IFieldSpec>
}

export const particleSystemRendererGroups: ReadonlyArray<IParticleSystemRendererGroup> =
  [
    {
      key: 'render',
      label: 'Render',
      fields: [
        {
          key: 'm_RenderMode',
          label: 'Render Mode',
          kind: 'enum',
          enumLabels: renderMode,
        },
        {
          key: 'm_MeshDistribution',
          label: 'Mesh Distribution',
          kind: 'enum',
          enumLabels: meshDistribution,
        },
        { key: 'm_Mesh', label: 'Mesh', kind: 'value' },
        { key: 'm_Mesh1', label: 'Mesh 1', kind: 'value' },
        { key: 'm_Mesh2', label: 'Mesh 2', kind: 'value' },
        { key: 'm_Mesh3', label: 'Mesh 3', kind: 'value' },
        { key: 'm_MeshWeighting', label: 'Mesh 0 Weight', kind: 'value' },
        { key: 'm_MeshWeighting1', label: 'Mesh 1 Weight', kind: 'value' },
        { key: 'm_MeshWeighting2', label: 'Mesh 2 Weight', kind: 'value' },
        { key: 'm_MeshWeighting3', label: 'Mesh 3 Weight', kind: 'value' },
        {
          key: 'm_NormalDirection',
          label: 'Normal Direction',
          kind: 'value',
        },
        {
          key: 'm_MinParticleSize',
          label: 'Min Particle Size',
          kind: 'value',
        },
        {
          key: 'm_MaxParticleSize',
          label: 'Max Particle Size',
          kind: 'value',
        },
        {
          key: 'm_RenderAlignment',
          label: 'Render Alignment',
          kind: 'enum',
          enumLabels: renderAlignment,
        },
        { key: 'm_Pivot', label: 'Pivot', kind: 'vector' },
        { key: 'm_Flip', label: 'Flip', kind: 'vector' },
        {
          key: 'm_MaskInteraction',
          label: 'Sprite Mask Interaction',
          kind: 'enum',
          enumLabels: maskInteraction,
        },
        { key: 'm_EnableGPUInstancing', label: 'GPU Instancing', kind: 'bool' },
        {
          key: 'm_ApplyActiveColorSpace',
          label: 'Apply Active Color Space',
          kind: 'bool',
        },
        { key: 'm_AllowRoll', label: 'Allow Roll', kind: 'bool' },
        {
          key: 'm_FreeformStretching',
          label: 'Freeform Stretching',
          kind: 'bool',
        },
        {
          key: 'm_RotateWithStretchDirection',
          label: 'Rotate with Stretch Direction',
          kind: 'bool',
        },
        {
          key: 'm_LengthScale',
          label: 'Length Scale',
          kind: 'value',
        },
        {
          key: 'm_VelocityScale',
          label: 'Speed Scale',
          kind: 'value',
        },
        {
          key: 'm_CameraVelocityScale',
          label: 'Camera Scale',
          kind: 'value',
        },
      ],
    },
    {
      key: 'sorting',
      label: 'Sorting',
      fields: [
        {
          key: 'm_SortMode',
          label: 'Sort Mode',
          kind: 'enum',
          enumLabels: sortMode,
        },
        { key: 'm_SortingFudge', label: 'Sorting Fudge', kind: 'value' },
        { key: 'm_SortingLayer', label: 'Sorting Layer', kind: 'value' },
        { key: 'm_SortingOrder', label: 'Order in Layer', kind: 'value' },
      ],
    },
    {
      key: 'materials',
      label: 'Materials',
      fields: [
        { key: 'm_Materials', label: 'Materials', kind: 'value' },
        {
          key: 'm_UseCustomVertexStreams',
          label: 'Custom Vertex Streams',
          kind: 'bool',
        },
        { key: 'm_VertexStreams', label: 'Vertex Streams', kind: 'value' },
        {
          key: 'm_UseCustomTrailVertexStreams',
          label: 'Custom Trail Streams',
          kind: 'bool',
        },
        {
          key: 'm_TrailVertexStreams',
          label: 'Trail Vertex Streams',
          kind: 'value',
        },
      ],
    },
    {
      key: 'lighting',
      label: 'Lighting',
      fields: [
        {
          key: 'm_CastShadows',
          label: 'Cast Shadows',
          kind: 'enum',
          enumLabels: castShadows,
        },
        { key: 'm_ReceiveShadows', label: 'Receive Shadows', kind: 'bool' },
        {
          key: 'm_StaticShadowCaster',
          label: 'Static Shadow Caster',
          kind: 'bool',
        },
        { key: 'm_MotionVectors', label: 'Motion Vectors', kind: 'value' },
        { key: 'm_DynamicOccludee', label: 'Dynamic Occlusion', kind: 'bool' },
        { key: 'm_ShadowBias', label: 'Shadow Bias', kind: 'value' },
        {
          key: 'm_RenderingLayerMask',
          label: 'Rendering Layer Mask',
          kind: 'value',
        },
        {
          key: 'm_RendererPriority',
          label: 'Renderer Priority',
          kind: 'value',
        },
      ],
    },
    {
      key: 'probes',
      label: 'Probes',
      fields: [
        {
          key: 'm_LightProbeUsage',
          label: 'Light Probes',
          kind: 'enum',
          enumLabels: probeUsage,
        },
        {
          key: 'm_ReflectionProbeUsage',
          label: 'Reflection Probes',
          kind: 'enum',
          enumLabels: probeUsage,
        },
        { key: 'm_ProbeAnchor', label: 'Anchor Override', kind: 'value' },
        {
          key: 'm_LightProbeVolumeOverride',
          label: 'Proxy Volume Override',
          kind: 'value',
        },
        { key: 'm_ReceiveGI', label: 'Receive GI', kind: 'value' },
      ],
    },
  ]
