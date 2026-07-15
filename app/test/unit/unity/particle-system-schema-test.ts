import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  isColorMap,
  isMinMaxCurve,
  isMinMaxGradient,
  isMultiModeParameter,
} from '../../../src/ui/diff/unity/inspector-fields'
import {
  particleSystemHeaderSchema,
  particleSystemModules,
  particleSystemRendererGroups,
} from '../../../src/ui/diff/unity/particle-system-schema'
import { UnityPropertyValue } from '../../../src/models/unity/serialized-asset'

const scalar = (value: string): UnityPropertyValue => ({
  kind: 'scalar',
  value,
})

const map = (
  entries: ReadonlyArray<{ key: string; value: UnityPropertyValue }>
): UnityPropertyValue => ({ kind: 'map', entries })

const sequence = (
  items: ReadonlyArray<UnityPropertyValue>
): UnityPropertyValue => ({ kind: 'sequence', items })

const colorMap = (
  r: number,
  g: number,
  b: number,
  a: number
): UnityPropertyValue =>
  map([
    { key: 'r', value: scalar(String(r)) },
    { key: 'g', value: scalar(String(g)) },
    { key: 'b', value: scalar(String(b)) },
    { key: 'a', value: scalar(String(a)) },
  ])

const curveNode = (): UnityPropertyValue =>
  map([
    { key: 'serializedVersion', value: scalar('2') },
    {
      key: 'm_Curve',
      value: sequence([
        map([
          { key: 'time', value: scalar('0') },
          { key: 'value', value: scalar('0') },
          { key: 'inSlope', value: scalar('0') },
          { key: 'outSlope', value: scalar('0') },
          { key: 'tangentMode', value: scalar('0') },
          { key: 'weightedMode', value: scalar('0') },
          { key: 'inWeight', value: scalar('0.33333334') },
          { key: 'outWeight', value: scalar('0.33333334') },
        ]),
        map([
          { key: 'time', value: scalar('1') },
          { key: 'value', value: scalar('1') },
          { key: 'inSlope', value: scalar('0') },
          { key: 'outSlope', value: scalar('0') },
          { key: 'tangentMode', value: scalar('0') },
          { key: 'weightedMode', value: scalar('0') },
          { key: 'inWeight', value: scalar('0.33333334') },
          { key: 'outWeight', value: scalar('0.33333334') },
        ]),
      ]),
    },
    { key: 'm_PreInfinity', value: scalar('2') },
    { key: 'm_PostInfinity', value: scalar('2') },
    { key: 'm_RotationOrder', value: scalar('4') },
  ])

const minMaxCurveValue = (state: string): UnityPropertyValue =>
  map([
    { key: 'serializedVersion', value: scalar('2') },
    { key: 'minMaxState', value: scalar(state) },
    { key: 'scalar', value: scalar('0.5') },
    { key: 'minScalar', value: scalar('0.1') },
    { key: 'maxCurve', value: curveNode() },
    { key: 'minCurve', value: curveNode() },
  ])

const gradientKeys = (): ReadonlyArray<{
  key: string
  value: UnityPropertyValue
}> => {
  const entries: Array<{ key: string; value: UnityPropertyValue }> = []
  for (let i = 0; i < 8; i++) {
    entries.push({ key: `key${i}`, value: colorMap(i === 1 ? 0 : 1, 1, 1, 1) })
  }
  for (let i = 0; i < 8; i++) {
    entries.push({
      key: `ctime${i}`,
      value: scalar(i === 0 ? '0' : i === 1 ? '65535' : '0'),
    })
  }
  for (let i = 0; i < 8; i++) {
    entries.push({
      key: `atime${i}`,
      value: scalar(i === 0 ? '0' : i === 1 ? '65535' : '0'),
    })
  }
  entries.push({ key: 'm_Mode', value: scalar('0') })
  entries.push({ key: 'm_ColorSpace', value: scalar('-1') })
  entries.push({ key: 'm_NumColorKeys', value: scalar('2') })
  entries.push({ key: 'm_NumAlphaKeys', value: scalar('2') })
  return entries
}

const minMaxGradientValue = (state: string): UnityPropertyValue =>
  map([
    { key: 'serializedVersion', value: scalar('2') },
    { key: 'minMaxState', value: scalar(state) },
    { key: 'minColor', value: colorMap(1, 1, 1, 1) },
    { key: 'maxColor', value: colorMap(1, 1, 1, 1) },
    { key: 'maxGradient', value: map(gradientKeys()) },
    { key: 'minGradient', value: map(gradientKeys()) },
  ])

describe('isColorMap', () => {
  it('accepts a Unity Color', () => {
    assert.equal(isColorMap(colorMap(1, 0.5, 0.25, 1)), true)
  })

  it('rejects a vector (missing alpha)', () => {
    assert.equal(
      isColorMap(
        map([
          { key: 'x', value: scalar('0') },
          { key: 'y', value: scalar('0') },
          { key: 'z', value: scalar('0') },
        ])
      ),
      false
    )
  })

  it('rejects a scalar', () => {
    assert.equal(isColorMap(scalar('1')), false)
    assert.equal(isColorMap(null), false)
  })

  it('rejects a MinMaxGradient wrapper', () => {
    assert.equal(isColorMap(minMaxGradientValue('0')), false)
  })
})

describe('isMinMaxCurve', () => {
  it('accepts every mode', () => {
    for (const state of ['0', '1', '2', '3']) {
      assert.equal(
        isMinMaxCurve(minMaxCurveValue(state)),
        true,
        `state ${state}`
      )
    }
  })

  it('rejects a MinMaxGradient', () => {
    assert.equal(isMinMaxCurve(minMaxGradientValue('0')), false)
  })

  it('rejects a bare vector map', () => {
    assert.equal(
      isMinMaxCurve(
        map([
          { key: 'x', value: scalar('0') },
          { key: 'y', value: scalar('0') },
          { key: 'z', value: scalar('0') },
        ])
      ),
      false
    )
  })

  it('rejects null / scalar', () => {
    assert.equal(isMinMaxCurve(null), false)
    assert.equal(isMinMaxCurve(scalar('5')), false)
  })
})

describe('isMinMaxGradient', () => {
  it('accepts every mode', () => {
    for (const state of ['0', '1', '2', '3', '4']) {
      assert.equal(
        isMinMaxGradient(minMaxGradientValue(state)),
        true,
        `state ${state}`
      )
    }
  })

  it('rejects a MinMaxCurve', () => {
    assert.equal(isMinMaxGradient(minMaxCurveValue('0')), false)
  })

  it('rejects a plain color', () => {
    assert.equal(isMinMaxGradient(colorMap(1, 1, 1, 1)), false)
  })
})

const multiModeParameterValue = (): UnityPropertyValue =>
  map([
    { key: 'value', value: scalar('0.34') },
    { key: 'mode', value: scalar('0') },
    { key: 'spread', value: scalar('0') },
    { key: 'speed', value: minMaxCurveValue('0') },
  ])

describe('isMultiModeParameter', () => {
  it('accepts a ShapeModule radius / arc wrapper', () => {
    assert.equal(isMultiModeParameter(multiModeParameterValue()), true)
  })

  it('rejects a MinMaxCurve', () => {
    assert.equal(isMultiModeParameter(minMaxCurveValue('0')), false)
  })

  it('rejects a plain scalar / vector', () => {
    assert.equal(isMultiModeParameter(scalar('0.34')), false)
    assert.equal(
      isMultiModeParameter(
        map([
          { key: 'x', value: scalar('0') },
          { key: 'y', value: scalar('0') },
          { key: 'z', value: scalar('0') },
        ])
      ),
      false
    )
  })
})

describe('particleSystemModules', () => {
  it('includes every Unity ParticleSystem module', () => {
    const keys = new Set(particleSystemModules.map(m => m.key))
    const required = [
      'InitialModule',
      'ShapeModule',
      'EmissionModule',
      'SizeModule',
      'RotationModule',
      'ColorModule',
      'UVModule',
      'VelocityModule',
      'InheritVelocityModule',
      'LifetimeByEmitterSpeedModule',
      'ForceModule',
      'ExternalForcesModule',
      'ClampVelocityModule',
      'NoiseModule',
      'SizeBySpeedModule',
      'RotationBySpeedModule',
      'ColorBySpeedModule',
      'CollisionModule',
      'TriggerModule',
      'SubModule',
      'LightsModule',
      'TrailModule',
      'CustomDataModule',
    ]
    for (const key of required) {
      assert.equal(keys.has(key), true, `missing module ${key}`)
    }
  })

  it('marks every module except InitialModule with an enabled toggle', () => {
    for (const module of particleSystemModules) {
      if (module.key === 'InitialModule') {
        assert.equal(module.enabledField, undefined)
      } else {
        assert.equal(module.enabledField, 'enabled', `${module.key}`)
      }
    }
  })

  it('uses unique keys', () => {
    const keys = particleSystemModules.map(m => m.key)
    assert.equal(new Set(keys).size, keys.length)
  })
})

describe('particleSystemHeaderSchema', () => {
  it('exposes the emitter meta fields at the top level', () => {
    const keys = new Set(particleSystemHeaderSchema.fields.map(f => f.key))
    for (const key of [
      'lengthInSec',
      'looping',
      'prewarm',
      'playOnAwake',
      'startDelay',
    ]) {
      assert.equal(keys.has(key), true, `missing header field ${key}`)
    }
  })
})

describe('particleSystemRendererGroups', () => {
  it('groups by the standard Renderer inspector layout', () => {
    const keys = particleSystemRendererGroups.map(g => g.key)
    assert.deepEqual(keys, [
      'render',
      'sorting',
      'materials',
      'lighting',
      'probes',
    ])
  })

  it('places the render mode in the render group', () => {
    const render = particleSystemRendererGroups.find(g => g.key === 'render')
    assert.ok(render)
    const keys = new Set(render.fields.map(f => f.key))
    assert.equal(keys.has('m_RenderMode'), true)
  })
})
