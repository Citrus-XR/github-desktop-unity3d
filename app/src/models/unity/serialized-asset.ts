/**
 * Core domain model for Unity's text-serialized assets (scenes, prefabs, and
 * other YAML-style files). These types are produced by the Unity YAML parser
 * and consumed by the hierarchy builder, the semantic diff engine, and the
 * Inspector UI.
 *
 * fileIDs are represented as canonical decimal strings rather than `number` or
 * `bigint`. Unity fileIDs can exceed 2^53 and can be negative, so `number`
 * would silently lose precision. We never do arithmetic on a fileID — only
 * equality matching within a single asset's scope — so a normalized decimal
 * string is sufficient, and it crosses the IPC boundary to the renderer
 * without any bigint serialization concerns.
 */

/** A fileID, normalized to its canonical decimal string form. */
export type UnityFileId = string

/**
 * A reference from one serialized object to another. Internal references carry
 * only a fileID (resolved within the same asset); cross-asset references also
 * carry a GUID (resolved through the Meta index) and Unity's reference `type`.
 */
export interface IUnityObjectReference {
  readonly fileId: UnityFileId
  /** Present for cross-asset references; absent for same-asset references. */
  readonly guid?: string
  /** Unity's reference type discriminator (e.g. 2 = asset, 3 = script). */
  readonly referenceType?: number
  /** Dotted path to the property holding this reference, e.g. `m_Materials[0]`. */
  readonly propertyPath: string
}

/**
 * A parsed property value. Unity properties form a recursive tree of scalars,
 * mappings, sequences, and object references. Unknown shapes are preserved as
 * scalars or maps rather than discarded.
 */
export type UnityPropertyValue =
  | { readonly kind: 'scalar'; readonly value: string }
  | { readonly kind: 'reference'; readonly reference: IUnityObjectReference }
  | {
      readonly kind: 'map'
      readonly entries: ReadonlyArray<IUnityPropertyNode>
    }
  | {
      readonly kind: 'sequence'
      readonly items: ReadonlyArray<UnityPropertyValue>
    }

/** A single keyed property within a mapping. */
export interface IUnityPropertyNode {
  readonly key: string
  readonly value: UnityPropertyValue
}

/**
 * One document within a Unity text-serialized file, introduced by a header of
 * the form `--- !u!<classId> &<fileId>` optionally followed by ` stripped`.
 */
export interface IUnitySerializedDocument {
  readonly classId: number
  readonly fileId: UnityFileId
  /** Friendly type name for the class ID, when known (e.g. `GameObject`). */
  readonly typeName?: string
  /** The single top-level mapping key, e.g. `GameObject` or `MonoBehaviour`. */
  readonly rootKey: string
  readonly properties: ReadonlyArray<IUnityPropertyNode>
  /** True when the header carried the ` stripped` modifier (prefab instance). */
  readonly stripped: boolean
  /**
   * True for a synthetic node standing in for an imported model's object (an
   * FBX/etc. part whose real hierarchy lives in the binary file). Drives the
   * "model" badge so these reconstructed dummy nodes are visibly distinguished.
   */
  readonly isModelDummy?: boolean
  /** Byte/character offsets of this document within the source text. */
  readonly rawTextRange: {
    readonly start: number
    readonly end: number
  }
}

/** Parse outcome for a single Unity file. Every non-`parsed` status must */
/** still offer a plain-text diff or file-info fallback in the UI. */
export type UnityParseStatus =
  | 'parsed'
  | 'partially-parsed'
  | 'unsupported-binary'
  | 'git-lfs-pointer'
  | 'invalid-yaml'
  | 'too-large'
  | 'cancelled'

/** Result of parsing one side of a Unity file. */
export interface IUnityParseResult {
  readonly status: UnityParseStatus
  readonly documents: ReadonlyArray<IUnitySerializedDocument>
  /** Non-fatal problems encountered while parsing (kept for partial parses). */
  readonly warnings: ReadonlyArray<string>
}

/**
 * A `.meta` sidecar record linking a GUID to the asset it describes. The Meta
 * index is the base source of truth for GUID resolution — never the Library.
 */
export interface IUnityAssetRecord {
  readonly guid: string
  /** Repository-relative path of the asset (the `.meta` path without `.meta`). */
  readonly path: string
  /** Repository-relative path of the `.meta` file itself. */
  readonly metaPath: string
  readonly importerType?: string
  readonly fileHash?: string
  readonly metaHash?: string
}

/** A component attached to a GameObject in a rebuilt hierarchy. */
export interface IUnityComponentNode {
  readonly fileId: UnityFileId
  readonly classId: number
  readonly typeName: string
  readonly enabled?: boolean
  readonly properties: ReadonlyArray<IUnityPropertyNode>
}

/** A GameObject node in a rebuilt scene/prefab hierarchy. */
export interface IUnityGameObjectNode {
  readonly fileId: UnityFileId
  readonly name: string
  readonly active?: boolean
  readonly layer?: number
  readonly tag?: string
  readonly parentFileId?: UnityFileId
  /** True when reconstructed from an imported model's name table (dummy node). */
  readonly isModel?: boolean
  readonly children: ReadonlyArray<IUnityGameObjectNode>
  readonly components: ReadonlyArray<IUnityComponentNode>
}
