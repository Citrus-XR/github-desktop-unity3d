import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  assetPathFromMetaPath,
  buildMetaIndex,
  parseMetaContent,
} from '../../../src/lib/unity/meta-index'

const scriptMeta = [
  'fileFormatVersion: 2',
  'guid: abcdef1234567890abcdef1234567890',
  'MonoImporter:',
  '  externalObjects: {}',
  '  serializedVersion: 2',
].join('\n')

describe('parseMetaContent', () => {
  it('extracts the guid and importer type', () => {
    const parsed = parseMetaContent(scriptMeta)
    assert.ok(parsed)
    assert.equal(parsed.guid, 'abcdef1234567890abcdef1234567890')
    assert.equal(parsed.importerType, 'MonoImporter')
  })

  it('returns null when there is no guid', () => {
    assert.equal(parseMetaContent('fileFormatVersion: 2\n'), null)
  })
})

describe('assetPathFromMetaPath', () => {
  it('drops the .meta suffix', () => {
    assert.equal(
      assetPathFromMetaPath('Assets/Scripts/Player.cs.meta'),
      'Assets/Scripts/Player.cs'
    )
  })
})

describe('MetaIndex', () => {
  it('resolves guid to path and path to guid', () => {
    const index = buildMetaIndex([
      { metaPath: 'Assets/Scripts/Player.cs.meta', content: scriptMeta },
    ])
    assert.equal(index.size, 1)
    assert.equal(index.pathForGuid('abcdef1234567890abcdef1234567890'), 'Assets/Scripts/Player.cs')
    const record = index.getByPath('Assets/Scripts/Player.cs')
    assert.equal(record?.guid, 'abcdef1234567890abcdef1234567890')
    assert.equal(record?.importerType, 'MonoImporter')
  })

  it('resolves paths case-insensitively as a fallback', () => {
    const index = buildMetaIndex([
      { metaPath: 'Assets/Art/Hero.png.meta', content: 'guid: 11112222333344445555666677778888\n' },
    ])
    assert.equal(
      index.getByPath('assets/art/hero.png')?.guid,
      '11112222333344445555666677778888'
    )
  })

  it('returns undefined for an unknown guid', () => {
    const index = buildMetaIndex([])
    assert.equal(index.getByGuid('deadbeef'), undefined)
  })
})
