import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  computeFbxFileId,
  synthesizeModelObjects,
} from '../../../src/lib/unity/fbx-fileid-hash'
import { IFbxHierarchy, IFbxNode } from '../../../src/lib/unity/fbx-hierarchy'

// Build an in-memory FBX hierarchy without going through the parser. Every
// test that needs a specific tree passes its edges here rather than embedding
// FBX ASCII, keeping the hash algorithm tests focused on the hash itself.
const makeHierarchy = (
  spec: ReadonlyArray<{
    uid: string
    name: string
    kind: string
    parent: string | null
  }>
): IFbxHierarchy => {
  const nodesById = new Map<string, IFbxNode & { childUids: string[] }>()
  for (const entry of spec) {
    nodesById.set(entry.uid, {
      uid: entry.uid,
      name: entry.name,
      kind: entry.kind,
      parentUid: entry.parent,
      childUids: [],
    })
  }
  for (const entry of spec) {
    if (entry.parent !== null) {
      const parent = nodesById.get(entry.parent)
      if (parent === undefined) {
        throw new Error(`unknown parent uid: ${entry.parent}`)
      }
      parent.childUids.push(entry.uid)
    }
  }
  const rootUids = spec.filter(s => s.parent === null).map(s => s.uid)
  return {
    nodes: nodesById as unknown as ReadonlyMap<string, IFbxNode>,
    rootUids,
  }
}

describe('computeFbxFileId', () => {
  it('matches a Unity 2022 fileID for the model root', () => {
    // Verified against mouse_booth.fbx / mouse_booth.prefab in the
    // Vket2026Summer_Akihabara repo: the root GameObject that the prefab
    // renames to "mouse_booth" via an m_Name override sits at fileID
    // 919132149155446097, which xxHash64 produces from the standard
    // `Type:GameObject->//RootNode/root0` key.
    const dupe = new Map<string, number>()
    assert.strictEqual(
      computeFbxFileId('GameObject', '//RootNode/root', dupe),
      '919132149155446097'
    )
  })

  it('matches a Unity 2022 fileID for a nested Transform', () => {
    const dupe = new Map<string, number>()
    assert.strictEqual(
      computeFbxFileId(
        'Transform',
        '//RootNode/root/tube/pCylinder12/Transform',
        dupe
      ),
      '3070783425072336940'
    )
  })

  it('matches a Unity 2022 fileID for a deeply nested MeshRenderer', () => {
    const dupe = new Map<string, number>()
    assert.strictEqual(
      computeFbxFileId(
        'MeshRenderer',
        '//RootNode/root/base/kabe/polySurface1/polySurface2/polySurface4/MeshRenderer',
        dupe
      ),
      '621800244512565233'
    )
  })

  it('increments the counter for same-key duplicates', () => {
    const dupe = new Map<string, number>()
    const first = computeFbxFileId('GameObject', '//RootNode/root/twin', dupe)
    const second = computeFbxFileId('GameObject', '//RootNode/root/twin', dupe)
    assert.notStrictEqual(first, second)
    assert.strictEqual(dupe.get('Type:GameObject->//RootNode/root/twin'), 1)
  })

  it('reinterprets the unsigned hash as signed int64', () => {
    // The synthetic root Transform's key xxHash64s to a value above 2^63, so
    // the signed reinterpretation must produce a negative decimal.
    const dupe = new Map<string, number>()
    const id = computeFbxFileId(
      'Transform',
      '//RootNode/root/Transform',
      dupe
    )
    assert.ok(id.startsWith('-'), `expected negative signed int64, got ${id}`)
    assert.strictEqual(id, '-8679921383154817045')
  })
})

describe('synthesizeModelObjects', () => {
  it('emits a GameObject + Transform for the synthetic root', () => {
    const hierarchy = makeHierarchy([
      { uid: 'a', name: 'topA', kind: 'Null', parent: null },
      { uid: 'b', name: 'topB', kind: 'Null', parent: null },
    ])
    const objects = synthesizeModelObjects(hierarchy)
    const rootGo = objects.find(
      o => o.fbxUid === null && o.className === 'GameObject'
    )
    const rootTransform = objects.find(
      o => o.fbxUid === null && o.className === 'Transform'
    )
    assert.strictEqual(rootGo?.fileId, '919132149155446097')
    assert.strictEqual(rootTransform?.fileId, '-8679921383154817045')
  })

  it('walks the FBX tree and emits Mesh components for Mesh kinds', () => {
    // Reconstructs the "tube" subtree of mouse_booth.fbx: a Null container
    // named "tube" holding six Mesh children. Verifies both the parent
    // (tube's Transform) and one child (pCylinder12's MeshRenderer) against
    // the fileIDs Unity actually produced.
    const hierarchy = makeHierarchy([
      { uid: 'tube', name: 'tube', kind: 'Null', parent: null },
      { uid: 'p12', name: 'pCylinder12', kind: 'Mesh', parent: 'tube' },
      { uid: 'p11', name: 'pCylinder11', kind: 'Mesh', parent: 'tube' },
      { uid: 'p9', name: 'pCylinder9', kind: 'Mesh', parent: 'tube' },
      { uid: 'p7', name: 'pCylinder7', kind: 'Mesh', parent: 'tube' },
      { uid: 'p10', name: 'pCylinder10', kind: 'Mesh', parent: 'tube' },
      { uid: 'p8', name: 'pCylinder8', kind: 'Mesh', parent: 'tube' },
      // Add sibling top-levels so the fold-root path doesn't activate.
      { uid: 'other1', name: 'hachimaki', kind: 'Null', parent: null },
      { uid: 'other2', name: 'base', kind: 'Null', parent: null },
    ])
    const objects = synthesizeModelObjects(hierarchy)
    const byId = new Map(objects.map(o => [o.fbxUid + '|' + o.className, o]))
    assert.strictEqual(
      byId.get('tube|Transform')?.fileId,
      '-347287514121497074'
    )
    assert.strictEqual(
      byId.get('p12|Transform')?.fileId,
      '3070783425072336940'
    )
    assert.strictEqual(
      byId.get('p12|MeshRenderer')?.fileId,
      '-7834930373403656032'
    )
    // Null containers get only a Transform, no renderer components.
    assert.strictEqual(byId.get('tube|MeshFilter'), undefined)
    assert.strictEqual(byId.get('tube|MeshRenderer'), undefined)
    // Mesh kinds also get MeshFilter alongside MeshRenderer.
    assert.ok(byId.get('p12|MeshFilter') !== undefined)
  })

  it('elides the sole top-level Model in the root-fold case', () => {
    // A single top-level FBX Model triggers Unity's root-transform fold: the
    // Model is absorbed into the synthetic root, and its own hierarchy path
    // segment is dropped. Its children then hash under //RootNode/root/... —
    // the same paths a no-fold tree would produce, minus one level.
    const folded = makeHierarchy([
      { uid: 'top', name: 'onlyRoot', kind: 'Null', parent: null },
      { uid: 'child', name: 'pCylinder12', kind: 'Mesh', parent: 'top' },
    ])
    const objects = synthesizeModelObjects(folded)
    // In the fold case the sole top-level does NOT get its own GameObject —
    // it is the synthetic root.
    assert.strictEqual(
      objects.filter(o => o.fbxUid === 'top').length,
      0,
      'folded top-level should not produce its own objects'
    )
    // Its child sits at //RootNode/root/pCylinder12 (no `onlyRoot/` in the
    // path), matching the same hash pattern a top-level child would get.
    const childTransform = objects.find(
      o => o.fbxUid === 'child' && o.className === 'Transform'
    )
    // With fold, "pCylinder12" is a direct child of //RootNode/root. Its
    // Transform key is Type:Transform->//RootNode/root/pCylinder12/Transform0.
    const expectDupe = new Map<string, number>()
    const expected = computeFbxFileId(
      'Transform',
      '//RootNode/root/pCylinder12/Transform',
      expectDupe
    )
    assert.strictEqual(childTransform?.fileId, expected)
  })

  it('parents synthesized components at the correct FBX ancestor', () => {
    const hierarchy = makeHierarchy([
      { uid: 't1', name: 'top1', kind: 'Null', parent: null },
      { uid: 't2', name: 'top2', kind: 'Null', parent: null },
      { uid: 'child', name: 'leaf', kind: 'Mesh', parent: 't1' },
    ])
    const objects = synthesizeModelObjects(hierarchy)
    const leaf = objects.find(o => o.fbxUid === 'child')
    assert.strictEqual(leaf?.parentFbxUid, 't1')
    const t1 = objects.find(
      o => o.fbxUid === 't1' && o.className === 'GameObject'
    )
    assert.strictEqual(t1?.parentFbxUid, null)
  })
})
