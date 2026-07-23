import { WorkingDirectoryFileChange } from '../models/status'

/**
 * Sort files newest-first by mtime, with path as a stable secondary key so
 * files without a known mtime (deleted, or not yet stat'd) sort together and
 * remain in their original path order relative to each other.
 */
export function sortByMtimeDesc(
  files: ReadonlyArray<WorkingDirectoryFileChange>
): ReadonlyArray<WorkingDirectoryFileChange> {
  return [...files].sort((a, b) => {
    const am = a.mtimeMs
    const bm = b.mtimeMs
    if (am === null && bm === null) {
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    }
    if (am === null) {
      return 1
    }
    if (bm === null) {
      return -1
    }
    if (am !== bm) {
      return bm - am
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
}
