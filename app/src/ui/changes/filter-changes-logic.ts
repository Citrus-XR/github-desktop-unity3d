import { IFileListFilterState } from '../../lib/app-state'
import {
  getFinalExtension,
  parseHiddenExtensions,
} from '../../lib/hidden-extensions'
import { IChangesListItem } from './filter-changes-list'
import memoizeOne from 'memoize-one'

const EMPTY_PATH_SET: ReadonlySet<string> = new Set<string>()

/**
 * Apply filter options to determine if a file should be shown.
 * Uses AND logic - file must satisfy ALL active filters.
 * Note: This is applied after the filterText has been applied.
 */
export function applyFilterOptions(
  item: IChangesListItem,
  filters: IFileListFilterState,
  rescuedPaths: ReadonlySet<string> = EMPTY_PATH_SET
): boolean {
  const { change } = item

  const hiddenExtensions = parseHiddenExtensions(filters.hiddenExtensions)
  if (hiddenExtensions.size > 0) {
    const ext = getFinalExtension(change.path)
    if (hiddenExtensions.has(ext)) {
      if (
        !filters.keepHiddenWithChangedSibling ||
        !rescuedPaths.has(change.path)
      ) {
        return false
      }
    }
  }

  // If no status filters are active, don't require any of them.
  if (countActiveStatusFilters(filters) === 0) {
    return true
  }

  if (filters.isIncludedInCommit && !change.isIncludedInCommit()) {
    return false
  }

  if (filters.isExcludedFromCommit && !change.isExcludedFromCommit()) {
    return false
  }

  if (filters.isNewFile && !change.isNew() && !change.isUntracked()) {
    return false
  }

  if (filters.isModifiedFile && !change.isModified()) {
    return false
  }

  if (filters.isDeletedFile && !change.isDeleted()) {
    return false
  }

  return true
}

/**
 * Check if any files being committed are hidden by the current filter.
 * Memoized to avoid recalculating for the same inputs.
 */
export const isCommittingFileHiddenByFilter = memoizeOne(
  (
    fileIdsIncludedInCommit: ReadonlyArray<string>,
    filteredItems: Map<string, IChangesListItem>,
    fileCount: number,
    filters: IFileListFilterState
  ): boolean => {
    // All possible files are present in the list (no active filters or all files match active filters)
    if (!hasActiveFilters(filters) || filteredItems.size === fileCount) {
      return false
    }

    // If filtered rows count is 1 and included for commit rows count is 2,
    // there is no way the included for commit rows are visible regardless of
    // what they are.
    if (fileIdsIncludedInCommit.length > filteredItems.size) {
      return true
    }

    // If we can find a file id included in the commit that does not exist in
    // the filtered items, then we are committing a hidden file.
    return fileIdsIncludedInCommit.some(fId => !filteredItems.get(fId))
  }
)

/** Generate message when no files match filters. */
export function getNoResultsMessage(
  filters: IFileListFilterState
): string | undefined {
  if (!hasActiveFilters(filters)) {
    return undefined
  }

  const activeFilters: string[] = []

  if (filters.filterText) {
    activeFilters.push(`"${filters.filterText}"`)
  }

  if (filters.isIncludedInCommit) {
    activeFilters.push('Included in commit')
  }

  if (filters.isExcludedFromCommit) {
    activeFilters.push('Excluded from commit')
  }

  if (filters.isNewFile) {
    activeFilters.push('New files')
  }

  if (filters.isModifiedFile) {
    activeFilters.push('Modified files')
  }

  if (filters.isDeletedFile) {
    activeFilters.push('Deleted files')
  }

  if (parseHiddenExtensions(filters.hiddenExtensions).size > 0) {
    activeFilters.push(`Hiding extensions: ${filters.hiddenExtensions}`)
  }

  if (activeFilters.length === 0) {
    return undefined
  }

  // Format the list with proper grammar (e.g., "A, B, and C")
  let filterList: string
  if (activeFilters.length === 1) {
    filterList = activeFilters[0]
  } else if (activeFilters.length === 2) {
    filterList = `${activeFilters[0]} and ${activeFilters[1]}`
  } else {
    const lastFilter = activeFilters[activeFilters.length - 1]
    const otherFilters = activeFilters.slice(0, -1)
    filterList = `${otherFilters.join(', ')}, and ${lastFilter}`
  }
  return `Sorry, I can't find any changed files matching the following filters: ${filterList}`
}

function countActiveStatusFilters(filters: IFileListFilterState): number {
  return [
    filters.isIncludedInCommit,
    filters.isNewFile,
    filters.isModifiedFile,
    filters.isDeletedFile,
    filters.isExcludedFromCommit,
  ].filter(Boolean).length
}

/**
 * Count the number of active filter options.
 * Note: This does not include the filterText filter.
 */
export function countActiveFilterOptions(
  filters: IFileListFilterState
): number {
  let count = countActiveStatusFilters(filters)
  if (parseHiddenExtensions(filters.hiddenExtensions).size > 0) {
    count += 1
  }
  return count
}

/** Check if there are any active filters. */
export function hasActiveFilters(filters: IFileListFilterState): boolean {
  return filters.filterText !== '' || countActiveFilterOptions(filters) > 0
}

/**
 * Apply filters to a changes list item.
 * Memoized to avoid recalculating for the same inputs.
 */
export const applyFilters = memoizeOne(
  (
    item: IChangesListItem,
    showChangesFilter: boolean,
    filters: IFileListFilterState,
    rescuedPaths: ReadonlySet<string>
  ) => {
    if (!showChangesFilter) {
      return true
    }

    return applyFilterOptions(item, filters, rescuedPaths)
  }
)
