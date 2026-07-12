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

/** What kind of document a prefab override targets. */
export type UnityPrefabOverrideTargetKind = 'GameObject' | 'Component'

/**
 * Diff of a single prefab override (one `m_Modifications` entry). Enriched with
 * the source-prefab context (which GameObject / component this override applies
 * to and where in the source hierarchy it lives) so the Inspector can group the
 * flat modification stream the way Unity's own Overrides panel does.
 *
 * The context fields are all optional because a target may sit deep inside a
 * nested-prefab variant we could not fully resolve; the Inspector renders those
 * targets under an "Unresolved" bucket rather than dropping them.
 */
export interface IUnityPrefabOverrideDiff {
  readonly targetFileId: UnityFileId
  /** GUID of the source prefab the target fileID belongs to. */
  readonly targetGuid?: string
  /** Friendly label for the overridden object (filled from the source prefab). */
  readonly targetLabel: string
  readonly propertyPath: string
  readonly status: UnityChangeStatus
  readonly before: UnityPropertyValue | null
  readonly after: UnityPropertyValue | null
  /** Kind of the target document. */
  readonly targetKind?: UnityPrefabOverrideTargetKind
  /**
   * Source-prefab fileID of the GameObject that owns the target (self if the
   * target is a GameObject). Drives grouping in the Inspector.
   */
  readonly targetGameObjectFileId?: UnityFileId
  /**
   * Slash-separated hierarchy path of the owning GameObject within the source
   * prefab (e.g. `Root/Gimmick/SignBoard`).
   */
  readonly targetGameObjectPath?: string
  /** Short display name of the owning GameObject (its last path segment). */
  readonly targetGameObjectName?: string
  /**
   * Component type when `targetKind === 'Component'`. For a MonoBehaviour this
   * is the resolved script file basename; otherwise the class name.
   */
  readonly targetComponentType?: string
  /**
   * The target GameObject's fileID in the CURRENT file's expanded namespace —
   * i.e. the id it takes on inside the merged hierarchy tree. Set when the
   * override could be traced through the enclosing PrefabInstance's expansion
   * (whether via a stripped placeholder or XOR remap). Used by the Inspector
   * to attach each override to the specific node in the main hierarchy it
   * affects, rather than lumping every override onto the instance root.
   */
  readonly expandedTargetGameObjectFileId?: UnityFileId
  /**
   * The target OBJECT'S own fileID in the CURRENT file's expanded namespace —
   * points at the specific GameObject or component the override applies to
   * (whereas `expandedTargetGameObjectFileId` always points at the owning
   * GameObject). Lets the Inspector fold each override into its target
   * component's section rather than piling all of them into a separate top
   * block.
   */
  readonly expandedTargetFileId?: UnityFileId
  /**
   * True when the before/after are scalar numbers that differ only by
   * floating-point re-serialization noise (relative delta below 1e-5). The
   * Inspector groups these with unchanged rows behind the "Show unchanged"
   * toggle so Unity's constant quaternion wobble doesn't drown a real diff.
   */
  readonly trivialFloatDrift?: boolean
  /**
   * True when the expansion pass baked this override into the cloned target
   * document on at least one side. The change is already visible via the
   * per-document property diff, so the Inspector suppresses this override
   * row to avoid duplicating information. Overrides that could not be
   * applied (target/property not resolvable in the expansion) stay `false`
   * and surface under the Inspector's "Unresolved overrides" panel.
   */
  readonly applied?: boolean
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
  /**
   * Per-hierarchy-node origin: each entry maps a GameObject/Transform fileID
   * (in the expanded merged tree's namespace) to the repository path of the
   * source prefab it was materialized from via a nested PrefabInstance. Nodes
   * absent from this list are native to the file being diffed.
   */
  readonly sourcePrefabByExpandedNode?: ReadonlyArray<
    readonly [UnityFileId, string]
  >
  /** Project layer names indexed by layer number (from TagManager.asset). */
  readonly layerNames?: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
}
