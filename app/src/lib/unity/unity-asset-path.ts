/**
 * Unity text-serialized asset extensions plus the extension check. Kept in a
 * dependency-free leaf module so scripts (e.g. `script/unity-diff-stress.ts`)
 * can import it without pulling `Repository` — and, through it, the renderer
 * module graph including `api.ts` — into `tsc -P script/tsconfig.json`, which
 * has neither `jsx` nor the DefinePlugin globals declared.
 *
 * `.meta` files are intentionally excluded: they carry no `!u!` documents and
 * serve the GUID index, not the inspector.
 */

import { extname } from 'path'

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
