import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  parseFbxHierarchy,
  uniqueNameIndex,
} from '../../../src/lib/unity/fbx-hierarchy'

// Minimal but structurally-real FBX ASCII fixture: an Armature Null with a
// three-bone chain and a sibling Mesh. Every element is what a real Blender or
// Maya export would produce — Model nodes carry `Model::<name>` in the second
// property and Connections use `OO` with (child, parent) uids. Blank sections
// (Definitions/Takes) are omitted; the parser only cares about Objects and
// Connections.
const asciiFbx = [
  '; FBX 7.4.0 project file',
  'FBXHeaderExtension:  {',
  '  FBXVersion: 7400',
  '}',
  'Objects:  {',
  '  Model: 4001, "Model::Armature", "Null" {',
  '    Version: 232',
  '  }',
  '  Model: 4002, "Model::Hips", "LimbNode" {',
  '    Version: 232',
  '  }',
  '  Model: 4003, "Model::Spine", "LimbNode" {',
  '    Version: 232',
  '  }',
  '  Model: 4004, "Model::Chest", "LimbNode" {',
  '    Version: 232',
  '  }',
  '  Model: 4005, "Model::Body", "Mesh" {',
  '    Version: 232',
  '  }',
  '  Geometry: 5001, "Geometry::Body", "Mesh" {',
  '    GeometryVersion: 124',
  '  }',
  '  Material: 6001, "Material::Skin", "" {',
  '    Version: 102',
  '  }',
  '}',
  'Connections:  {',
  '  ;Model::Armature, Model::RootNode',
  '  C: "OO",4001,0',
  '  ;Model::Body, Model::RootNode',
  '  C: "OO",4005,0',
  '  ;Model::Hips, Model::Armature',
  '  C: "OO",4002,4001',
  '  ;Model::Spine, Model::Hips',
  '  C: "OO",4003,4002',
  '  ;Model::Chest, Model::Spine',
  '  C: "OO",4004,4003',
  '  ;Geometry::Body, Model::Body',
  '  C: "OO",5001,4005',
  '  ;Material::Skin, Model::Body',
  '  C: "OO",6001,4005',
  '}',
].join('\n')

const asciiFbxBytes = new TextEncoder().encode(asciiFbx)

describe('parseFbxHierarchy', () => {
  it('extracts every Model node with uid, name, and kind', () => {
    const hierarchy = parseFbxHierarchy(asciiFbxBytes)
    assert.equal(
      hierarchy.nodes.size,
      5,
      'exactly five Model nodes should be recognized (geometries / materials are skipped)'
    )

    const armature = hierarchy.nodes.get('4001')
    assert.ok(armature, 'Armature Model must be present')
    assert.equal(armature.name, 'Armature', 'Model:: prefix must be stripped')
    assert.equal(armature.kind, 'Null')

    const hips = hierarchy.nodes.get('4002')
    assert.ok(hips)
    assert.equal(hips.kind, 'LimbNode')
  })

  it('rebuilds parent links from OO connections', () => {
    const hierarchy = parseFbxHierarchy(asciiFbxBytes)
    assert.equal(hierarchy.nodes.get('4001')?.parentUid, null)
    assert.equal(hierarchy.nodes.get('4005')?.parentUid, null)
    assert.equal(hierarchy.nodes.get('4002')?.parentUid, '4001')
    assert.equal(hierarchy.nodes.get('4003')?.parentUid, '4002')
    assert.equal(hierarchy.nodes.get('4004')?.parentUid, '4003')
  })

  it('collects children in connection order', () => {
    const hierarchy = parseFbxHierarchy(asciiFbxBytes)
    assert.deepEqual(hierarchy.nodes.get('4001')?.childUids, ['4002'])
    assert.deepEqual(hierarchy.nodes.get('4002')?.childUids, ['4003'])
    // The Body mesh has geometry/material connections but no *Model* children.
    assert.deepEqual(hierarchy.nodes.get('4005')?.childUids, [])
  })

  it('lists the Models parented to the implicit FBX RootNode', () => {
    const hierarchy = parseFbxHierarchy(asciiFbxBytes)
    assert.deepEqual([...hierarchy.rootUids].sort(), ['4001', '4005'])
  })

  it('rejects a file that has no Objects section', () => {
    const junk = new TextEncoder().encode(
      ['Definitions:  {', '  Count: 0', '}'].join('\n')
    )
    assert.throws(() => parseFbxHierarchy(junk), /Objects/)
  })

  it('parses a file with no Connections as a forest of roots', () => {
    const noConn = new TextEncoder().encode(
      [
        'Objects:  {',
        '  Model: 7001, "Model::Alpha", "Null" { Version: 232 }',
        '  Model: 7002, "Model::Beta", "Null" { Version: 232 }',
        '}',
      ].join('\n')
    )
    const hierarchy = parseFbxHierarchy(noConn)
    assert.equal(hierarchy.nodes.size, 2)
    assert.deepEqual([...hierarchy.rootUids].sort(), ['7001', '7002'])
  })

  it('ignores OP (object-to-property) connections when building parent links', () => {
    // An OP connection binds a Model's value into someone else's Properties70.
    // It must not be treated as a parent link — otherwise the Chest bone below
    // would incorrectly reparent under Spine's rotation property.
    const withOP = [
      'Objects:  {',
      '  Model: 8001, "Model::Root", "Null" { Version: 232 }',
      '  Model: 8002, "Model::Child", "LimbNode" { Version: 232 }',
      '}',
      'Connections:  {',
      '  C: "OO",8001,0',
      '  C: "OP",8002,8001,"Lcl Rotation"',
      '}',
    ].join('\n')
    const hierarchy = parseFbxHierarchy(new TextEncoder().encode(withOP))
    // 8002 has no OO parent, so it stays a root.
    assert.equal(hierarchy.nodes.get('8002')?.parentUid, null)
    assert.ok(hierarchy.rootUids.includes('8002'))
  })

  it('detects binary FBX by magic bytes even without a real payload', () => {
    // Truncated binary — the router must dispatch to parseBinary (not fall
    // through to the ASCII path), which then rejects the incomplete file.
    const truncatedBinary = new Uint8Array([
      ...new TextEncoder().encode('Kaydara FBX Binary  '),
      0x00,
      0x1a,
      0x00,
      // FBX version 7400 as little-endian uint32, then abrupt EOF.
      0xe8,
      0x1c,
      0x00,
      0x00,
    ])
    assert.throws(() => parseFbxHierarchy(truncatedBinary))
  })

  it('parses a hand-encoded binary FBX end-to-end', () => {
    // Real Unity assets ship as binary FBX, not ASCII, so we build the exact
    // wire format here rather than trusting only the ASCII path. The encoder
    // targets version 7400 (uint32 offsets — the widest-compatible flavor);
    // fbx-parser switches to 64-bit offsets automatically at 7500+.
    const bytes = encodeBinaryFbx({
      version: 7400,
      objects: [
        { uid: 4001, name: 'Armature', kind: 'Null' },
        { uid: 4002, name: 'Hips', kind: 'LimbNode' },
        { uid: 4003, name: 'Spine', kind: 'LimbNode' },
      ],
      connections: [
        { child: 4001, parent: 0 },
        { child: 4002, parent: 4001 },
        { child: 4003, parent: 4002 },
      ],
    })
    const hierarchy = parseFbxHierarchy(bytes)
    assert.equal(hierarchy.nodes.size, 3)
    assert.equal(hierarchy.nodes.get('4001')?.name, 'Armature')
    assert.equal(hierarchy.nodes.get('4001')?.kind, 'Null')
    assert.equal(hierarchy.nodes.get('4001')?.parentUid, null)
    assert.equal(hierarchy.nodes.get('4002')?.parentUid, '4001')
    assert.equal(hierarchy.nodes.get('4003')?.parentUid, '4002')
    assert.deepEqual(hierarchy.rootUids, ['4001'])
  })
})

describe('uniqueNameIndex', () => {
  it('indexes names that appear exactly once', () => {
    const hierarchy = parseFbxHierarchy(asciiFbxBytes)
    const index = uniqueNameIndex(hierarchy)
    assert.equal(index.get('Armature'), '4001')
    assert.equal(index.get('Hips'), '4002')
    assert.equal(index.get('Body'), '4005')
    assert.equal(index.size, 5)
  })

  it('drops names that appear more than once', () => {
    // Two Wrist bones with the same leaf name — the classic mirrored-skeleton
    // pattern. Neither should be resolvable by unqualified name.
    const dup = [
      'Objects:  {',
      '  Model: 9001, "Model::Wrist", "LimbNode" { Version: 232 }',
      '  Model: 9002, "Model::Wrist", "LimbNode" { Version: 232 }',
      '  Model: 9003, "Model::Head", "LimbNode" { Version: 232 }',
      '}',
    ].join('\n')
    const hierarchy = parseFbxHierarchy(new TextEncoder().encode(dup))
    const index = uniqueNameIndex(hierarchy)
    assert.equal(index.get('Wrist'), undefined)
    assert.equal(index.get('Head'), '9003')
  })
})

// --- Binary FBX encoder --------------------------------------------------
// A hand-rolled writer for the subset of the FBX binary format we care about
// (Model nodes, Connections, uint32-offset header — versions 7100..7499). It
// matches the exact bytes fbx-parser (mrdoob's FBXLoader ported) reads back;
// verified by the round-trip test above rather than by matching to any spec
// prose.

interface IBinaryFbxSpec {
  readonly version: number
  readonly objects: ReadonlyArray<{
    readonly uid: number
    readonly name: string
    readonly kind: string
  }>
  readonly connections: ReadonlyArray<{
    readonly child: number
    readonly parent: number
  }>
}

const encodeBinaryFbx = (spec: IBinaryFbxSpec): Uint8Array => {
  const chunks: Uint8Array[] = []
  const push = (b: Uint8Array) => chunks.push(b)

  const magic = new Uint8Array(23)
  const magicText = 'Kaydara FBX Binary  '
  for (let i = 0; i < magicText.length; i++) {
    magic[i] = magicText.charCodeAt(i)
  }
  magic[20] = 0x00
  magic[21] = 0x1a
  magic[22] = 0x00
  push(magic)
  push(u32(spec.version))

  const objectsNode: INodeSpec = {
    name: 'Objects',
    props: [],
    children: spec.objects.map(o => ({
      name: 'Model',
      props: [pL(o.uid), pS(`Model::${o.name}`), pS(o.kind)],
      children: [],
    })),
  }
  const connectionsNode: INodeSpec = {
    name: 'Connections',
    props: [],
    children: spec.connections.map(c => ({
      name: 'C',
      props: [pS('OO'), pL(c.child), pL(c.parent)],
      children: [],
    })),
  }

  let offset = 23 + 4
  const objectsBytes = encodeNode(objectsNode, offset)
  offset += objectsBytes.length
  const connectionsBytes = encodeNode(connectionsNode, offset)
  offset += connectionsBytes.length
  push(objectsBytes)
  push(connectionsBytes)

  // Root list terminator: 13 zero bytes (three uint32s + one uint8 nameLen).
  push(new Uint8Array(13))

  return concat(chunks)
}

interface IPropSpec {
  readonly bytes: Uint8Array
}
interface INodeSpec {
  readonly name: string
  readonly props: ReadonlyArray<IPropSpec>
  readonly children: ReadonlyArray<INodeSpec>
}

const pL = (value: number): IPropSpec => {
  const buf = new Uint8Array(9)
  buf[0] = 'L'.charCodeAt(0)
  const view = new DataView(buf.buffer)
  // JS BigInt is required for setBigInt64.
  view.setBigInt64(1, BigInt(value), true)
  return { bytes: buf }
}

const pS = (value: string): IPropSpec => {
  const encoded = new TextEncoder().encode(value)
  const buf = new Uint8Array(1 + 4 + encoded.length)
  buf[0] = 'S'.charCodeAt(0)
  new DataView(buf.buffer).setUint32(1, encoded.length, true)
  buf.set(encoded, 5)
  return { bytes: buf }
}

const u32 = (value: number): Uint8Array => {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, value, true)
  return buf
}

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const c of chunks) {
    out.set(c, cursor)
    cursor += c.length
  }
  return out
}

const encodeNode = (node: INodeSpec, startOffset: number): Uint8Array => {
  const nameBytes = new TextEncoder().encode(node.name)
  const propsBytes = concat(node.props.map(p => p.bytes))
  const headerLen = 4 + 4 + 4 + 1 + nameBytes.length
  let bodyLen = propsBytes.length
  const childBlocks: Uint8Array[] = []
  if (node.children.length > 0) {
    let childOffset = startOffset + headerLen + propsBytes.length
    for (const child of node.children) {
      const encoded = encodeNode(child, childOffset)
      childBlocks.push(encoded)
      childOffset += encoded.length
    }
    // Trailing 13-byte NULL record signals end of child list. Without it
    // parseBinary's `endOffset - data.offset > 13` loop would consume it.
    bodyLen += childBlocks.reduce((n, b) => n + b.length, 0) + 13
  }
  const totalLen = headerLen + bodyLen
  const endOffset = startOffset + totalLen

  const buf = new Uint8Array(totalLen)
  const view = new DataView(buf.buffer)
  view.setUint32(0, endOffset, true)
  view.setUint32(4, node.props.length, true)
  view.setUint32(8, propsBytes.length, true)
  buf[12] = nameBytes.length
  buf.set(nameBytes, 13)
  buf.set(propsBytes, 13 + nameBytes.length)
  let cursor = 13 + nameBytes.length + propsBytes.length
  for (const cb of childBlocks) {
    buf.set(cb, cursor)
    cursor += cb.length
  }
  // Remaining `bodyLen - written` bytes are already zero — that is the
  // trailing null record when children are present.
  return buf
}
