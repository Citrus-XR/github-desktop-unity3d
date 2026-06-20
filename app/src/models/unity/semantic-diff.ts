/**
 * Data model for the two-sided Unity semantic diff. The engine compares the
 * `before` and `after` parses of a single asset and produces this structure:
 * a merged GameObject tree carrying per-node change status, and per-document
 * property diffs the Inspector renders with add/remove/modify colors.
 *
 * Everything is plain JSON (fileIDs are decimal strings) so it crosses the IPC
 * boundary unchanged.
 */

import { UnityFileId, UnityPropertyValue } from './serialized-asset'

export type UnityChangeStatus = 'added' | 'removed' | 'modified' | 'unchanged'

/**
 * Request to diff one Unity asset across two Git refs. A `null` ref means the
 * working tree. For a working-directory change this is `before: 'HEAD'`,
 * `after: null`; for a commit it is the parent and the commit.
 */
export interface IUnitySemanticDiffRequest {
  readonly repositoryPath: string
  readonly filePath: string
  readonly beforeRef: string | null
  readonly afterRef: string | null
  /** Parse even when a side exceeds the default size limit. */
  readonly force?: boolean
}

/** Diff of a single property between the two sides. */
export interface IUnityPropertyDiff {
  readonly key: string
  readonly status: UnityChangeStatus
  /** Value on the before side, or null when the property was added. */
  readonly before: UnityPropertyValue | null
  /** Value on the after side, or null when the property was removed. */
  readonly after: UnityPropertyValue | null
}

/** Diff of one serialized document (a GameObject, a component, an asset). */
export interface IUnityDocumentDiff {
  readonly fileId: UnityFileId
  readonly classId: number
  readonly typeName: string
  readonly status: UnityChangeStatus
  readonly properties: ReadonlyArray<IUnityPropertyDiff>
}

/** A component reference within a GameObject diff node, with its status. */
export interface IUnityComponentDiffRef {
  readonly fileId: UnityFileId
  readonly typeName: string
  readonly status: UnityChangeStatus
}

/** A GameObject in the merged before/after hierarchy, with change status. */
export interface IUnityGameObjectDiffNode {
  readonly fileId: UnityFileId
  readonly name: string
  readonly status: UnityChangeStatus
  /** True for a node reconstructed from an imported model's name table. */
  readonly isModel?: boolean
  readonly components: ReadonlyArray<IUnityComponentDiffRef>
  readonly children: ReadonlyArray<IUnityGameObjectDiffNode>
}

/** Diff of a single prefab override (one `m_Modifications` entry). */
export interface IUnityPrefabOverrideDiff {
  readonly targetFileId: UnityFileId
  /** Friendly label for the overridden object (filled from the source prefab). */
  readonly targetLabel: string
  readonly propertyPath: string
  readonly status: UnityChangeStatus
  readonly before: string | null
  readonly after: string | null
}

/** Diff of a prefab instance (a `!u!1001 PrefabInstance` document). */
export interface IUnityPrefabInstanceDiff {
  readonly fileId: UnityFileId
  /** The hierarchy node (expanded instance root) this diff belongs to, if any. */
  readonly nodeFileId?: UnityFileId
  readonly status: UnityChangeStatus
  /** Display name of the instance (m_Name override or source prefab name). */
  readonly name: string
  readonly sourcePrefabGuid?: string
  /** Repository path of the source prefab, resolved through the Meta index. */
  readonly sourcePrefabPath?: string
  readonly overrides: ReadonlyArray<IUnityPrefabOverrideDiff>
}

/** A resolved cross-asset GUID → repository path entry. */
export interface IUnityResolvedGuid {
  readonly guid: string
  readonly path: string
}

export interface IUnitySemanticDiffResult {
  readonly status:
    | 'parsed'
    | 'partially-parsed'
    | 'unsupported-binary'
    | 'git-lfs-pointer'
    | 'invalid-yaml'
    | 'too-large'
    | 'cancelled'
  /** Merged GameObject forest (empty for assets without a hierarchy). */
  readonly roots: ReadonlyArray<IUnityGameObjectDiffNode>
  /** Per-document property diffs, keyed by fileId via the array entries. */
  readonly documents: ReadonlyArray<IUnityDocumentDiff>
  /** Per prefab-instance override diffs (the `!u!1001` documents). */
  readonly prefabInstances: ReadonlyArray<IUnityPrefabInstanceDiff>
  readonly resolvedGuids: ReadonlyArray<IUnityResolvedGuid>
  /** Project layer names indexed by layer number (from TagManager.asset). */
  readonly layerNames?: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
}
