/**
 * Decides whether a changed file should be presented with the Unity semantic
 * diff renderer instead of the standard text diff. Two conditions must hold:
 * the file extension is a Unity text-serialized asset, and the repository is a
 * Unity project. The project check is memoized per repository path with a
 * short TTL so the common case (a non-Unity repo, or repeated diffs in the
 * same repo) costs at most one filesystem probe per window, while a repo that
 * later becomes (or stops being) a Unity project is picked up on subsequent
 * requests.
 *
 * `.meta` files are intentionally excluded: they carry no `!u!` documents and
 * serve the GUID index, not the inspector, so they remain plain text diffs.
 */

import { extname } from 'path'
import { Repository } from '../../models/repository'
import { isUnityProject } from './project-detection'

const unityAssetExtensions: ReadonlySet<string> = new Set([
  '.unity',
  '.prefab',
  '.asset',
  '.mat',
  '.anim',
  '.controller',
  '.overridecontroller',
  '.rendertexture',
  '.physicsmaterial',
])

/** Whether a repository-relative path is a Unity text-serialized asset. */
export const isUnityAssetPath = (path: string): boolean =>
  unityAssetExtensions.has(extname(path).toLowerCase())

interface IProjectCacheEntry {
  readonly promise: Promise<boolean>
  readonly builtAt: number
}
const projectCacheTtlMs = 60_000
const unityProjectCache = new Map<string, IProjectCacheEntry>()

const isUnityRepository = (repository: Repository): Promise<boolean> => {
  const cached = unityProjectCache.get(repository.path)
  if (cached !== undefined && Date.now() - cached.builtAt < projectCacheTtlMs) {
    return cached.promise
  }
  const entry: IProjectCacheEntry = {
    promise: isUnityProject(repository.path),
    builtAt: Date.now(),
  }
  unityProjectCache.set(repository.path, entry)
  return entry.promise
}

/**
 * Whether the given file in the given repository should use the Unity diff
 * renderer. Cheap extension test first; the project probe only runs for files
 * that could plausibly be Unity assets.
 */
export const shouldUseUnityDiff = async (
  repository: Repository,
  path: string
): Promise<boolean> => {
  if (!isUnityAssetPath(path)) {
    return false
  }
  return isUnityRepository(repository)
}
