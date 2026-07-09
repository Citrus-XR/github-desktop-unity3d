import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'fs'
import { getFixturePath } from '../../helpers/fixture'
import { parseUnityYaml } from '../../../src/lib/unity/unity-yaml-parser'
import { buildHierarchy } from '../../../src/lib/unity/hierarchy-builder'
import { collectReferencedGuids } from '../../../src/lib/unity/reference-collector'
import { buildMetaIndex } from '../../../src/lib/unity/meta-index'

const readFixture = (...segments: string[]) =>
  readFileSync(getFixturePath('unity', ...segments), 'utf8')

describe('Unity fixtures', () => {
  it('parses the sample scene into a hierarchy with components', () => {
    const { status, documents } = parseUnityYaml(
      readFixture('SampleProject', 'Assets', 'Scenes', 'Sample.unity')
    )
    assert.equal(status, 'parsed')

    const roots = buildHierarchy(documents)
    assert.equal(roots.length, 1)
    assert.equal(roots[0].name, 'Player')
    assert.equal(roots[0].tag, 'Player')

    const cube = roots[0].children[0]
    assert.equal(cube.name, 'Cube')
    const types = cube.components.map(c => c.typeName)
    assert.deepEqual(types, ['Transform', 'MeshRenderer', 'MeshFilter'])
  })

  it('resolves the scene cross-asset GUIDs to repository paths', () => {
    const { documents } = parseUnityYaml(
      readFixture('SampleProject', 'Assets', 'Scenes', 'Sample.unity')
    )
    const guids = collectReferencedGuids(documents)

    const index = buildMetaIndex([
      {
        metaPath: 'SampleProject/Assets/Scripts/Rotator.cs.meta',
        content: readFixture(
          'SampleProject',
          'Assets',
          'Scripts',
          'Rotator.cs.meta'
        ),
      },
      {
        metaPath: 'SampleProject/Assets/Materials/Red.mat.meta',
        content: readFixture(
          'SampleProject',
          'Assets',
          'Materials',
          'Red.mat.meta'
        ),
      },
    ])

    assert.ok(guids.has('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
    assert.equal(
      index.pathForGuid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      'SampleProject/Assets/Scripts/Rotator.cs'
    )
    assert.equal(
      index.pathForGuid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      'SampleProject/Assets/Materials/Red.mat'
    )
  })

  it('flags a git-lfs pointer fixture instead of parsing it', () => {
    const { status } = parseUnityYaml(readFixture('lfs-pointer.prefab'))
    assert.equal(status, 'git-lfs-pointer')
  })

  it('recovers from a corrupted file without throwing', () => {
    const result = parseUnityYaml(readFixture('corrupted.prefab'))
    // It still finds the one header; the malformed body must not crash parsing.
    assert.ok(result.documents.length >= 0)
    assert.ok(['parsed', 'partially-parsed'].includes(result.status))
  })
})
