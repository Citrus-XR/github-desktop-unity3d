/**
 * A hand-written parser for Unity's text-serialized assets (scenes, prefabs,
 * `.asset`, `.mat`, etc.). Unity files are a YAML dialect, but we deliberately
 * do not depend on a general YAML library: Unity emits constructs (the
 * `--- !u!<classId> &<fileId>` document tags, fileIDs beyond 2^53, `stripped`
 * modifiers) that general parsers mishandle or reject, and we need to preserve
 * unknown fields and degrade gracefully on corrupt input rather than throw.
 *
 * The parser is intentionally tolerant: it recovers per-document, records
 * warnings instead of failing the whole file, and keeps raw scalar text so the
 * Inspector can always fall back to showing exactly what was on disk.
 */

import {
  IUnityObjectReference,
  IUnityParseResult,
  IUnitySerializedDocument,
  UnityFileId,
  UnityParseStatus,
  IUnityPropertyNode,
  UnityPropertyValue,
} from '../../models/unity/serialized-asset'
import { getClassName } from '../../models/unity/class-ids'

/** A source line reduced to its indentation depth and trimmed content. */
interface IIndentedLine {
  readonly indent: number
  readonly content: string
}

const lfsPointerPrefix = 'version https://git-lfs.github.com/spec/'

/** Normalize a fileID to its canonical decimal string (sign preserved). */
export const normalizeFileId = (raw: string): UnityFileId => raw.trim()

const isLfsPointer = (text: string): boolean =>
  text.startsWith(lfsPointerPrefix)

const nul = String.fromCharCode(0)

const containsNul = (text: string): boolean => text.indexOf(nul) !== -1

const isSequenceItem = (line: IIndentedLine): boolean =>
  line.content === '-' || line.content.startsWith('- ')

/**
 * Find the index of the colon that separates a mapping key from its value,
 * honoring nested flow `{}`/`[]` and requiring the colon to be followed by
 * whitespace or end-of-line (so `http://` inside a value is not mistaken for a
 * key separator). Returns -1 when the line is not a mapping entry.
 */
const findKeyColon = (content: string): number => {
  let depth = 0
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
    } else if (ch === ':' && depth === 0) {
      const next = content[i + 1]
      if (next === undefined || next === ' ') {
        return i
      }
    }
  }
  return -1
}

/** Split a top-level comma-separated list, honoring nested flow delimiters. */
const splitTopLevel = (text: string): ReadonlyArray<string> => {
  const parts = new Array<string>()
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  const tail = text.slice(start)
  if (tail.trim().length > 0 || parts.length > 0) {
    parts.push(tail)
  }
  return parts
}

/** Decode the escape sequences allowed inside a YAML double-quoted scalar. */
const unescapeDoubleQuoted = (inner: string): string =>
  inner.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc: string) => {
    if (esc[0] === 'u' || esc[0] === 'x') {
      return String.fromCharCode(parseInt(esc.slice(1), 16))
    }
    switch (esc) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case '0':
        return '\0'
      case '\\':
        return '\\'
      case '"':
        return '"'
      case '/':
        return '/'
      default:
        return esc
    }
  })

/** Strip matching surrounding quotes, decoding double-quoted escapes. */
const unquote = (value: string): string => {
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
    // Single-quoted YAML scalars only escape the quote itself, as ''.
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1))
  }
  return value
}

interface IFlowEntry {
  readonly key: string
  readonly rawValue: string
}

/** Parse the body of a flow mapping `{a: b, c: {…}}` (outer braces stripped). */
const parseFlowEntries = (inner: string): ReadonlyArray<IFlowEntry> => {
  const entries = new Array<IFlowEntry>()
  for (const piece of splitTopLevel(inner)) {
    if (piece.trim().length === 0) {
      continue
    }
    const colon = findKeyColon(piece)
    if (colon === -1) {
      continue
    }
    entries.push({
      key: piece.slice(0, colon).trim(),
      rawValue: piece.slice(colon + 1).trim(),
    })
  }
  return entries
}

const buildReference = (
  entries: ReadonlyArray<IFlowEntry>,
  propertyPath: string
): IUnityObjectReference => {
  const find = (key: string) => entries.find(e => e.key === key)?.rawValue
  const fileId = normalizeFileId(find('fileID') ?? '0')
  const guid = find('guid')
  const rawType = find('type')
  const referenceType = rawType === undefined ? undefined : Number(rawType)
  return {
    fileId,
    ...(guid !== undefined ? { guid } : {}),
    ...(referenceType !== undefined && !Number.isNaN(referenceType)
      ? { referenceType }
      : {}),
    propertyPath,
  }
}

/** Parse an inline (single-line) value: scalar, flow map, flow seq, or ref. */
const parseInlineValue = (
  raw: string,
  propertyPath: string
): UnityPropertyValue => {
  const text = raw.trim()

  if (text.startsWith('{')) {
    const end = text.lastIndexOf('}')
    const inner = text.slice(1, end === -1 ? text.length : end)
    const entries = parseFlowEntries(inner)
    if (entries.some(e => e.key === 'fileID')) {
      return {
        kind: 'reference',
        reference: buildReference(entries, propertyPath),
      }
    }
    return {
      kind: 'map',
      entries: entries.map(e => ({
        key: e.key,
        value: parseInlineValue(e.rawValue, `${propertyPath}.${e.key}`),
      })),
    }
  }

  if (text.startsWith('[')) {
    const end = text.lastIndexOf(']')
    const inner = text.slice(1, end === -1 ? text.length : end)
    if (inner.trim().length === 0) {
      return { kind: 'sequence', items: [] }
    }
    return {
      kind: 'sequence',
      items: splitTopLevel(inner).map((piece, index) =>
        parseInlineValue(piece, `${propertyPath}[${index}]`)
      ),
    }
  }

  return { kind: 'scalar', value: unquote(text) }
}

/** Whether the content after a `- ` introduces a mapping item (`key: …`). */
const isMappingItem = (afterDash: string): boolean => {
  const t = afterDash.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) {
    return false
  }
  return findKeyColon(t) !== -1
}

interface IBlockResult<T> {
  readonly value: T
  readonly next: number
}

/**
 * Parse a block mapping: consecutive `key: value` lines at exactly `indent`.
 * Nested mappings, block sequences, and inline values are all handled.
 */
const parseMapping = (
  lines: ReadonlyArray<IIndentedLine>,
  start: number,
  indent: number,
  pathPrefix: string
): IBlockResult<ReadonlyArray<IUnityPropertyNode>> => {
  const nodes = new Array<IUnityPropertyNode>()
  let i = start
  while (
    i < lines.length &&
    lines[i].indent === indent &&
    !isSequenceItem(lines[i])
  ) {
    const line = lines[i]
    const colon = findKeyColon(line.content)
    if (colon === -1) {
      // Not a mapping entry we understand; stop and let the caller recover.
      break
    }
    const key = line.content.slice(0, colon).trim()
    const inlineRest = line.content.slice(colon + 1).trim()
    const path = pathPrefix.length > 0 ? `${pathPrefix}.${key}` : key

    if (inlineRest.length > 0) {
      nodes.push({ key, value: parseInlineValue(inlineRest, path) })
      i++
    } else {
      const nested = parseNestedValue(lines, i + 1, indent, path)
      nodes.push({ key, value: nested.value })
      i = nested.next
    }
  }
  return { value: nodes, next: i }
}

/** Parse the value that follows a key with no inline content. */
const parseNestedValue = (
  lines: ReadonlyArray<IIndentedLine>,
  start: number,
  parentIndent: number,
  path: string
): IBlockResult<UnityPropertyValue> => {
  if (start >= lines.length) {
    return { value: { kind: 'scalar', value: '' }, next: start }
  }
  const next = lines[start]

  if (isSequenceItem(next) && next.indent >= parentIndent) {
    return parseSequence(lines, start, next.indent, path)
  }

  if (next.indent > parentIndent) {
    const mapping = parseMapping(lines, start, next.indent, path)
    return {
      value: { kind: 'map', entries: mapping.value },
      next: mapping.next,
    }
  }

  return { value: { kind: 'scalar', value: '' }, next: start }
}

/** Parse a block sequence: lines beginning with `- ` at exactly `indent`. */
const parseSequence = (
  lines: ReadonlyArray<IIndentedLine>,
  start: number,
  indent: number,
  path: string
): IBlockResult<UnityPropertyValue> => {
  const items = new Array<UnityPropertyValue>()
  let i = start
  let index = 0
  while (
    i < lines.length &&
    lines[i].indent === indent &&
    isSequenceItem(lines[i])
  ) {
    const afterDash = lines[i].content === '-' ? '' : lines[i].content.slice(2)
    const itemPath = `${path}[${index}]`

    if (isMappingItem(afterDash)) {
      const innerIndent = indent + 2
      const colon = findKeyColon(afterDash)
      const key = afterDash.slice(0, colon).trim()
      const inlineRest = afterDash.slice(colon + 1).trim()
      const firstPath = `${itemPath}.${key}`

      let firstValue: UnityPropertyValue
      if (inlineRest.length > 0) {
        firstValue = parseInlineValue(inlineRest, firstPath)
        i++
      } else {
        const nested = parseNestedValue(lines, i + 1, innerIndent, firstPath)
        firstValue = nested.value
        i = nested.next
      }

      const continuation = parseMapping(lines, i, innerIndent, itemPath)
      i = continuation.next
      items.push({
        kind: 'map',
        entries: [{ key, value: firstValue }, ...continuation.value],
      })
    } else {
      items.push(parseInlineValue(afterDash, itemPath))
      i++
    }
    index++
  }
  return { value: { kind: 'sequence', items }, next: i }
}

const stripTrailingColon = (content: string): string =>
  content.endsWith(':') ? content.slice(0, -1).trim() : content.trim()

/** Net flow-collection depth of a line, ignoring delimiters inside quotes. */
const flowDelta = (text: string): number => {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
    }
  }
  return depth
}

/**
 * Reduce raw body text to indented, non-blank, non-comment lines. Unity wraps
 * long flow mappings/sequences across multiple lines (e.g. a `{fileID, guid,
 * type}` reference whose line exceeds the emitter's width); such continuation
 * lines are merged back into a single logical line so the value parser sees a
 * balanced flow collection.
 */
const toIndentedLines = (text: string): ReadonlyArray<IIndentedLine> => {
  const rawLines = text.split(/\r?\n/)
  const result = new Array<IIndentedLine>()
  let i = 0
  while (i < rawLines.length) {
    const raw = rawLines[i]
    if (raw.trim().length === 0) {
      i++
      continue
    }
    const trimmedStart = raw.replace(/^ */, '')
    if (trimmedStart.startsWith('#')) {
      i++
      continue
    }
    const indent = raw.length - trimmedStart.length
    let content = trimmedStart.trimEnd()
    let depth = flowDelta(content)
    while (depth > 0 && i + 1 < rawLines.length) {
      i++
      const next = rawLines[i].trim()
      content += ` ${next}`
      depth += flowDelta(next)
    }
    result.push({ indent, content })
    i++
  }
  return result
}

const headerRegex = /^--- !u!(-?\d+) &(-?\d+)( stripped)?[^\n]*$/gm

/**
 * Parse a Unity text-serialized file into its constituent documents. Returns a
 * status alongside the documents so the caller can offer a plain-text fallback
 * for anything that is not cleanly `parsed`.
 */
export const parseUnityYaml = (text: string): IUnityParseResult => {
  if (isLfsPointer(text)) {
    return { status: 'git-lfs-pointer', documents: [], warnings: [] }
  }
  if (containsNul(text)) {
    return { status: 'unsupported-binary', documents: [], warnings: [] }
  }

  const headers = new Array<{
    classId: number
    fileId: string
    stripped: boolean
    start: number
    headerLineEnd: number
  }>()

  headerRegex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = headerRegex.exec(text)) !== null) {
    const start = match.index
    const headerLineEnd = text.indexOf('\n', start)
    headers.push({
      classId: Number(match[1]),
      fileId: normalizeFileId(match[2]),
      stripped: match[3] !== undefined,
      start,
      headerLineEnd: headerLineEnd === -1 ? text.length : headerLineEnd,
    })
  }

  if (headers.length === 0) {
    return {
      status: 'invalid-yaml',
      documents: [],
      warnings: ['No Unity document headers (--- !u!…) were found'],
    }
  }

  const documents = new Array<IUnitySerializedDocument>()
  const warnings = new Array<string>()

  for (let h = 0; h < headers.length; h++) {
    const header = headers[h]
    const end = h + 1 < headers.length ? headers[h + 1].start : text.length
    const bodyText = text.slice(header.headerLineEnd + 1, end)

    try {
      const lines = toIndentedLines(bodyText)
      let rootKey = ''
      let properties: ReadonlyArray<IUnityPropertyNode> = []

      if (lines.length > 0) {
        rootKey = stripTrailingColon(lines[0].content)
        if (lines.length > 1) {
          properties = parseMapping(lines, 1, lines[1].indent, '').value
        }
      }

      documents.push({
        classId: header.classId,
        fileId: header.fileId,
        typeName: getClassName(header.classId),
        rootKey,
        properties,
        stripped: header.stripped,
        rawTextRange: { start: header.start, end },
      })
    } catch (e) {
      warnings.push(
        `Failed to parse document &${header.fileId} (!u!${header.classId}): ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }

  const status: UnityParseStatus =
    warnings.length > 0 ? 'partially-parsed' : 'parsed'

  return { status, documents, warnings }
}
