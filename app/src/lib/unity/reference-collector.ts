/**
 * Walks parsed Unity documents collecting the GUIDs they reference across
 * assets. The inspector uses this to resolve object references to repository
 * paths through the Meta index. A fuller forward/reverse reference index is a
 * later phase; here we only need the set of target GUIDs to resolve.
 */

import {
  IUnitySerializedDocument,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'

const collectFromValue = (
  value: UnityPropertyValue,
  into: Set<string>
): void => {
  switch (value.kind) {
    case 'reference':
      if (value.reference.guid !== undefined) {
        into.add(value.reference.guid)
      }
      break
    case 'map':
      for (const entry of value.entries) {
        collectFromValue(entry.value, into)
      }
      break
    case 'sequence':
      for (const item of value.items) {
        collectFromValue(item, into)
      }
      break
    case 'scalar':
      break
  }
}

/** The set of cross-asset GUIDs referenced anywhere in the given documents. */
export const collectReferencedGuids = (
  documents: ReadonlyArray<IUnitySerializedDocument>
): ReadonlySet<string> => {
  const guids = new Set<string>()
  for (const doc of documents) {
    for (const node of doc.properties) {
      collectFromValue(node.value, guids)
    }
  }
  return guids
}
