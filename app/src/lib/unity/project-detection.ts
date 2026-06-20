/**
 * Detection of Unity projects from repository contents alone. A repository is
 * treated as a Unity project when it has an `Assets` directory and a
 * `ProjectSettings/ProjectVersion.txt` file — the two artifacts Unity always
 * writes and commits. Detection deliberately never requires the `Library`
 * directory, which is generated locally and routinely git-ignored.
 */

import { join } from 'path'
import { stat } from 'fs/promises'

const pathExists = async (
  path: string,
  kind: 'file' | 'directory'
): Promise<boolean> => {
  try {
    const stats = await stat(path)
    return kind === 'file' ? stats.isFile() : stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Determine whether the repository rooted at `rootPath` is a Unity project.
 * Requires `Assets/` and `ProjectSettings/ProjectVersion.txt`; the optional
 * `Packages/manifest.json` and `Library/` are not consulted here.
 */
export const isUnityProject = async (rootPath: string): Promise<boolean> => {
  const [hasAssets, hasProjectVersion] = await Promise.all([
    pathExists(join(rootPath, 'Assets'), 'directory'),
    pathExists(
      join(rootPath, 'ProjectSettings', 'ProjectVersion.txt'),
      'file'
    ),
  ])
  return hasAssets && hasProjectVersion
}
