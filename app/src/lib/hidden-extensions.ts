/**
 * Pure helpers for the "hide by extension" changes-list filter. Lives under
 * `lib/` (not `ui/`) so the store-layer status merge can reuse them without
 * dragging a UI dependency backwards through the layers.
 */

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>()
const EMPTY_PATH_SET: ReadonlySet<string> = new Set<string>()

/**
 * Parse the raw comma-separated `hiddenExtensions` string into a set of
 * extension tokens. Whitespace and a single leading dot are stripped; matching
 * is case-sensitive to keep behaviour predictable across case-preserving
 * filesystems.
 */
export function parseHiddenExtensions(raw: string): ReadonlySet<string> {
  if (raw === '') {
    return EMPTY_STRING_SET
  }
  const set = new Set<string>()
  for (const token of raw.split(',')) {
    const trimmed = token.trim()
    if (trimmed === '') {
      continue
    }
    set.add(trimmed.startsWith('.') ? trimmed.slice(1) : trimmed)
  }
  return set
}

/** Extension segment after the final `.` in the file's basename (no dot, no lowercasing). */
export function getFinalExtension(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

/**
 * The directory portion of `path` (without a trailing slash) and the "root
 * name" of the file, i.e. everything before the FIRST dot in the basename.
 * Dotfiles like `.gitignore` treat the leading dot as part of the root name.
 */
export function splitPath(path: string): { dir: string; root: string } {
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const start = name.startsWith('.') ? 1 : 0
  const dot = name.indexOf('.', start)
  const root = dot > 0 ? name.slice(0, dot) : name
  return { dir, root }
}

/**
 * Given the changed-file set and the parsed hidden-extension list, find the
 * paths that are rescued from the extension filter by a same-directory sibling
 * whose root name matches case-sensitively and whose own extension is not
 * hidden. Derived from {@link buildRescueLinks} — a path is rescued iff the
 * link map has an entry for it.
 */
export function computeRescuedPaths(
  paths: ReadonlyArray<string>,
  hiddenExtensions: ReadonlySet<string>
): ReadonlySet<string> {
  if (hiddenExtensions.size === 0 || paths.length === 0) {
    return EMPTY_PATH_SET
  }
  const links = buildRescueLinks(paths, hiddenExtensions)
  if (links.size === 0) {
    return EMPTY_PATH_SET
  }
  const rescued = new Set<string>()
  for (const path of links.keys()) {
    if (hiddenExtensions.has(getFinalExtension(path))) {
      rescued.add(path)
    }
  }
  return rescued
}

/**
 * Build the (rescuer path ↔ rescued paths) links for a changed-file set given
 * a hidden-extension list. A file whose extension is hidden and that shares a
 * directory + root name with any non-hidden changed file is a rescued file;
 * every non-hidden file with the same (dir, root) is one of its rescuers.
 * Multiple rescuers can link to the same rescued file and vice versa. The map
 * is symmetric — both directions store the same set of counterparts.
 */
export function buildRescueLinks(
  paths: ReadonlyArray<string>,
  hiddenExtensions: ReadonlySet<string>
): ReadonlyMap<string, ReadonlySet<string>> {
  const empty: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  if (hiddenExtensions.size === 0 || paths.length === 0) {
    return empty
  }

  const byKey = new Map<string, { hidden: string[]; visible: string[] }>()
  for (const path of paths) {
    const { dir, root } = splitPath(path)
    const key = `${dir}\0${root}`
    let bucket = byKey.get(key)
    if (!bucket) {
      bucket = { hidden: [], visible: [] }
      byKey.set(key, bucket)
    }
    if (hiddenExtensions.has(getFinalExtension(path))) {
      bucket.hidden.push(path)
    } else {
      bucket.visible.push(path)
    }
  }

  const links = new Map<string, Set<string>>()
  for (const { hidden, visible } of byKey.values()) {
    if (hidden.length === 0 || visible.length === 0) {
      continue
    }
    for (const h of hidden) {
      const set = links.get(h) ?? new Set<string>()
      visible.forEach(v => set.add(v))
      links.set(h, set)
    }
    for (const v of visible) {
      const set = links.get(v) ?? new Set<string>()
      hidden.forEach(h => set.add(h))
      links.set(v, set)
    }
  }
  return links
}

/**
 * Return the id set to toggle when the user toggles `initialIds`, expanded to
 * include every rescued sibling of a rescuer (and vice versa). Only expands
 * when `keepHiddenWithChangedSibling` is on — otherwise linking is disabled
 * and the initial set is returned untouched.
 *
 * The internal rescue-link map is cached per `files` array identity + hidden
 * extensions string, so back-to-back toggles against the same working-directory
 * snapshot skip the O(N) rebuild.
 */
export function expandLinkedFileIds<T extends { id: string; path: string }>(
  files: ReadonlyArray<T>,
  filters: {
    readonly hiddenExtensions: string
    readonly keepHiddenWithChangedSibling: boolean
  },
  initialIds: ReadonlySet<string>
): ReadonlySet<string> {
  if (!filters.keepHiddenWithChangedSibling || initialIds.size === 0) {
    return initialIds
  }
  const hidden = parseHiddenExtensions(filters.hiddenExtensions)
  if (hidden.size === 0) {
    return initialIds
  }
  const links = getRescueLinksCached(files, hidden, filters.hiddenExtensions)
  if (links.size === 0) {
    return initialIds
  }

  const pathToIds = new Map<string, string[]>()
  const idToPath = new Map<string, string>()
  for (const f of files) {
    idToPath.set(f.id, f.path)
    let ids = pathToIds.get(f.path)
    if (!ids) {
      ids = []
      pathToIds.set(f.path, ids)
    }
    ids.push(f.id)
  }

  const out = new Set<string>(initialIds)
  for (const id of initialIds) {
    const path = idToPath.get(id)
    if (path === undefined) {
      continue
    }
    const linkedPaths = links.get(path)
    if (!linkedPaths) {
      continue
    }
    for (const lp of linkedPaths) {
      pathToIds.get(lp)?.forEach(lid => out.add(lid))
    }
  }
  return out
}

// Weakly-keyed rescue-link cache. The files array identity is the primary
// key (freshly allocated by the git-status merge on every WorkingDirectory
// update), scoped by hidden-extensions string so a filter tweak reruns the
// map. Old (files, string) pairs GC with the working directory snapshot.
const rescueLinkCache = new WeakMap<
  object,
  { key: string; links: ReadonlyMap<string, ReadonlySet<string>> }
>()

function getRescueLinksCached(
  files: ReadonlyArray<{ path: string }>,
  hidden: ReadonlySet<string>,
  hiddenKey: string
): ReadonlyMap<string, ReadonlySet<string>> {
  const cached = rescueLinkCache.get(files as unknown as object)
  if (cached && cached.key === hiddenKey) {
    return cached.links
  }
  const links = buildRescueLinks(
    files.map(f => f.path),
    hidden
  )
  rescueLinkCache.set(files as unknown as object, { key: hiddenKey, links })
  return links
}
