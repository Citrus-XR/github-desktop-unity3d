/**
 * Reconstructs the Model node hierarchy from a raw FBX file (ASCII or binary).
 * A Unity model asset's `.meta` names every generated object but records no
 * parent/child nesting — that lives inside the (binary) FBX itself. Reading
 * the FBX directly lets the semantic diff surface a nested tree (Armature /
 * Hips / Spine ...) instead of a flat pile of bones under the model root.
 *
 * We deliberately extract *only* the Model tree: node uid, name, subclass
 * ("LimbNode" / "Mesh" / "Null" / "Root" / ...), and the parent link derived
 * from Object-to-Object connections. Geometry / materials / textures are
 * ignored so this stays fast and cheap for a project-scale scan.
 */

import { parseBinary, parseText, FBXNode } from 'fbx-parser'

/** FBX node id, stored as a decimal string so it fits both 32- and 64-bit ids. */
export type FbxNodeUid = string

export interface IFbxNode {
  readonly uid: FbxNodeUid
  /** FBX Model name with the leading `Model::` prefix removed. */
  readonly name: string
  /** FBX Model subclass token, e.g. `LimbNode`, `Mesh`, `Null`, `Root`. */
  readonly kind: string
  /** Parent Model uid, or null when the parent is the implicit FBX RootNode. */
  readonly parentUid: FbxNodeUid | null
  readonly childUids: ReadonlyArray<FbxNodeUid>
}

export interface IFbxHierarchy {
  readonly nodes: ReadonlyMap<FbxNodeUid, IFbxNode>
  /** Uids of Models whose parent is the implicit FBX RootNode. */
  readonly rootUids: ReadonlyArray<FbxNodeUid>
}

// The exact 23-byte preamble every binary FBX begins with. We test only the
// human-readable prefix; the trailing `\x20\x20\x00\x1a\x00` marker is what the
// underlying parser itself validates.
const FBX_BINARY_MAGIC = 'Kaydara FBX Binary'

const isBinaryFbx = (bytes: Uint8Array): boolean => {
  if (bytes.length < FBX_BINARY_MAGIC.length) {
    return false
  }
  for (let i = 0; i < FBX_BINARY_MAGIC.length; i++) {
    if (bytes[i] !== FBX_BINARY_MAGIC.charCodeAt(i)) {
      return false
    }
  }
  return true
}

// FBX ids are 64-bit. fbx-parser hands us either a JS `number` (when the id
// fits `Number.MAX_SAFE_INTEGER`) or a `bigint` when it does not. Normalize to
// a decimal string so downstream keys never mix types.
const toUidString = (raw: unknown): FbxNodeUid | null => {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return String(raw)
  }
  if (typeof raw === 'bigint') {
    return raw.toString()
  }
  return null
}

const modelPrefix = 'Model::'
const stripModelPrefix = (name: string): string =>
  name.startsWith(modelPrefix) ? name.slice(modelPrefix.length) : name

const findSection = (
  roots: ReadonlyArray<FBXNode>,
  name: string
): FBXNode | undefined => roots.find(node => node.name === name)

interface IMutableFbxNode {
  name: string
  kind: string
  parentUid: FbxNodeUid | null
  childUids: FbxNodeUid[]
}

/**
 * Parse an FBX file (ASCII or binary) and return the Model tree.
 *
 * Throws if the input is not a recognizable FBX file or lacks an `Objects`
 * section. A missing `Connections` section is tolerated: every Model then
 * reports itself as a root.
 */
export const parseFbxHierarchy = (bytes: Uint8Array): IFbxHierarchy => {
  const rootSections = isBinaryFbx(bytes)
    ? parseBinary(bytes)
    : parseText(new TextDecoder('utf-8').decode(bytes))

  const objects = findSection(rootSections, 'Objects')
  if (objects === undefined) {
    throw new Error('FBX file has no Objects section')
  }

  const nodes = new Map<FbxNodeUid, IMutableFbxNode>()
  for (const child of objects.nodes) {
    if (child.name !== 'Model') {
      continue
    }
    const uid = toUidString(child.props[0])
    if (uid === null) {
      continue
    }
    const rawName =
      typeof child.props[1] === 'string' ? (child.props[1] as string) : ''
    const kind =
      typeof child.props[2] === 'string' ? (child.props[2] as string) : ''
    nodes.set(uid, {
      name: stripModelPrefix(rawName),
      kind,
      parentUid: null,
      childUids: [],
    })
  }

  const connections = findSection(rootSections, 'Connections')
  if (connections !== undefined) {
    for (const conn of connections.nodes) {
      if (conn.name !== 'C' && conn.name !== 'Connect') {
        continue
      }
      // Property layout: [type, sourceUid, destUid, (propertyName)]. Only OO
      // (object-to-object) entries encode parenting; OP (object-to-property)
      // links a value into someone's Properties70 and is not a parent link.
      if (conn.props[0] !== 'OO') {
        continue
      }
      const childUid = toUidString(conn.props[1])
      const parentUid = toUidString(conn.props[2])
      if (childUid === null || parentUid === null) {
        continue
      }
      const childNode = nodes.get(childUid)
      if (childNode === undefined) {
        continue
      }
      // Parent uid 0 is the implicit FBX RootNode.
      if (parentUid === '0') {
        continue
      }
      const parentNode = nodes.get(parentUid)
      if (parentNode === undefined) {
        continue
      }
      childNode.parentUid = parentUid
      parentNode.childUids.push(childUid)
    }
  }

  const rootUids: FbxNodeUid[] = []
  const frozen = new Map<FbxNodeUid, IFbxNode>()
  for (const [uid, node] of nodes) {
    if (node.parentUid === null) {
      rootUids.push(uid)
    }
    frozen.set(uid, {
      uid,
      name: node.name,
      kind: node.kind,
      parentUid: node.parentUid,
      childUids: node.childUids,
    })
  }
  return { nodes: frozen, rootUids }
}

/**
 * Build a `name → uid` index for a hierarchy, discarding any name that appears
 * more than once. Callers that need to match by unqualified name (Unity's
 * `internalIDToNameTable` stores leaf names only) can safely skip ambiguous
 * entries rather than parent them at random.
 */
export const uniqueNameIndex = (
  hierarchy: IFbxHierarchy
): ReadonlyMap<string, FbxNodeUid> => {
  const seen = new Set<string>()
  const index = new Map<string, FbxNodeUid>()
  for (const node of hierarchy.nodes.values()) {
    if (seen.has(node.name)) {
      index.delete(node.name)
      continue
    }
    seen.add(node.name)
    index.set(node.name, node.uid)
  }
  return index
}
