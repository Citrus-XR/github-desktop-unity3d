/**
 * The Meta index maps Unity asset GUIDs to repository paths and back. `.meta`
 * sidecar files are the base source of truth for GUID resolution — never the
 * Library. The index is built per Git tree side (HEAD vs working tree) from a
 * supplied set of `.meta` files, so it can represent exactly what a given
 * commit knew without leaking the working tree's view into historical lookups.
 */

import { IUnityAssetRecord } from '../../models/unity/serialized-asset'

const guidRegex = /^guid:\s*([0-9a-fA-F]+)\s*$/m
const importerRegex = /^(\w+Importer):\s*$/m

/** A `.meta` file's path paired with its raw contents. */
export interface IMetaFile {
  /** Repository-relative path of the `.meta` file. */
  readonly metaPath: string
  readonly content: string
  readonly metaHash?: string
}

/** The repo-relative asset path a `.meta` file describes (drops `.meta`). */
export const assetPathFromMetaPath = (metaPath: string): string =>
  metaPath.endsWith('.meta') ? metaPath.slice(0, -'.meta'.length) : metaPath

/** Extract the GUID and importer type from `.meta` file contents. */
export const parseMetaContent = (
  content: string
): { guid: string; importerType?: string } | null => {
  const guidMatch = guidRegex.exec(content)
  if (guidMatch === null) {
    return null
  }
  const importerMatch = importerRegex.exec(content)
  return {
    guid: guidMatch[1],
    ...(importerMatch !== null ? { importerType: importerMatch[1] } : {}),
  }
}

/**
 * A bidirectional GUID/path index for one side of a diff. Paths are stored as
 * Git records them (case-sensitive), with a secondary lower-cased index so a
 * case-insensitive filesystem (Windows, macOS) can still resolve a lookup that
 * differs only in case.
 */
export class MetaIndex {
  private readonly byGuid = new Map<string, IUnityAssetRecord>()
  private readonly byPath = new Map<string, IUnityAssetRecord>()
  private readonly byLowerPath = new Map<string, IUnityAssetRecord>()

  public add(metaFile: IMetaFile): void {
    const parsed = parseMetaContent(metaFile.content)
    if (parsed === null) {
      return
    }
    const path = assetPathFromMetaPath(metaFile.metaPath)
    const record: IUnityAssetRecord = {
      guid: parsed.guid,
      path,
      metaPath: metaFile.metaPath,
      ...(parsed.importerType !== undefined
        ? { importerType: parsed.importerType }
        : {}),
      ...(metaFile.metaHash !== undefined ? { metaHash: metaFile.metaHash } : {}),
    }
    this.byGuid.set(record.guid, record)
    this.byPath.set(path, record)
    this.byLowerPath.set(path.toLowerCase(), record)
  }

  public getByGuid(guid: string): IUnityAssetRecord | undefined {
    return this.byGuid.get(guid)
  }

  /** Resolve a GUID to its asset path, or undefined if not in this index. */
  public pathForGuid(guid: string): string | undefined {
    return this.byGuid.get(guid)?.path
  }

  /** A plain GUID→path map, e.g. to hand to a worker that resolves sources. */
  public toPathByGuid(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [guid, record] of this.byGuid) {
      out.set(guid, record.path)
    }
    return out
  }

  /** Look up by exact path, falling back to a case-insensitive match. */
  public getByPath(path: string): IUnityAssetRecord | undefined {
    return this.byPath.get(path) ?? this.byLowerPath.get(path.toLowerCase())
  }

  public get size(): number {
    return this.byGuid.size
  }
}

/** Build a Meta index from a set of `.meta` files (one diff side). */
export const buildMetaIndex = (
  metaFiles: ReadonlyArray<IMetaFile>
): MetaIndex => {
  const index = new MetaIndex()
  for (const metaFile of metaFiles) {
    index.add(metaFile)
  }
  return index
}
