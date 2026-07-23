import { describe, it } from 'node:test'
import assert from 'node:assert'

import { updateChangedFiles } from '../../src/lib/stores/updates/changes-state'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
  WorkingDirectoryStatus,
} from '../../src/models/status'
import { DiffSelection, DiffSelectionType } from '../../src/models/diff'
import { sortByMtimeDesc } from '../../src/lib/sort-changes'
import { applyFilterOptions } from '../../src/ui/changes/filter-changes-logic'
import { DEFAULT_FILE_LIST_FILTER } from '../../src/lib/app-state'
import { computeRescuedPaths } from '../../src/lib/hidden-extensions'
import { createState, createStatus } from '../helpers/changes-state-helper'

const allSelected = DiffSelection.fromInitialSelection(DiffSelectionType.All)

function mkFile(path: string, kind: AppFileStatusKind = AppFileStatusKind.Modified, mtimeMs: number | null = null) {
  return new WorkingDirectoryFileChange(path, { kind } as any, allSelected, mtimeMs)
}

describe('changes-state.updateChangedFiles', () => {
  it('leaves new (non-hidden) files with their default all-selected state', () => {
    const state = createState({})
    const status = createStatus({
      workingDirectory: WorkingDirectoryStatus.fromFiles([mkFile('a/Foo.cs')]),
    })
    const { workingDirectory } = updateChangedFiles(state, status, false)
    assert.equal(workingDirectory.files[0].isIncludedInCommit(), true)
  })

  it('starts new hidden-extension files unchecked on first appearance', () => {
    const state = createState({
      fileListFilter: {
        ...DEFAULT_FILE_LIST_FILTER,
        hiddenExtensions: 'meta',
      },
    })
    const status = createStatus({
      workingDirectory: WorkingDirectoryStatus.fromFiles([
        mkFile('a/Foo.cs'),
        mkFile('a/Foo.cs.meta'),
      ]),
    })
    const { workingDirectory } = updateChangedFiles(state, status, false)
    const cs = workingDirectory.files.find(f => f.path === 'a/Foo.cs')!
    const meta = workingDirectory.files.find(f => f.path === 'a/Foo.cs.meta')!
    assert.equal(cs.isIncludedInCommit(), true)
    assert.equal(meta.isExcludedFromCommit(), true)
  })

  it('preserves an already-checked selection across a status refresh even when the extension is hidden', () => {
    // First appearance: hidden ext → default unchecked
    const s0 = createState({
      fileListFilter: {
        ...DEFAULT_FILE_LIST_FILTER,
        hiddenExtensions: 'meta',
      },
    })
    const status = createStatus({
      workingDirectory: WorkingDirectoryStatus.fromFiles([mkFile('a/Foo.meta')]),
    })
    const r0 = updateChangedFiles(s0, status, false)
    assert.equal(r0.workingDirectory.files[0].isExcludedFromCommit(), true)

    // Simulate user ticking the checkbox — selection becomes all-included.
    const withTicked = createState({
      workingDirectory: WorkingDirectoryStatus.fromFiles([
        r0.workingDirectory.files[0].withIncludeAll(true),
      ]),
      fileListFilter: s0.fileListFilter,
    })
    const r1 = updateChangedFiles(withTicked, status, false)
    // Preserved: the merge branch reuses existingFile.selection, not the
    // "new file" default-uncheck rule.
    assert.equal(r1.workingDirectory.files[0].isIncludedInCommit(), true)
  })
})

describe('sortByMtimeDesc', () => {
  it('sorts files newest-first, path-ascending on ties', () => {
    const a = mkFile('a', AppFileStatusKind.Modified, 100)
    const b = mkFile('b', AppFileStatusKind.Modified, 300)
    const c = mkFile('c', AppFileStatusKind.Modified, 300)
    const sorted = sortByMtimeDesc([a, b, c])
    assert.deepEqual(
      sorted.map(f => f.path),
      ['b', 'c', 'a']
    )
  })

  it('sinks files with a null mtime to the bottom, in path order', () => {
    const a = mkFile('a', AppFileStatusKind.Modified, 100)
    const b = mkFile('b', AppFileStatusKind.Deleted, null)
    const c = mkFile('c', AppFileStatusKind.Deleted, null)
    const d = mkFile('d', AppFileStatusKind.Modified, 200)
    const sorted = sortByMtimeDesc([a, b, c, d])
    assert.deepEqual(
      sorted.map(f => f.path),
      ['d', 'a', 'b', 'c']
    )
  })

  it('is stable enough that all-null-mtime input keeps path order', () => {
    const files = ['zeta', 'alpha', 'mu'].map(p => mkFile(p, AppFileStatusKind.Deleted, null))
    const sorted = sortByMtimeDesc(files)
    assert.deepEqual(
      sorted.map(f => f.path),
      ['alpha', 'mu', 'zeta']
    )
  })
})

describe('applyFilterOptions with hidden-ext + rescue + status', () => {
  const mkItem = (path: string, kind: AppFileStatusKind) => ({
    id: `${kind}+${path}`,
    text: [path],
    change: mkFile(path, kind),
  })

  it('hides a hidden-ext file when the filter is on and no sibling rescues it', () => {
    const filters = {
      ...DEFAULT_FILE_LIST_FILTER,
      hiddenExtensions: 'meta',
    }
    const item = mkItem('a/Only.meta', AppFileStatusKind.Modified)
    assert.equal(applyFilterOptions(item, filters), false)
  })

  it('rescues a hidden-ext file when a sibling is changed and rescue is enabled', () => {
    const filters = {
      ...DEFAULT_FILE_LIST_FILTER,
      hiddenExtensions: 'meta',
      keepHiddenWithChangedSibling: true,
    }
    const paths = ['a/Foo.cs', 'a/Foo.cs.meta']
    const rescued = computeRescuedPaths(paths, new Set(['meta']))
    const item = mkItem('a/Foo.cs.meta', AppFileStatusKind.Modified)
    assert.equal(applyFilterOptions(item, filters, rescued), true)
  })

  it('does NOT rescue when the flag is off, even if the sibling is changed', () => {
    const filters = {
      ...DEFAULT_FILE_LIST_FILTER,
      hiddenExtensions: 'meta',
      keepHiddenWithChangedSibling: false,
    }
    const rescued = computeRescuedPaths(
      ['a/Foo.cs', 'a/Foo.cs.meta'],
      new Set(['meta'])
    )
    const item = mkItem('a/Foo.cs.meta', AppFileStatusKind.Modified)
    assert.equal(applyFilterOptions(item, filters, rescued), false)
  })

  it('still applies status filters on top of a rescued file', () => {
    const filters = {
      ...DEFAULT_FILE_LIST_FILTER,
      hiddenExtensions: 'meta',
      keepHiddenWithChangedSibling: true,
      isDeletedFile: true, // only deleted files pass this filter
    }
    const rescued = computeRescuedPaths(
      ['a/Foo.cs', 'a/Foo.cs.meta'],
      new Set(['meta'])
    )
    // Modified, hidden-ext, rescued — but status filter demands Deleted.
    const modifiedItem = mkItem('a/Foo.cs.meta', AppFileStatusKind.Modified)
    assert.equal(applyFilterOptions(modifiedItem, filters, rescued), false)
    // Deleted, hidden-ext, rescued — passes both.
    const deletedItem = mkItem('a/Foo.cs.meta', AppFileStatusKind.Deleted)
    assert.equal(applyFilterOptions(deletedItem, filters, rescued), true)
  })
})
