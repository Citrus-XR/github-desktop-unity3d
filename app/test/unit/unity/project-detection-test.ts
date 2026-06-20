import { describe, it, TestContext } from 'node:test'
import assert from 'node:assert'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { createTempDirectory } from '../../helpers/temp'
import { isUnityProject } from '../../../src/lib/unity/project-detection'

describe('isUnityProject', () => {
  it('detects a project with Assets and ProjectVersion.txt', async (t: TestContext) => {
    const dir = await createTempDirectory(t)
    await mkdir(join(dir, 'Assets'))
    await mkdir(join(dir, 'ProjectSettings'))
    await writeFile(
      join(dir, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.22f1\n'
    )

    assert.equal(await isUnityProject(dir), true)
  })

  it('does not require a Library directory', async (t: TestContext) => {
    const dir = await createTempDirectory(t)
    await mkdir(join(dir, 'Assets'))
    await mkdir(join(dir, 'ProjectSettings'))
    await writeFile(
      join(dir, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.22f1\n'
    )
    // Intentionally no Library/ — detection must still succeed.
    assert.equal(await isUnityProject(dir), true)
  })

  it('rejects a directory with Assets but no ProjectVersion.txt', async (t: TestContext) => {
    const dir = await createTempDirectory(t)
    await mkdir(join(dir, 'Assets'))
    assert.equal(await isUnityProject(dir), false)
  })

  it('rejects a non-Unity repository', async (t: TestContext) => {
    const dir = await createTempDirectory(t)
    await writeFile(join(dir, 'README.md'), '# hello\n')
    assert.equal(await isUnityProject(dir), false)
  })
})
