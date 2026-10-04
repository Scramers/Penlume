import type { EditorBookmark } from '../../shared/document-history'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root, RootContent } from 'mdast'
import characterEntities from '../../shared/markdown-character-entities.json'
import { markdownInlineMathRanges, nearestTextOffset, type MarkdownTextBlock } from './markdown-position'

interface CodeMetadataRange { from: number; contentFrom: number; contentTo: number; value: string; offsets: number[]; endOffsets: number[] }
const metadataParser = unified().use(remarkParse).use(remarkFrontmatter)
let cachedMetadata: { markdown: string; ranges: CodeMetadataRange[] } | undefined

function numericReference(value: string, radix: number): string {
  const code = Number.parseInt(value, radix)
  // Match micromark's numeric-reference rules, including control and noncharacters.
  const invalid = code < 9 || code === 11 || code > 13 && code < 32 || code > 126 && code < 160 ||
    code > 0xd7ff && code < 0xe000 || code > 0xfdcf && code < 0xfdf0 ||
    (code & 0xffff) === 0xffff || (code & 0xffff) === 0xfffe || code > 0x10ffff
  return invalid ? '\ufffd' : String.fromCodePoint(code)
}

/** Decode once, keeping the complete source span for every decoded UTF-16 unit. */
function mapCodeInfo(raw: string, from: number) {
  let value = '', cursor = 0
  const offsets: number[] = [], ends: number[] = []
  const append = (text: string, start: number, end: number) => {
    value += text
    for (let index = 0; index < text.length; index++) { offsets.push(from + start); ends.push(from + end) }
  }
  const literal = (end: number) => { while (cursor < end) { append(raw[cursor], cursor, cursor + 1); cursor++ } }
  for (const match of raw.matchAll(/\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|[xX][\da-fA-F]{1,6})|[\da-zA-Z]{1,31});/g)) {
    const start = match.index!
    literal(start)
    const reference = match[2]
    let decoded = match[1]
    if (reference?.startsWith('#')) {
      const hex = /^#[xX]/.test(reference)
      decoded = numericReference(reference.slice(hex ? 2 : 1), hex ? 16 : 10)
    } else if (reference) decoded = (characterEntities as Record<string, string>)[reference]
    if (decoded) append(decoded, start, start + match[0].length)
    else { literal(start + match[0].length); continue }
    cursor = start + match[0].length
  }
  literal(raw.length)
  return { value, offsets, ends }
}

function codeMetadataRanges(markdown: string): CodeMetadataRange[] {
  if (cachedMetadata?.markdown === markdown) return cachedMetadata.ranges
  const ranges: CodeMetadataRange[] = []
  const visit = (node: Root | RootContent) => {
    if (node.type === 'code') {
      const from = node.position?.start.offset ?? 0, start = codeMetadataOffset(markdown, from)
      if (start === undefined) return
      const line = markdown.slice(from).split(/\r\n|\r|\n/, 1)[0], end = from + line.length
      let raw = markdown.slice(start, end), mapped = mapCodeInfo(raw, start)
      const meta = node.meta ?? ''
      // Trailing whitespace may belong to the fence token rather than its info.
      if (mapped.value !== meta) { raw = raw.replace(/[ \t]+$/, ''); mapped = mapCodeInfo(raw, start) }
      if (mapped.value !== meta) return
      let value = ''
      const offsets: number[] = [], ends: number[] = []
      for (let index = 0; index < meta.length; index++) {
        // Native text inputs strip line breaks, including encoded CR/LF.
        if (meta[index] === '\r' || meta[index] === '\n') continue
        value += meta[index]; offsets.push(mapped.offsets[index]); ends.push(mapped.ends[index])
      }
      const contentFrom = offsets[0] ?? start, contentTo = ends.at(-1) ?? start
      offsets.push(contentTo)
      ranges.push({ from, contentFrom, contentTo, value, offsets, endOffsets: [contentFrom, ...ends] })
      return
    }
    if ('children' in node) node.children.forEach((child) => visit(child as RootContent))
  }
  visit(metadataParser.parse(markdown) as Root)
  cachedMetadata = { markdown, ranges }
  return ranges
}

function fieldOffset(offsets: number[], sourceOffset: number, end: boolean): number {
  let index = nearestTextOffset(offsets, sourceOffset)
  // An encoded astral/multi-character entity is one source token. Its end edge
  // must select every decoded unit, never half a surrogate or combining pair.
  if (end) while (index + 1 < offsets.length && offsets[index + 1] === offsets[index]) index++
  return index
}

/** The metadata follows the language token, even when both contain identical text. */
export function codeMetadataOffset(markdown: string, from: number): number | undefined {
  const line = markdown.slice(from).split(/\r\n|\r|\n/, 1)[0]
  const opening = line.match(/^ {0,3}(?:`{3,}|~{3,})[ \t]*[^ \t\r\n]*[ \t]*/)?.[0]
  return opening ? from + opening.length : undefined
}

export function codeMetadataFieldBookmark(markdown: string, sourceOffset: number, anchor: number, head: number): EditorBookmark | undefined {
  const range = codeMetadataRanges(markdown).find((range) => range.from === sourceOffset)
  if (!range) return
  const clamp = (position: number) => Math.max(0, Math.min(range.value.length, position))
  anchor = clamp(anchor); head = clamp(head)
  return {
    anchor: (anchor > head ? range.endOffsets : range.offsets)[anchor],
    head: (head > anchor ? range.endOffsets : range.offsets)[head],
    embedded: { kind: 'code-meta', sourceOffset, anchor, head },
  }
}

/** Textarea offsets use LF; retain the original CRLF and container source positions. */
export function inlineMathFieldBookmark(markdown: string, sourceOffset: number, anchor: number, head: number): EditorBookmark | undefined {
  const range = markdownInlineMathRanges(markdown).find((range) => range.from === sourceOffset)
  if (!range) return
  const clamp = (position: number) => Math.max(0, Math.min(range.value.length, position))
  anchor = clamp(anchor); head = clamp(head)
  return {
    anchor: (anchor > head ? range.endOffsets : range.offsets)[anchor],
    head: (head > anchor ? range.endOffsets : range.offsets)[head],
    embedded: { kind: 'inline-math', sourceOffset, anchor, head },
  }
}

/** Source view has absolute offsets. Recover the corresponding editable atomic field. */
export function inferCodeMathField(markdown: string, blocks: MarkdownTextBlock[], bookmark: EditorBookmark): EditorBookmark['embedded'] {
  const from = Math.min(bookmark.anchor, bookmark.head), to = Math.max(bookmark.anchor, bookmark.head)
  const inline = markdownInlineMathRanges(markdown).find((range) => from >= range.contentFrom && to <= range.contentTo)
  if (inline) return {
    kind: 'inline-math', sourceOffset: inline.from,
    anchor: nearestTextOffset(bookmark.anchor > bookmark.head ? inline.endOffsets : inline.offsets, bookmark.anchor),
    head: nearestTextOffset(bookmark.head > bookmark.anchor ? inline.endOffsets : inline.offsets, bookmark.head),
  }
  const code = codeMetadataRanges(markdown).find((range) => from >= range.contentFrom && to <= range.contentTo && blocks.some((block) => block.type === 'code' && block.from === range.from))
  if (code) return {
    kind: 'code-meta', sourceOffset: code.from,
    anchor: fieldOffset(bookmark.anchor > bookmark.head ? code.endOffsets : code.offsets, bookmark.anchor, bookmark.anchor > bookmark.head),
    head: fieldOffset(bookmark.head > bookmark.anchor ? code.endOffsets : code.offsets, bookmark.head, bookmark.head > bookmark.anchor),
  }
}
