/**
 * Scans a repository's `.meta` files to build a GUID/path index for the working
 * tree. Only `Assets/`, `Packages/`, and `Library/PackageCache/` are walked.
 * Symlinked directories are skipped to prevent traversal outside the repository
 * and to avoid cycles, and recursion depth is bounded as a safety limit against
 * pathological trees.
 *
 * Results are cached per repository path with a short TTL, so a working-tree
 * change (a new script, a renamed prefab) picks up on the next request instead
 * of staying stale until the app restarts.
 */

import { join, relative, sep } from 'path'
import { readdir, readFile } from 'fs/promises'
import { buildMetaIndex, IMetaFile, MetaIndex } from '../../lib/unity/meta-index'
import { isErrnoException } from '../../lib/errno-exception'

// `Library/PackageCache` is an optional source: it holds the text `.prefab`/
// `.meta` files of cached (non-embedded) packages, which scene/prefab instances
// reference. It is git-ignored, so it may be absent — the walk skips missing
// roots and base functionality is unaffected. This is NOT Library's binary
// artifact database, just more YAML/meta files.
const scannedRoots = ['Assets', 'Packages', 'Library/PackageCache']
const maxDepth = 64

// Cached meta indices live for this long before a fresh scan on the next
// request. A running Unity session frequently creates and moves assets, so an
// index that is stable-for-the-session goes wrong as soon as the user adds a
// script or renames a prefab; bounding the staleness re-scans on demand instead
// of asking the user to restart.
const metaIndexTtlMs = 30_000

// Bound on simultaneously open file descriptors while reading `.meta` files. A
// large Unity project holds tens of thousands of them; reading without a cap
// exhausts the process's descriptor limit (EMFILE).
const maxConcurrentReads = 128

const toRepoRelativePath = (repoPath: string, fullPath: string): string =>
  relative(repoPath, fullPath).split(sep).join('/')

const collectMetaPaths = async (
  dir: string,
  depth: number,
  out: Array<string>
): Promise<void> => {
  if (depth > maxDepth) {
    return
  }

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    // Missing / not-a-directory is expected (e.g. no Packages/, no
    // Library/PackageCache/). Anything else — permission errors, IO errors —
    // is a real problem the caller should see rather than a silent empty scan.
    if (isErrnoException(e) && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return
    }
    throw e
  }

  // Recurse into subdirectories concurrently and collect `.meta` paths. A
  // directory entry that is itself a symlink is skipped, preventing traversal
  // outside the repository and breaking cycles. `withFileTypes` makes the entry
  // type authoritative, so no extra `lstat` per file is needed.
  const subdirs = new Array<Promise<void>>()
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue
    }
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      subdirs.push(collectMetaPaths(fullPath, depth + 1, out))
    } else if (entry.isFile() && entry.name.endsWith('.meta')) {
      out.push(fullPath)
    }
  }
  await Promise.all(subdirs)
}

const readMetaFiles = async (
  repoPath: string,
  paths: ReadonlyArray<string>
): Promise<Array<IMetaFile>> => {
  const out = new Array<IMetaFile>()
  let next = 0
  const reader = async (): Promise<void> => {
    while (next < paths.length) {
      const fullPath = paths[next++]
      try {
        const content = await readFile(fullPath, 'utf8')
        out.push({ metaPath: toRepoRelativePath(repoPath, fullPath), content })
      } catch (e) {
        // A meta that disappeared between the walk and the read is fine (a
        // partial index is acceptable). Other errno values are not — surface
        // them rather than silently skipping.
        if (isErrnoException(e) && e.code === 'ENOENT') {
          continue
        }
        throw e
      }
    }
  }
  const lanes = Math.min(maxConcurrentReads, paths.length)
  await Promise.all(Array.from({ length: lanes }, reader))
  return out
}

interface ICacheEntry {
  readonly promise: Promise<MetaIndex>
  readonly builtAt: number
}
const cache = new Map<string, ICacheEntry>()

const scan = async (repoPath: string): Promise<MetaIndex> => {
  const paths = new Array<string>()
  await Promise.all(
    scannedRoots.map(root => collectMetaPaths(join(repoPath, root), 0, paths))
  )
  return buildMetaIndex(await readMetaFiles(repoPath, paths))
}

/** Get (building and caching on first use) the working-tree Meta index. */
export const getWorkingTreeMetaIndex = (
  repoPath: string
): Promise<MetaIndex> => {
  const cached = cache.get(repoPath)
  if (cached !== undefined && Date.now() - cached.builtAt < metaIndexTtlMs) {
    return cached.promise
  }
  const entry: ICacheEntry = { promise: scan(repoPath), builtAt: Date.now() }
  cache.set(repoPath, entry)
  return entry.promise
}
