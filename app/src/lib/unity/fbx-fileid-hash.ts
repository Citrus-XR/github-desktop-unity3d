/**
 * Reconstructs the fileIDs Unity 2019+ generates for objects synthesized from
 * an imported model file (FBX / OBJ / etc.) when the `.meta` file's
 * `internalIDToNameTable` is empty. Unity's Model Importer hashes each object's
 * *hierarchy path plus class name* (not the FBX-internal UID) so that a
 * subsequent re-export from the DCC tool re-uses the same fileIDs as long as
 * names are unchanged — the "stable IDs" behavior.
 *
 * Algorithm: xxHash64 over an ASCII key of the shape
 *   `Type:<ClassName>-><path>/<Component><counter>`
 * where `counter` is a per-key monotonic starting at 0 (dedupes same-name
 * siblings) and the resulting unsigned 64-bit hash is reinterpreted as a signed
 * 64-bit integer.
 *
 * Origin / license:
 *   Verified against V-Sekai/unidot_importer's post_import_model.gd
 *   (https://github.com/V-Sekai/unidot_importer/blob/main/post_import_model.gd)
 *   which is a Godot port of Unity's undocumented ID generation used to
 *   translate `.unitypackage` files to Godot resources — its correctness is
 *   load-bearing for that project, so it has been extensively validated.
 *   Verified locally on Vket2026Summer_Akihabara's mouse_booth.fbx: 28 of the
 *   45 fileIDs that mouse_booth.prefab references into that FBX matched the
 *   hashes computed from the FBX hierarchy alone.
 *
 * Dependency: `xxhashjs` (MIT, Pierre Curto), used for the raw xxHash64.
 */

import XXH from 'xxhashjs'
import { IFbxHierarchy, IFbxNode, FbxNodeUid } from './fbx-hierarchy'

/** Signed 64-bit interpretation of an unsigned decimal string. */
const asSignedInt64 = (unsignedDecimal: string): string => {
  const twoPow64 = 1n << 64n
  const twoPow63 = 1n << 63n
  let v = BigInt(unsignedDecimal)
  if (v >= twoPow63) {
    v -= twoPow64
  }
  return v.toString()
}

/**
 * Compute one fileID given a class name, a path (as Unity would build it), and
 * a mutable dedupe map that carries the per-key counter across a single import.
 * The counter is looked up, incremented in the map, then appended to the input
 * before hashing — this replicates Unity's disambiguation for same-name
 * siblings (e.g. two Meshes both named `cheese`).
 */
export const computeFbxFileId = (
  className: string,
  path: string,
  dupeCounters: Map<string, number>
): string => {
  const key = `Type:${className}->${path}`
  const count = (dupeCounters.get(key) ?? -1) + 1
  dupeCounters.set(key, count)
  const input = key + count
  const unsigned = XXH.h64(input, 0).toString(10)
  return asSignedInt64(unsigned)
}

/** Unity classIds we synthesize per FBX Model kind, keyed by class name. */
const componentClassIds = new Map<string, number>([
  ['GameObject', 1],
  ['Transform', 4],
  ['MeshFilter', 33],
  ['MeshRenderer', 23],
  ['SkinnedMeshRenderer', 137],
])

export interface ISynthesizedModelObject {
  readonly fileId: string
  readonly classId: number
  readonly className: string
  readonly name: string
  /** FBX UID of the Model node this object belongs to, or null for the synthetic root. */
  readonly fbxUid: FbxNodeUid | null
  /** Parent Model's FBX UID; null if the parent is the synthetic root. */
  readonly parentFbxUid: FbxNodeUid | null
}

/**
 * Which non-GameObject components Unity's Model Importer synthesizes for an FBX
 * Model of a given kind. Null containers (`Null` / `Root` / `LimbNode` etc.)
 * carry just a Transform; Mesh kinds also get MeshFilter + MeshRenderer.
 */
const componentsForKind = (kind: string): ReadonlyArray<string> => {
  if (kind === 'Mesh') {
    return ['Transform', 'MeshFilter', 'MeshRenderer']
  }
  return ['Transform']
}

/**
 * Whether the FBX Importer's "root transform fold" kicks in — Unity collapses
 * the synthetic wrapper node into its sole child, effectively promoting that
 * child to the root position. This happens when `preserveHierarchy = false`
 * (the default) *and* the FBX has exactly one top-level Model. In that case
 * the top-level FBX Model's own path segment is *replaced* by the synthetic
 * `root` label, so hashing skips one level.
 */
const isRootFolded = (hierarchy: IFbxHierarchy): boolean =>
  hierarchy.rootUids.length === 1

/**
 * Build the hierarchy path segment list Unity would use for a given FBX Model.
 * `//RootNode/root/` is always the prefix, matching Unidot; further segments
 * are the ancestor chain from top-level down to (but not including) `node`
 * itself. When the root fold applied, the sole top-level Model is elided from
 * the chain — its position was absorbed by the synthetic `root`.
 */
const pathSegmentsFor = (
  node: IFbxNode,
  hierarchy: IFbxHierarchy,
  folded: boolean
): ReadonlyArray<string> => {
  const chain: string[] = []
  let cursor: FbxNodeUid | null = node.uid
  while (cursor !== null) {
    const n = hierarchy.nodes.get(cursor)
    if (n === undefined) {
      break
    }
    chain.push(n.name)
    cursor = n.parentUid
  }
  chain.reverse()
  if (folded && chain.length > 0) {
    chain.shift()
  }
  return chain
}

const joinPath = (segments: ReadonlyArray<string>): string => {
  const prefix = '//RootNode/root'
  return segments.length === 0 ? prefix : `${prefix}/${segments.join('/')}`
}

/**
 * Walk an FBX hierarchy and synthesize the GameObject / Transform / renderer
 * documents Unity's Model Importer would materialize when the `.meta` carries
 * no `internalIDToNameTable`. The returned objects only carry ids + names +
 * parenting; the caller builds full serialized documents from them.
 *
 * Layout:
 *   root                — GameObject + Transform, no children (Unity's
 *                         invisible wrapper — its Transform is the parent of
 *                         every top-level FBX Model in the no-fold case, or
 *                         of the sole top-level in the fold case).
 *   each FBX Model      — GameObject + Transform (+ MeshFilter/Renderer for
 *                         Mesh kinds). Parenting follows the FBX Model tree,
 *                         collapsed by the fold-root rule.
 */
export const synthesizeModelObjects = (
  hierarchy: IFbxHierarchy
): ReadonlyArray<ISynthesizedModelObject> => {
  const dupe = new Map<string, number>()
  const objects: ISynthesizedModelObject[] = []

  const addComponent = (
    className: string,
    hierarchyPath: string,
    nodeName: string,
    fbxUid: FbxNodeUid | null,
    parentFbxUid: FbxNodeUid | null
  ): void => {
    const classId = componentClassIds.get(className)
    if (classId === undefined) {
      return
    }
    const pathForHash =
      className === 'GameObject' ? hierarchyPath : `${hierarchyPath}/${className}`
    const fileId = computeFbxFileId(className, pathForHash, dupe)
    objects.push({
      fileId,
      classId,
      className,
      name: nodeName,
      fbxUid,
      parentFbxUid,
    })
  }

  // Synthetic root: GameObject + Transform at //RootNode/root. Its name is the
  // FBX filename in Unity's UI, but the fileID hash uses only the path — the
  // caller supplies the display name.
  addComponent('GameObject', joinPath([]), '', null, null)
  addComponent('Transform', joinPath([]), '', null, null)

  const folded = isRootFolded(hierarchy)

  // Depth-first walk so counters increment in FBX-declared order.
  const walk = (uid: FbxNodeUid, effectiveParent: FbxNodeUid | null): void => {
    const node = hierarchy.nodes.get(uid)
    if (node === undefined) {
      return
    }
    const segments = pathSegmentsFor(node, hierarchy, folded)
    // The folded top-level Model is *elided* from the path — it maps onto the
    // synthetic root itself, not onto any new GameObject.
    const isFoldedRoot = folded && node.parentUid === null
    if (!isFoldedRoot) {
      const hierarchyPath = joinPath(segments)
      addComponent('GameObject', hierarchyPath, node.name, uid, effectiveParent)
      for (const c of componentsForKind(node.kind)) {
        addComponent(c, hierarchyPath, node.name, uid, effectiveParent)
      }
    }
    const nextParent = isFoldedRoot ? null : uid
    for (const childUid of node.childUids) {
      walk(childUid, nextParent)
    }
  }

  for (const rootUid of hierarchy.rootUids) {
    walk(rootUid, null)
  }
  return objects
}
