import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root, RootContent, PhrasingContent } from 'mdast'
import { remarkEditorExtensions } from '../../shared/markdown-extensions'
import { defaultMarkdownExtensions, type MarkdownExtensionOptions } from '../../shared/preferences'

export interface MarkdownTextBlock { type: string; text: string; offsets: number[]; endOffsets: number[]; from: number; to: number }
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(remarkFrontmatter)

export function isMarkdownLiteralPosition(markdown: string, offset: number): boolean {
  const tree = parser.parse(markdown) as Root
  const visit = (node: RootContent | Root): boolean => {
    const from = node.position?.start.offset ?? 0, to = node.position?.end.offset ?? markdown.length
    if (offset < from || offset > to) return false
    if (['code', 'inlineCode', 'math', 'inlineMath', 'yaml', 'html', 'definition'].includes(node.type)) return true
    return 'children' in node && node.children.some((child) => visit(child as RootContent))
  }
  return visit(tree)
}

export interface MarkdownInlineMathRange {
  from: number
  contentFrom: number
  contentTo: number
  value: string
  offsets: number[]
  endOffsets: number[]
}

/** Inline math preserves literal characters but omits container prefixes and optional padding. */
function mapInlineMathValue(markdown: string, from: number, to: number, rawValue: string): MarkdownInlineMathRange | undefined {
  const raw = markdown.slice(from, to), delimiter = raw.match(/^\$+/)?.[0].length ?? 1
  const bodyFrom = from + delimiter, bodyTo = to - delimiter
  const body = markdown.slice(bodyFrom, bodyTo), value = rawValue.replace(/\r\n?/g, '\n')
  const lines = value.split('\n')
  const sourceLines: { value: string; from: number; newlineFrom: number; newlineTo: number }[] = []
  let cursor = 0
  for (const match of body.matchAll(/\r\n|\r|\n/g)) {
    const end = match.index!
    sourceLines.push({ value: body.slice(cursor, end), from: bodyFrom + cursor, newlineFrom: bodyFrom + end, newlineTo: bodyFrom + end + match[0].length })
    cursor = end + match[0].length
  }
  sourceLines.push({ value: body.slice(cursor), from: bodyFrom + cursor, newlineFrom: bodyTo, newlineTo: bodyTo })
  // micromark removes one leading and trailing space/line ending only when
  // both are present and the formula contains data. Enumerate those exact
  // padding choices, then verify every complete literal line against mdast.
  const hasData = /[^ \n]/.test(value)
  const starts: { row: number; column: number | null; padded: boolean }[] = [{ row: 0, column: 0, padded: false }]
  if (hasData && body.startsWith(' ')) starts.push({ row: 0, column: 1, padded: true })
  if (hasData && /^(?:\r\n|\r|\n)/.test(body)) starts.push({ row: 1, column: null, padded: true })
  const containerPrefix = /^(?:[ \t]*>[ \t]?)*[ \t]*$/
  for (const start of starts) {
    const endings = start.padded ? [
      { row: sourceLines.length - 1, trim: 1 },
      { row: sourceLines.length - 2, trim: 0 },
    ] : [{ row: sourceLines.length - 1, trim: 0 }]
    for (const end of endings) {
      if (end.row - start.row + 1 !== lines.length || end.row < start.row) continue
      if (end.trim && !sourceLines[end.row].value.endsWith(' ')) continue
      if (end.row < sourceLines.length - 1 && !containerPrefix.test(sourceLines.at(-1)!.value)) continue
      const positions: number[] = []
      let valid = true
      for (let index = 0; index < lines.length; index++) {
        const row = sourceLines[start.row + index], literal = lines[index]
        const column = row.value.length - (index === lines.length - 1 ? end.trim : 0) - literal.length
        if (column < 0 || row.value.slice(column, column + literal.length) !== literal ||
          (index === 0 && start.column !== null ? column !== start.column : !containerPrefix.test(row.value.slice(0, column)))) { valid = false; break }
        positions.push(row.from + column)
      }
      if (!valid) continue
      const offsets: number[] = [], ends: number[] = []
      lines.forEach((line, index) => {
        for (let character = 0; character < line.length; character++) { offsets.push(positions[index] + character); ends.push(positions[index] + character + 1) }
        if (index < lines.length - 1) { const row = sourceLines[start.row + index]; offsets.push(row.newlineFrom); ends.push(row.newlineTo) }
      })
      const contentFrom = offsets[0] ?? positions[0], contentTo = ends.at(-1) ?? contentFrom
      offsets.push(contentTo)
      return { from, contentFrom, contentTo, value, offsets, endOffsets: [contentFrom, ...ends] }
    }
  }
}

export function markdownInlineMathRanges(markdown: string): MarkdownInlineMathRange[] {
  const result: MarkdownInlineMathRange[] = []
  const visit = (node: RootContent | Root) => {
    if (node.type === 'inlineMath') {
      const from = node.position?.start.offset ?? 0, to = node.position?.end.offset ?? from
      const mapped = mapInlineMathValue(markdown, from, to, node.value)
      if (mapped) result.push(mapped)
      return
    }
    if ('children' in node) node.children.forEach((child) => visit(child as RootContent))
  }
  visit(parser.parse(markdown) as Root)
  return result
}

// Source positions are UTF-16 offsets, as used by both CodeMirror and ProseMirror.
export function markdownTextBlocks(markdown: string, options: MarkdownExtensionOptions = defaultMarkdownExtensions): MarkdownTextBlock[] {
  const processor = parser().use(remarkEditorExtensions, options)
  const tree = processor.runSync(processor.parse(markdown), markdown) as Root
  const result: MarkdownTextBlock[] = []
  const inline = (node: PhrasingContent): { text: string; offsets: number[]; endOffsets: number[] } => {
    const from = node.position?.start.offset ?? 0, to = node.position?.end.offset ?? from
    if ('children' in node) return combine(node.children.map((child) => inline(child as PhrasingContent)))
    if (node.type === 'image' || node.type === 'imageReference' || node.type === 'footnoteReference' || node.type === 'inlineMath' || node.type === 'html' || node.type === 'break' || String(node.type) === 'ttyporaEmoji') return { text: '\ufffc', offsets: [from, to], endOffsets: [from, to] }
    const value = 'value' in node ? String(node.value) : ''
    const raw = markdown.slice(from, to)
    const offsets: number[] = []
    const ends: number[] = []
    let cursor = 0
    if (node.type === 'inlineCode') cursor = raw.match(/^`+ ?/)?.[0].length ?? 0
    for (let index = 0; index < value.length; index++) {
      if (raw[cursor] === '\\' && raw[cursor + 1] === value[index]) cursor++
      if (node.type === 'text' && raw[cursor] === '&') {
        const entity = raw.slice(cursor).match(/^&(?:#x[\da-f]+|#\d+|\w+);/i)?.[0]
        if (entity) {
          const parsed = parser.parse(entity) as Root
          const paragraph = parsed.children[0]
          const text = paragraph?.type === 'paragraph' ? paragraph.children[0] : null
          const decoded = text?.type === 'text' ? text.value : entity
          if (decoded !== entity && value.slice(index, index + decoded.length) === decoded) {
            offsets.push(...Array.from({ length: decoded.length }, () => from + cursor))
            ends.push(...Array.from({ length: decoded.length }, () => from + cursor + entity.length))
            index += decoded.length - 1; cursor += entity.length; continue
          }
        }
      }
      const next = raw.indexOf(value[index], cursor)
      offsets.push(from + (next >= 0 ? next : cursor))
      cursor = next >= 0 ? next + 1 : cursor + 1
      ends.push(Math.min(to, from + cursor))
    }
    offsets.push(Math.min(to, from + cursor))
    return { text: value, offsets, endOffsets: [offsets[0] ?? from, ...ends] }
  }
  function combine(parts: { text: string; offsets: number[]; endOffsets: number[] }[]) {
    return { text: parts.map((part) => part.text).join(''), offsets: [...parts.flatMap((part) => part.offsets.slice(0, -1)), parts.at(-1)?.offsets.at(-1) ?? 0], endOffsets: [parts[0]?.endOffsets[0] ?? 0, ...parts.flatMap((part) => part.endOffsets.slice(1))] }
  }
  const visit = (node: RootContent | Root) => {
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      if (node.type === 'paragraph' && /^\[toc\]$/i.test(markdown.slice(node.position?.start.offset, node.position?.end.offset).trim())) return
      if (node.type === 'paragraph' && /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.test(node.children.map((child) => 'value' in child ? child.value : '').join(''))) return
      const mapped = combine(node.children.map((child) => inline(child)))
      const alert = mapped.text.match(/^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/i)
      if (alert) { mapped.text = mapped.text.slice(alert[0].length); mapped.offsets = mapped.offsets.slice(alert[0].length); mapped.endOffsets = mapped.endOffsets.slice(alert[0].length); mapped.endOffsets[0] = mapped.offsets[0] }
      if (!mapped.text) mapped.offsets = mapped.endOffsets = [node.position?.start.offset ?? 0]
      result.push({ type: node.type, ...mapped, from: node.position?.start.offset ?? 0, to: node.position?.end.offset ?? 0 })
      return
    }
    if (node.type === 'code' || node.type === 'math' || node.type === 'yaml' || node.type === 'html' || String(node.type) === 'ttyporaHtmlBlock') {
      const from = node.position?.start.offset ?? 0, to = node.position?.end.offset ?? from
      const rawValue = 'value' in node ? String(node.value) : ''
      const value = node.type === 'math' || node.type === 'code' ? rawValue.replace(/\r\n?/g, '\n') : rawValue
      const raw = markdown.slice(from, to), start = raw.indexOf('\n') + 1
      const begin = node.type === 'html' || String(node.type) === 'ttyporaHtmlBlock' || (node.type === 'code' && !/^\s{0,3}(?:`{3,}|~{3,})/.test(raw)) ? 0 : start
      const offsets: number[] = [], ends: number[] = []
      let lineStart = begin
      const lines = value.split('\n')
      lines.forEach((line, index) => {
        const newline = raw.indexOf('\n', lineStart), lineEnd = newline < 0 ? raw.length : newline
        const rawLine = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
        // Container prefixes and indentation are absent from the parsed code value.
        const indent = line ? Math.max(0, rawLine.lastIndexOf(line)) : Math.min(rawLine.length, (node.position?.start.column ?? 1) - 1)
        for (let character = 0; character < line.length; character++) { const position = Math.min(to, from + lineStart + indent + character); offsets.push(position); ends.push(Math.min(to, position + 1)) }
        if (index < lines.length - 1) { offsets.push(from + lineEnd); ends.push(Math.min(to, from + lineEnd + 1)) }
        lineStart = lineEnd + 1
      })
      offsets.push(ends.at(-1) ?? Math.min(to, from + begin))
      result.push({ type: node.type, text: value, offsets, endOffsets: [offsets[0], ...ends], from, to })
      return
    }
    if ('children' in node) node.children.forEach((child) => visit(child as RootContent))
  }
  visit(tree)
  return result
}

export function nearestTextOffset(offsets: number[], sourceOffset: number): number {
  let low = 0, high = offsets.length - 1
  while (low < high) { const mid = Math.floor((low + high) / 2); if (offsets[mid] < sourceOffset) low = mid + 1; else high = mid }
  if (low > 0 && sourceOffset - offsets[low - 1] <= offsets[low] - sourceOffset) return low - 1
  return low
}
