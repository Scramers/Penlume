import { Fragment, type Node as ProseNode, type Schema, type Slice } from '@milkdown/kit/prose/model'
import type { NodeSchema } from '@milkdown/kit/transformer'
import { emojiForShortcode } from '../../shared/emoji-shortcodes'
import { blockImageRatio, blockImageResizeWidth } from '../../shared/block-image-markdown'

export const SELECTION_FRAGMENT_CHARACTER_LIMIT = 20 * 1024 * 1024
const MAX_DEPTH = 128
const NODES = new Set(['text', 'paragraph', 'heading', 'blockquote', 'bullet_list', 'ordered_list', 'list_item', 'code_block', 'math_block', 'math_inline', 'hardbreak', 'hr', 'image', 'image-block', 'emoji', 'front_matter', 'document_toc', 'markdown_alert', 'html', 'html_block', 'footnote_reference', 'footnote_definition'])
const MARKS = new Set(['strong', 'emphasis', 'strike_through', 'inlineCode', 'link', 'highlight', 'superscript', 'subscript', 'underline'])

export type SelectionFragment = Readonly<{ kind: 'rich' | 'source' | 'literal'; markdown: string; plain: string }>
export type SelectionFragmentResult = { ok: true; value: SelectionFragment } | { ok: false; reason: 'empty' | 'unsupported-selection' | 'unsupported-content' | 'size-limit' }
type Rejection = Extract<SelectionFragmentResult, { ok: false }>['reason']

class FragmentRejection extends Error {
  constructor(readonly reason: Rejection) { super(reason) }
}
function reject(reason: Rejection): never { throw new FragmentRejection(reason) }
const withinLimit = (text: string) => text.length <= SELECTION_FRAGMENT_CHARACTER_LIMIT
const result = (kind: SelectionFragment['kind'], markdown: string, plain: string): SelectionFragmentResult =>
  withinLimit(markdown) && withinLimit(plain) ? { ok: true, value: Object.freeze({ kind, markdown, plain }) } : { ok: false, reason: 'size-limit' }

/** Native and source selections preserve every UTF-16 character, including whitespace. */
export function fromExactSelection(text: string, kind: 'source' | 'literal'): SelectionFragmentResult {
  return text.length ? result(kind, text, text) : { ok: false, reason: 'empty' }
}

function inspect(fragment: Fragment, schema: Schema): void {
  let characters = 0
  const definitions = new Set<string>(), references = new Set<string>()
  // Use the installed micromark identifier convention without adding a new
  // runtime dependency: collapse Markdown whitespace and Unicode case-fold.
  const identifier = (label: string) => label.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '').toLowerCase().toUpperCase()
  const add = (size: number) => { characters += size; if (characters > SELECTION_FRAGMENT_CHARACTER_LIMIT) reject('size-limit') }
  const attrs = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      add(key.length)
      if (typeof value === 'string') add(value.length)
      else if (value !== null && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) reject('unsupported-content')
    }
  }
  const walk = (content: Fragment, depth: number) => {
    if (depth > MAX_DEPTH) reject('size-limit')
    content.forEach((node, _offset, index) => {
      add(node.type.name.length + 4 + (node.text?.length ?? 0))
      if (!NODES.has(node.type.name) || schema.nodes[node.type.name] !== node.type) reject('unsupported-content')
      const serializer = (node.type.spec as Partial<NodeSchema>).toMarkdown
      if (typeof serializer?.match !== 'function' || typeof serializer.runner !== 'function') reject('unsupported-content')
      attrs(node.attrs)
      for (const mark of node.marks) {
        if (!MARKS.has(mark.type.name) || schema.marks[mark.type.name] !== mark.type) reject('unsupported-content')
        add(mark.type.name.length + 4); attrs(mark.attrs)
        if (['strong', 'emphasis'].includes(mark.type.name) && !['*', '_'].includes(String(mark.attrs.marker))) reject('unsupported-content')
        // The native code mark consumes node.text and skips the node runner.
        if (mark.type.name === 'inlineCode' && !node.isText) reject('unsupported-content')
        if (node.isText) {
          if (mark.type.name === 'inlineCode' && /[\r\n]/.test(node.text!)) reject('unsupported-content')
          if (mark.type.name !== 'inlineCode') {
            const previous = content.maybeChild(index - 1), next = content.maybeChild(index + 1)
            // Milkdown moves boundary spaces outside every spanning mark. A
            // selection cut at those spaces cannot retain the selected marks.
            if (/^\s/u.test(node.text!) && !previous?.marks.some((other) => other.eq(mark)) ||
                /\s$/u.test(node.text!) && !next?.marks.some((other) => other.eq(mark))) reject('unsupported-content')
          }
        }
      }
      const name = node.type.name
      if (name === 'math_inline' && (typeof node.attrs.value !== 'string' || !node.attrs.value.length)) reject('unsupported-content')
      if (['html', 'html_block'].includes(name) && (typeof node.attrs.value !== 'string' || !node.attrs.value.length)) reject('unsupported-content')
      if (name === 'emoji') {
        const entry = typeof node.attrs.name === 'string' ? emojiForShortcode(node.attrs.name) : null
        if (!entry || entry.emoji !== node.attrs.value) reject('unsupported-content')
      }
      if (name === 'image-block' && (blockImageRatio(node.attrs.ratio) !== node.attrs.ratio ||
          node.attrs.resizeWidth != null && blockImageResizeWidth(node.attrs.resizeWidth) !== node.attrs.resizeWidth)) reject('unsupported-content')
      if (name === 'heading' && (!Number.isInteger(node.attrs.level) || node.attrs.level < 1 || node.attrs.level > 6)) reject('unsupported-content')
      if (name === 'ordered_list' && (!Number.isInteger(node.attrs.order) || node.attrs.order < 0 || node.attrs.order > 999999999)) reject('unsupported-content')
      if (['footnote_reference', 'footnote_definition'].includes(name) && !node.attrs.label) reject('unsupported-content')
      if (name === 'footnote_definition') {
        const label = identifier(String(node.attrs.label))
        if (!label || definitions.has(label)) reject('unsupported-content')
        definitions.add(label)
      }
      if (name === 'footnote_reference') {
        const label = identifier(String(node.attrs.label))
        if (!label) reject('unsupported-content')
        references.add(label)
      }
      // CommonMark's paragraph/heading runner removes its final hardbreak. Do
      // not report a lossless copy when the installed serializer cannot make it.
      if (['paragraph', 'heading'].includes(name) && node.lastChild?.type.name === 'hardbreak') reject('unsupported-content')
      if (node.content.size) walk(node.content, depth + 1)
    })
  }
  walk(fragment, 0)
  // A standalone copy must supply its selected references' definitions. Never
  // reach into the original document to add unselected footnote content.
  for (const label of references) if (!definitions.has(label)) reject('unsupported-content')
}

function openDepth(node: ProseNode | null, side: 'firstChild' | 'lastChild'): number {
  let depth = 0
  for (; node && !node.isLeaf; node = node[side]) depth++
  return depth
}

/** Only ordinary text inside one cell can discard the table's required context. */
function cellContent(slice: Slice): { content: Fragment; start: number; end: number } {
  let { content, openStart: start, openEnd: end } = slice
  if (content.childCount === 1 && content.firstChild?.type.name === 'table') {
    const table = content.firstChild!, row = table.firstChild, cell = row?.firstChild
    if (start < 3 || end < 3 || table.childCount !== 1 || !row || row.childCount !== 1 ||
        !['table_row', 'table_header_row'].includes(row.type.name) || !cell || !['table_cell', 'table_header'].includes(cell.type.name)) reject('unsupported-selection')
    content = cell.content; start -= 3; end -= 3
  }
  const pending = [{ fragment: content, depth: 0 }]
  while (pending.length) {
    const current = pending.pop()!
    if (current.depth > MAX_DEPTH) reject('size-limit')
    current.fragment.forEach((node) => {
      if (['table', 'table_row', 'table_header_row', 'table_cell', 'table_header'].includes(node.type.name)) reject('unsupported-selection')
      if (node.content.size) pending.push({ fragment: node.content, depth: current.depth + 1 })
    })
  }
  return { content, start, end }
}

function orderedStart(node: ProseNode): number {
  const label = node.firstChild?.attrs.label
  const selected = typeof label === 'string' ? /^(\d{1,9})\.$/.exec(label) : null
  return selected ? Number(selected[1]) : node.attrs.order
}

function emptyParagraphs(fragment: Fragment): boolean {
  let empty = true
  fragment.forEach((node) => { if (node.type.name !== 'paragraph' || node.content.size || node.marks.length) empty = false })
  return empty
}

/** Close only cut ancestors. Fillers may be empty paragraphs, never unselected content. */
function closeContent(fragment: Fragment, start: number, end: number): Fragment {
  const nodes: ProseNode[] = []
  fragment.forEach((node, _offset, index) => {
    const left = index === 0 ? start : 0, right = index === fragment.childCount - 1 ? end : 0
    if (node.isLeaf) { nodes.push(node); return }
    let content = closeContent(node.content, Math.max(0, left - 1), Math.max(0, right - 1))
    if (!node.type.validContent(content)) {
      if (!left && !right) reject('unsupported-content')
      const before = node.type.contentMatch.fillBefore(content)
      if (!before || before.size && !left || !emptyParagraphs(before)) reject('unsupported-content')
      content = before.append(content)
      const match = node.type.contentMatch.matchFragment(content)
      const after = match?.fillBefore(Fragment.empty, true)
      if (!after || after.size && !right || !emptyParagraphs(after)) reject('unsupported-content')
      content = content.append(after)
    }
    const attrs = node.type.name === 'ordered_list' ? { ...node.attrs, order: orderedStart(node) } : node.attrs
    nodes.push(node.type.createChecked(attrs, content, node.marks))
  })
  return Fragment.fromArray(nodes)
}

function topContent(content: Fragment, schema: Schema): Fragment {
  if (schema.topNodeType.validContent(content)) return content
  let inline = true, items = true, ordered = true, bullet = true
  content.forEach((node) => {
    inline &&= node.isInline; items &&= node.type.name === 'list_item'
    ordered &&= node.attrs.listType === 'ordered'; bullet &&= node.attrs.listType === 'bullet'
  })
  if (inline && schema.nodes.paragraph) return Fragment.from(schema.nodes.paragraph.createChecked(null, content))
  if (items && (ordered || bullet)) {
    const type = schema.nodes[ordered ? 'ordered_list' : 'bullet_list']
    if (type) {
      const list = type.createChecked(null, content)
      return Fragment.from(ordered ? type.createChecked({ ...list.attrs, order: orderedStart(list) }, content) : list)
    }
  }
  return reject('unsupported-selection')
}

function hasEmptyListParent(content: Fragment): boolean {
  let found = false
  content.forEach((node) => {
    // The installed serializer emits <br /> for an empty parent paragraph.
    // Its HTML parser then consumes the following nested list as literal HTML.
    if (node.type.name === 'list_item' && node.firstChild?.type.name === 'paragraph' && !node.firstChild.content.size
      && node.childCount > 1 && ['bullet_list', 'ordered_list'].includes(node.child(1).type.name)) found = true
    if (node.content.size && hasEmptyListParent(node.content)) found = true
  })
  return found
}

function readableImage(node: ProseNode): string {
  const source = String(node.attrs.src ?? ''), alt = String(node.attrs.alt ?? ''), title = String(node.attrs.caption ?? node.attrs.title ?? '')
  const label = alt || title
  return label ? `${label}${source ? ` (${source})` : ''}${title && title !== label ? ` — ${title}` : ''}` : source || '![]()'
}

function readableBlocks(content: Fragment): string {
  const values: string[] = []
  content.forEach((node) => values.push(readableNode(node)))
  return values.join('\n\n')
}

function readableList(node: ProseNode): string {
  const values: string[] = [], start = node.type.name === 'ordered_list' ? orderedStart(node) : 0
  node.forEach((item, _offset, index) => {
    const marker = node.type.name === 'ordered_list' ? `${start + index}. ` : '- '
    const checked = typeof item.attrs.checked === 'boolean' ? `[${item.attrs.checked ? 'x' : ' '}] ` : ''
    const indent = (text: string) => text.split('\n').map((line) => `${' '.repeat(marker.length)}${line}`).join('\n')
    const first = readableNode(item.firstChild!).split('\n')
    let value = `${marker}${checked}${first[0]}${first.length > 1 ? `\n${indent(first.slice(1).join('\n'))}` : ''}`
    for (let child = 1; child < item.childCount; child++) {
      const next = item.child(child)
      value += `${['bullet_list', 'ordered_list'].includes(next.type.name) ? '\n' : '\n\n'}${indent(readableNode(next))}`
    }
    values.push(value)
  })
  return values.join('\n')
}

function readableNode(node: ProseNode): string {
  if (node.isText) return node.text!
  switch (node.type.name) {
    case 'hardbreak': return node.attrs.isInline ? ' ' : '\n'
    case 'math_inline': case 'html': case 'html_block': return String(node.attrs.value)
    case 'emoji': return String(node.attrs.value)
    case 'image': case 'image-block': return readableImage(node)
    case 'hr': return '---'
    case 'document_toc': return '[TOC]'
    case 'footnote_reference': return `[^${node.attrs.label}]`
    case 'code_block': case 'math_block': case 'front_matter': return node.textContent
    case 'paragraph': case 'heading': {
      let value = ''; node.forEach((child) => { value += readableNode(child) }); return value
    }
    case 'bullet_list': case 'ordered_list': return readableList(node)
    case 'markdown_alert': return `[!${node.attrs.kind}]\n${readableBlocks(node.content)}`
    case 'footnote_definition': return `[^${node.attrs.label}]: ${readableBlocks(node.content)}`
    case 'blockquote': case 'list_item': return readableBlocks(node.content)
    default: return reject('unsupported-content')
  }
}

/** Supported fragments only; unknown leaves throw instead of disappearing. */
export function selectedPlainText(fragment: Fragment): string {
  if (!fragment.childCount) return ''
  inspect(fragment, fragment.firstChild!.type.schema)
  let inline = true
  fragment.forEach((node) => { inline &&= node.isInline })
  let plain = ''
  if (inline) fragment.forEach((node) => { plain += readableNode(node) })
  else plain = readableBlocks(fragment)
  return withinLimit(plain) ? plain : reject('size-limit')
}

/**
 * Call with Selection.content(), after excluding CellSelection. No editor,
 * DOM, full-document serializer, source bookmark, or transaction is consulted.
 */
export function serializeRichSelection(slice: Slice, schema: Schema, serialize: (doc: ProseNode) => string): SelectionFragmentResult {
  try {
    if (![slice.openStart, slice.openEnd].every((depth) => Number.isInteger(depth) && depth >= 0 && depth <= MAX_DEPTH) ||
        slice.openStart > openDepth(slice.content.firstChild, 'firstChild') || slice.openEnd > openDepth(slice.content.lastChild, 'lastChild')) reject('unsupported-selection')
    if (!slice.size) return { ok: false, reason: 'empty' }
    if (slice.size < 0) reject('unsupported-selection')
    const selected = cellContent(slice)
    inspect(selected.content, schema)
    const content = topContent(closeContent(selected.content, selected.start, selected.end), schema)
    if (hasEmptyListParent(content)) reject('unsupported-content')
    const doc = schema.topNodeType.createChecked(null, content)
    doc.check()
    const plain = selectedPlainText(doc.content), markdown = serialize(doc)
    if (typeof markdown !== 'string' || !markdown.length) reject('unsupported-content')
    return result('rich', markdown, plain)
  } catch (error) {
    return { ok: false, reason: error instanceof FragmentRejection ? error.reason : 'unsupported-content' }
  }
}
