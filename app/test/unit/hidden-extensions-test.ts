import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  buildRescueLinks,
  computeRescuedPaths,
  expandLinkedFileIds,
  getFinalExtension,
  parseHiddenExtensions,
  splitPath,
} from '../../src/lib/hidden-extensions'

describe('hidden-extensions', () => {
  describe('parseHiddenExtensions', () => {
    it('returns an empty set for an empty string', () => {
      assert.equal(parseHiddenExtensions('').size, 0)
    })

    it('splits on commas, trims whitespace, drops a leading dot', () => {
      const set = parseHiddenExtensions(' meta , .DS_Store, ,tmp ')
      assert.deepEqual([...set].sort(), ['DS_Store', 'meta', 'tmp'])
    })

    it('is case-sensitive', () => {
      const set = parseHiddenExtensions('Meta,meta')
      assert.deepEqual([...set].sort(), ['Meta', 'meta'])
    })
  })

  describe('getFinalExtension', () => {
    it('returns the extension after the last dot', () => {
      assert.equal(getFinalExtension('a/b/Foo.cs.meta'), 'meta')
      assert.equal(getFinalExtension('Foo.cs'), 'cs')
    })

    it('returns empty for a file with no extension', () => {
      assert.equal(getFinalExtension('Makefile'), '')
    })

    it('does not treat a dotfile as extension-only', () => {
      assert.equal(getFinalExtension('.gitignore'), '')
    })
  })

  describe('splitPath', () => {
    it('splits a nested path into dir and root name before the first dot', () => {
      assert.deepEqual(splitPath('a/b/Foo.cs.meta'), {
        dir: 'a/b',
        root: 'Foo',
      })
    })

    it('handles a bare file name', () => {
      assert.deepEqual(splitPath('Foo.cs'), { dir: '', root: 'Foo' })
    })

    it('treats a leading dot on a dotfile as part of the root', () => {
      assert.deepEqual(splitPath('.gitignore'), { dir: '', root: '.gitignore' })
    })
  })

  describe('computeRescuedPaths', () => {
    it('rescues Foo.cs.meta when Foo.cs is also changed in the same dir', () => {
      const rescued = computeRescuedPaths(
        ['a/Foo.cs', 'a/Foo.cs.meta'],
        new Set(['meta'])
      )
      assert.deepEqual([...rescued], ['a/Foo.cs.meta'])
    })

    it('rescues across differing final extensions if the root matches', () => {
      const rescued = computeRescuedPaths(
        ['a/Foo.cs', 'a/Foo.png.meta'],
        new Set(['meta'])
      )
      assert.deepEqual([...rescued], ['a/Foo.png.meta'])
    })

    it('does not rescue across directories', () => {
      const rescued = computeRescuedPaths(
        ['a/Foo.cs', 'b/Foo.meta'],
        new Set(['meta'])
      )
      assert.equal(rescued.size, 0)
    })

    it('is case-sensitive on the root name', () => {
      const rescued = computeRescuedPaths(
        ['a/foo.cs', 'a/Foo.meta'],
        new Set(['meta'])
      )
      assert.equal(rescued.size, 0)
    })

    it('returns nothing when no hidden extensions are configured', () => {
      assert.equal(
        computeRescuedPaths(['a/Foo.cs', 'a/Foo.meta'], new Set()).size,
        0
      )
    })
  })

  describe('buildRescueLinks', () => {
    it('links a hidden file to its non-hidden sibling both ways', () => {
      const links = buildRescueLinks(
        ['a/Foo.cs', 'a/Foo.cs.meta'],
        new Set(['meta'])
      )
      assert.deepEqual([...links.get('a/Foo.cs')!], ['a/Foo.cs.meta'])
      assert.deepEqual([...links.get('a/Foo.cs.meta')!], ['a/Foo.cs'])
    })

    it('links a hidden file to every non-hidden sibling sharing the root', () => {
      const links = buildRescueLinks(
        ['a/Foo.cs', 'a/Foo.md', 'a/Foo.meta'],
        new Set(['meta'])
      )
      assert.deepEqual([...links.get('a/Foo.meta')!].sort(), [
        'a/Foo.cs',
        'a/Foo.md',
      ])
    })
  })

  describe('expandLinkedFileIds', () => {
    const files = [
      { id: 'Modified+a/Foo.cs', path: 'a/Foo.cs' },
      { id: 'Modified+a/Foo.cs.meta', path: 'a/Foo.cs.meta' },
      { id: 'Modified+a/Bar.cs', path: 'a/Bar.cs' },
    ]
    const filtersOn = {
      hiddenExtensions: 'meta',
      keepHiddenWithChangedSibling: true,
    }

    it('is a no-op when the linking flag is off', () => {
      const initial = new Set(['Modified+a/Foo.cs'])
      const out = expandLinkedFileIds(
        files,
        { hiddenExtensions: 'meta', keepHiddenWithChangedSibling: false },
        initial
      )
      assert.equal(out, initial)
    })

    it('extends a rescuer toggle to its rescued sibling', () => {
      const out = expandLinkedFileIds(
        files,
        filtersOn,
        new Set(['Modified+a/Foo.cs'])
      )
      assert.deepEqual([...out].sort(), [
        'Modified+a/Foo.cs',
        'Modified+a/Foo.cs.meta',
      ])
    })

    it('extends a rescued toggle back to its rescuer', () => {
      const out = expandLinkedFileIds(
        files,
        filtersOn,
        new Set(['Modified+a/Foo.cs.meta'])
      )
      assert.deepEqual([...out].sort(), [
        'Modified+a/Foo.cs',
        'Modified+a/Foo.cs.meta',
      ])
    })

    it('leaves unrelated files untouched', () => {
      const out = expandLinkedFileIds(
        files,
        filtersOn,
        new Set(['Modified+a/Bar.cs'])
      )
      assert.deepEqual([...out], ['Modified+a/Bar.cs'])
    })
  })
})
