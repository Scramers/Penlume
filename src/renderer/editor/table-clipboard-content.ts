import type { Ctx } from '@milkdown/kit/ctx'
import { schemaCtx } from '@milkdown/kit/core'
import { DOMSerializer, Fragment, type DOMOutputSpec, type Node, type Schema, type TagParseRule } from '@milkdown/kit/prose/model'
import { tableCellSchema, tableHeaderSchema } from '@milkdown/kit/preset/gfm'
import type { NodeSchema } from '@milkdown/kit/transformer'
import { TABLE_CLIPBOARD_LIMITS, type TableClipboardLimits } from './table-clipboard'

export const TABLE_CLIPBOARD_CONTENT_ATTRIBUTE = 'data-ttypora-cell-content'
const VERSION = 1
const MAX_INLINE_NODES = 4096
const INLINE_NODES = new Set(['text', 'hardbreak', 'math_inline'])
const MARKS = new Set(['strong', 'emphasis', 'strike_through', 'inlineCode', 'link', 'highlight', 'superscript', 'subscript', 'underline'])
export type TableClipboardContentStatus = { ok: true } | { ok: false; reason: 'size-limit' | 'unsupported-content' }
export interface TableClipboardContentSerializer extends DOMSerializer { readonly contentStatus: TableClipboardContentStatus }
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const onlyKeys = (value: RecordValue, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))
const validLimits = (limits: TableClipboardLimits) => [limits.rows, limits.columns, limits.cells, limits.characters].every((value) => Number.isSafeInteger(value) && value > 0)

function validAttrs(value: unknown, definitions: NodeSchema['attrs']): boolean {
  return value === undefined || record(value) && Object.entries(value).every(([key, attribute]) =>
    Object.hasOwn(definitions ?? {}, key) && (attribute === null || typeof attribute === 'string' || typeof attribute === 'boolean' || typeof attribute === 'number' && Number.isFinite(attribute)))
}

// Match the native link DOM sink's scheme policy. A forged marker must not
// recreate an unsafe href which the native serializer already neutralized.
function safeLink(href: unknown): boolean {
  if (typeof href !== 'string') return false
  const normalized = href.trim().replace(/[\u0000-\u0020\u007f-\u00a0\u200b-\u200d\u2028\u2029\ufeff]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]?.toLowerCase()
  return !scheme || ['http', 'https', 'mailto', 'tel', 'ftp'].includes(scheme)
}

/** A marker is untrusted data, not a capability to instantiate arbitrary schema nodes. */
export function tableClipboardContentFragment(marker: string | null, schema: Schema, limits: TableClipboardLimits = TABLE_CLIPBOARD_LIMITS): Fragment | null {
  if (!marker || !validLimits(limits) || marker.length > limits.characters) return null
  try {
    const envelope: unknown = JSON.parse(marker)
    if (!record(envelope) || !onlyKeys(envelope, ['version', 'content']) || envelope.version !== VERSION || !Array.isArray(envelope.content) || envelope.content.length !== 1) return null
    const paragraph: unknown = envelope.content[0]
    if (!record(paragraph) || !onlyKeys(paragraph, ['type', 'attrs', 'content']) || paragraph.type !== 'paragraph' || !schema.nodes.paragraph || !validAttrs(paragraph.attrs, schema.nodes.paragraph.spec.attrs)) return null
    const children = paragraph.content === undefined ? [] : paragraph.content
    if (!Array.isArray(children) || children.length > MAX_INLINE_NODES) return null
    for (const child of children) {
      if (!record(child) || !onlyKeys(child, ['type', 'attrs', 'text', 'marks']) || typeof child.type !== 'string' || !INLINE_NODES.has(child.type)) return null
      const type = schema.nodes[child.type]
      if (!type?.isInline || !type.isLeaf || !validAttrs(child.attrs, type.spec.attrs)) return null
      if (child.type === 'text' ? typeof child.text !== 'string' || !child.text.length : child.text !== undefined) return null
      const marks = child.marks === undefined ? [] : child.marks
      if (!Array.isArray(marks) || marks.length > MARKS.size) return null
      for (const mark of marks) {
        if (!record(mark) || !onlyKeys(mark, ['type', 'attrs']) || typeof mark.type !== 'string' || !MARKS.has(mark.type)) return null
        const markType = schema.marks[mark.type]
        if (!markType || !validAttrs(mark.attrs, markType.spec.attrs)) return null
        if (mark.type === 'link' && (!record(mark.attrs) || !safeLink(mark.attrs.href))) return null
        if (['strong', 'emphasis'].includes(mark.type) && record(mark.attrs) && mark.attrs.marker !== undefined && !['*', '_'].includes(String(mark.attrs.marker))) return null
      }
    }
    const fragment = Fragment.fromJSON(schema, envelope.content)
    fragment.forEach((node) => node.check())
    return fragment
  } catch { return null }
}

function withinDomBudget(dom: HTMLElement, limits: TableClipboardLimits): boolean {
  if (!validLimits(limits)) return false
  let root: globalThis.Node = dom
  for (let parent = dom.parentNode; parent?.nodeType === 1; parent = parent.parentNode) {
    root = parent
    if (parent.nodeName.toLowerCase() === 'table') break
  }
  let cursor: globalThis.Node | null = root, characters = 0, cells = 0, visited = 0
  while (cursor) {
    if (++visited > Math.min(65536, limits.characters + limits.cells * 8)) return false
    if (cursor.nodeType === 1 && ['td', 'th'].includes(cursor.nodeName.toLowerCase())) {
      const value = (cursor as HTMLElement).getAttribute(TABLE_CLIPBOARD_CONTENT_ATTRIBUTE)
      if (value !== null) { characters += value.length; if (++cells > limits.cells || characters > limits.characters) return false }
    }
    if (cursor.firstChild) cursor = cursor.firstChild
    else {
      while (cursor !== root && !cursor.nextSibling) cursor = cursor.parentNode!
      cursor = cursor === root ? null : cursor.nextSibling
    }
  }
  return true
}

function compatibleCellSchema(previous: NodeSchema, tag: 'td' | 'th', context: Ctx, limits: TableClipboardLimits): NodeSchema {
  const native = previous.parseDOM?.find((rule): rule is TagParseRule => rule.tag === tag)
  if (!native) return previous
  const rule: TagParseRule = {
    tag: `${tag}[${TABLE_CLIPBOARD_CONTENT_ATTRIBUTE}]`,
    priority: Math.max(100, (native.priority ?? 50) + 1),
    getAttrs: (dom) => {
      try {
        if (!withinDomBudget(dom, limits)) return false
        const schema = context.get(schemaCtx)
        const fragment = tableClipboardContentFragment(dom.getAttribute(TABLE_CLIPBOARD_CONTENT_ATTRIBUTE), schema, limits)
        if (!fragment) return false
        const attrs = native.getAttrs ? native.getAttrs(dom) : native.attrs ?? null
        if (attrs === false) return false
        schema.nodes[tag === 'td' ? 'table_cell' : 'table_header'].createChecked(attrs, fragment).check()
        return attrs
      } catch { return false }
    },
    // getAttrs validated the marker first. Revalidate without retaining mutable
    // cross-editor DOM/state; a subsequently removed marker becomes empty data.
    getContent: (dom, schema) => tableClipboardContentFragment((dom as HTMLElement).getAttribute(TABLE_CLIPBOARD_CONTENT_ATTRIBUTE), schema, limits) ?? Fragment.empty,
  }
  return { ...previous, parseDOM: [rule, ...(previous.parseDOM ?? [])] }
}

/** Configure before schema creation. Unmarked/invalid/unknown-version HTML keeps its native rules. */
export function configureTableClipboardContent(ctx: Ctx, limits: TableClipboardLimits = TABLE_CLIPBOARD_LIMITS): void {
  ctx.update(tableCellSchema.key, (previous) => (context) => compatibleCellSchema(previous(context), 'td', context, limits))
  ctx.update(tableHeaderSchema.key, (previous) => (context) => compatibleCellSchema(previous(context), 'th', context, limits))
}

function boundedSource(node: Node, limits: TableClipboardLimits): TableClipboardContentStatus {
  if (!validLimits(limits) || node.childCount === 1 && node.firstChild!.childCount > MAX_INLINE_NODES) return { ok: false, reason: 'size-limit' }
  if (node.childCount !== 1 || node.firstChild!.type.name !== 'paragraph') return { ok: false, reason: 'unsupported-content' }
  let size = 0, valid = true
  const inspectAttrs = (attrs: Record<string, unknown>) => {
    for (const value of Object.values(attrs)) {
      if (typeof value === 'string') size += value.length
      else if (value !== null && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) valid = false
    }
  }
  inspectAttrs(node.firstChild!.attrs)
  node.firstChild!.forEach((child) => {
    if (!INLINE_NODES.has(child.type.name) || !child.isLeaf || child.marks.length > MARKS.size) valid = false
    size += child.text?.length ?? 0
    inspectAttrs(child.attrs)
    for (const mark of child.marks) { if (!MARKS.has(mark.type.name)) valid = false; inspectAttrs(mark.attrs) }
  })
  return !valid ? { ok: false, reason: 'unsupported-content' } : size > limits.characters ? { ok: false, reason: 'size-limit' } : { ok: true }
}

interface SerializationBudget { cells: number; characters: number }
function markedCellSpec(spec: DOMOutputSpec, node: Node, schema: Schema, limits: TableClipboardLimits, reject: (reason: 'size-limit' | 'unsupported-content') => void, budget?: SerializationBudget): DOMOutputSpec {
  // The native GFM cells use an array DOM spec. Preserve custom DOM-valued
  // serializers without mutating their DOM or guessing their content element.
  if (!Array.isArray(spec) || !['td', 'th'].includes(String(spec[0]).toLowerCase())) { reject('unsupported-content'); return spec }
  const source = boundedSource(node, limits)
  if (!source.ok) { reject(source.reason); return spec }
  try {
    const marker = JSON.stringify({ version: VERSION, content: node.content.toJSON() })
    if (marker.length > limits.characters) { reject('size-limit'); return spec }
    if (!tableClipboardContentFragment(marker, schema, limits)) { reject('unsupported-content'); return spec }
    if (budget) {
      if (budget.cells >= limits.cells || marker.length > limits.characters - budget.characters) { reject('size-limit'); return spec }
      budget.cells++; budget.characters += marker.length
    }
    const hasAttrs = record(spec[1]) && !(spec[1] as { nodeType?: unknown }).nodeType
    return [spec[0], { ...(hasAttrs ? spec[1] : {}), [TABLE_CLIPBOARD_CONTENT_ATTRIBUTE]: marker }, ...spec.slice(hasAttrs ? 2 : 1)] as DOMOutputSpec
  } catch { reject('unsupported-content'); return spec }
}

/**
 * Use as the view clipboardSerializer. Unsupported/oversized metadata retains
 * native HTML and exposes contentStatus after serialization. A caller requiring
 * lossless table content can reject before writing either clipboard flavor or
 * deleting cut content. The editor DOM and source schema toDOM stay unchanged.
 */
export function createTableClipboardSerializer(schema: Schema, previous: DOMSerializer = DOMSerializer.fromSchema(schema), limits: TableClipboardLimits = TABLE_CLIPBOARD_LIMITS): TableClipboardContentSerializer {
  // Budget belongs to this serializer's synchronous call, never to a module or
  // another editor. Nested serializeFragment calls share the outer call budget.
  let budget: SerializationBudget | undefined
  let status: TableClipboardContentStatus = { ok: true }
  const reject = (reason: 'size-limit' | 'unsupported-content') => { if (status.ok) status = { ok: false, reason } }
  const nodes = { ...previous.nodes }
  for (const name of ['table_cell', 'table_header']) {
    const serialize = nodes[name]
    if (serialize) nodes[name] = (node) => markedCellSpec(serialize(node), node, schema, limits, reject, budget)
  }
  const serializer = new DOMSerializer(nodes, previous.marks) as TableClipboardContentSerializer
  Object.defineProperty(serializer, 'contentStatus', { get: () => ({ ...status }) })
  const fragment = serializer.serializeFragment.bind(serializer)
  serializer.serializeFragment = (content, options = {}, target) => {
    const outer = !budget
    if (outer) { budget = { cells: 0, characters: 0 }; status = { ok: true } }
    try { return fragment(content, options, target) }
    finally { if (outer) budget = undefined }
  }
  const single = serializer.serializeNode.bind(serializer)
  serializer.serializeNode = (node, options = {}) => {
    const outer = !budget
    if (outer) { budget = { cells: 0, characters: 0 }; status = { ok: true } }
    try { return single(node, options) }
    finally { if (outer) budget = undefined }
  }
  return serializer
}
