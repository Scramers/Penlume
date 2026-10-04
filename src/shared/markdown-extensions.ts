import type { Root, RootContent, Heading, Text } from 'mdast'
import { parse as parseYaml } from 'yaml'
import { defaultMarkdownExtensions, type MarkdownExtensionOptions } from './preferences'
import { emojiForShortcode } from './emoji-shortcodes'
// WHATWG named character references, character-entities (MIT, bundled license).
import characterEntities from './markdown-character-entities.json'

export function splitFrontMatter(markdown: string): { frontMatter: string; body: string; lines: number } {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)
  return match
    ? { frontMatter: match[0], body: markdown.slice(match[0].length), lines: match[0].split('\n').length - 1 }
    : { frontMatter: '', body: markdown, lines: 0 }
}

export function readMetadata(markdown: string): Record<string, unknown> {
  const { frontMatter } = splitFrontMatter(markdown)
  if (!frontMatter) return {}
  try {
    const value: unknown = parseYaml(frontMatter.replace(/^---\r?\n/, '').replace(/(?:---|\.\.\.)\s*$/, ''), { maxAliasCount: 20 })
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section'
}

export function uniqueHeadingIds(texts: string[]): string[] {
  const used = new Set<string>()
  return texts.map((text) => {
    const base = headingSlug(text)
    let id = base
    let suffix = 1
    while (used.has(id)) id = `${base}-${suffix++}`
    used.add(id)
    return id
  })
}

interface AstNode {
  type: string
  value?: string
  depth?: number
  children?: AstNode[]
  data?: Record<string, unknown>
  position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } }
  [key: string]: unknown
}

interface InlineToken { node: AstNode; marker?: string; kind?: string; closeOnly?: boolean; openOnly?: boolean }
const inlineKinds: Record<string, { type: string; tag: string; option: keyof MarkdownExtensionOptions }> = {
  '==': { type: 'ttyporaHighlight', tag: 'mark', option: 'highlight' },
  '^': { type: 'ttyporaSuperscript', tag: 'sup', option: 'superscript' },
  '~': { type: 'ttyporaSubscript', tag: 'sub', option: 'subscript' },
  '<u>': { type: 'ttyporaUnderline', tag: 'u', option: 'underline' },
}

function escapedAt(source: string, offset: number): boolean {
  let escapes = 0
  while (offset > 0 && source[--offset] === '\\') escapes++
  return escapes % 2 === 1
}

// Keep source offsets through Markdown escapes and character references. This is also
// used by the selection mapper; an encoded delimiter never starts an extension.
export function textSourceOffsets(value: string, raw: string, from = 0): { starts: number[]; ends: number[] } {
  const starts: number[] = [], ends: number[] = []
  let cursor = 0
  for (let index = 0; index < value.length; index++) {
    const begin = cursor
    if (raw[cursor] === '\\' && raw[cursor + 1] === value[index] && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~\s]/.test(raw[cursor + 1] ?? '')) cursor++
    if (raw[cursor] === '&') {
      const entity = raw.slice(cursor).match(/^&(?:#x[\da-f]+|#\d+|\w+);/i)?.[0]
      if (entity) {
        const numeric = entity.match(/^&#(x[\da-f]+|\d+);$/i)
        const codePoint = numeric ? parseInt(numeric[1].replace(/^x/i, ''), /^x/i.test(numeric[1]) ? 16 : 10) : 0
        const decoded = numeric ? String.fromCodePoint(codePoint > 0x10ffff || !codePoint || codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint) : (characterEntities as Record<string, string>)[entity.slice(1, -1)]
        if (decoded && (numeric || value.slice(index, index + decoded.length) === decoded)) {
          for (let unit = 0; unit < decoded.length && index + unit < value.length; unit++) { starts.push(from + cursor); ends.push(from + cursor + entity.length) }
          cursor += entity.length; index += decoded.length - 1; continue
        }
      }
    }
    const next = raw.indexOf(value[index], cursor)
    cursor = next >= 0 ? next + 1 : Math.min(raw.length, cursor + 1)
    starts.push(from + (next >= 0 ? next : begin)); ends.push(from + cursor)
  }
  return { starts, ends }
}

function inlineExtensions(children: AstNode[], source: string, options: MarkdownExtensionOptions, point: (offset: number) => { offset: number; line: number; column: number }, rawText = false): AstNode[] {
  const positioned = (node: AstNode, from: number, to: number): AstNode => ({ ...node, position: { start: point(from), end: point(to) } })
  const tokens: InlineToken[] = []
  children.forEach((node) => {
    if (node.type === 'html' && options.underline && /^<\/?u\s*>$/i.test(node.value ?? '')) {
      tokens.push({ node, marker: '<u>', kind: 'ttyporaUnderline', closeOnly: /^<\//.test(node.value!), openOnly: !/^<\//.test(node.value!) }); return
    }
    if (node.type !== 'text' || !node.value || node.position?.start.offset === undefined) { tokens.push({ node }); return }
    const value = node.value, from = node.position.start.offset, to = node.position.end.offset ?? from + value.length
    const raw = source.slice(from, to), offsets = rawText ? { starts: Array.from({ length: value.length }, (_, index) => from + index), ends: Array.from({ length: value.length }, (_, index) => from + index + 1) } : textSourceOffsets(value, raw, from)
    let start = 0
    const addText = (end: number) => { if (end > start) tokens.push({ node: positioned({ type: 'text', value: value.slice(start, end) }, offsets.starts[start] ?? from, offsets.ends[end - 1] ?? to) }) }
    const pattern = /==|\^|~|:[\w+-]+:/g
    for (const match of value.matchAll(pattern)) {
      const marker = match[0], index = match.index!, begin = offsets.starts[index] ?? from
      if (source.slice(begin, begin + marker.length) !== marker || escapedAt(source, begin)) continue
      if ((marker === '~' || marker === '^') && (value[index - 1] === marker || value[index + 1] === marker)) continue
      if (marker.startsWith(':')) {
        const emoji = options.emoji && emojiForShortcode(marker.slice(1, -1))
        if (!emoji || /[\w/]/.test(value[index - 1] ?? '') || /[\w/]/.test(value[index + marker.length] ?? '')) continue
        addText(index); tokens.push({ node: positioned({ type: 'ttyporaEmoji', value: emoji.emoji, name: emoji.name, data: { hName: 'span', hProperties: { className: ['markdown-emoji'], title: marker }, hChildren: [{ type: 'text', value: emoji.emoji }] } }, begin, begin + marker.length) }); start = index + marker.length; continue
      }
      const definition = inlineKinds[marker]
      if (!definition || !options[definition.option]) continue
      addText(index); tokens.push({ node: positioned({ type: 'text', value: marker }, begin, begin + marker.length), marker, kind: definition.type }); start = index + marker.length
    }
    addText(value.length)
  })
  const result: InlineToken[] = []
  for (const token of tokens) {
    if (!token.marker || token.openOnly) { result.push(token); continue }
    let open = result.length - 1
    while (open >= 0 && !(result[open].marker === token.marker && !result[open].closeOnly)) open--
    if (open < 0) { result.push(token); continue }
    const inner = result.slice(open + 1)
    const text = inner.map((part) => astText(part.node)).join('')
    // Superscript/subscript use a single line without unescaped whitespace, matching
    // Typora's compact mathematical notation. Highlight/underline allow inline spaces.
    const between = source.slice(result[open].node.position?.end.offset, token.node.position?.start.offset)
    const validWhitespace = token.marker !== '^' && token.marker !== '~' || !/(^|[^\\])(?:\\\\)*\s/.test(between)
    if (!text || /^\s|\s$/.test(text) || /\n/.test(text) || !validWhitespace) { result.push(token); continue }
    const definition = inlineKinds[token.marker]
    const content = inner.map((part) => part.node)
    if (token.marker === '^' || token.marker === '~') content.forEach((child) => { if (child.type === 'text' && child.value) child.value = child.value.replace(/\\(\s)/g, '$1') })
    const node: AstNode = { type: token.kind!, children: content, data: { hName: definition.tag }, position: { start: result[open].node.position!.start, end: token.node.position!.end } }
    result.splice(open, result.length - open, { node })
  }
  return result.map((token) => token.node)
}

interface StringifyState { containerPhrasing: (node: AstNode, options: { before: string; after: string }) => string }
interface RemarkData { toMarkdownExtensions?: unknown[]; [key: string]: unknown }

// Installed on the same processor used by Milkdown's serializer and source mapping.
function installInlineStringifiers(data: RemarkData) {
  const handlers: Record<string, (node: AstNode, parent: unknown, state: StringifyState) => string> = {}
  Object.entries(inlineKinds).forEach(([marker, definition]) => {
    handlers[definition.type] = (node, _parent, state) => {
      let body = state.containerPhrasing(node, { before: marker, after: marker })
      if (marker === '^' || marker === '~') body = body.replace(/(?<!\\)\s/g, (space) => `\\${space}`)
      return marker === '<u>' ? `<u>${body}</u>` : `${marker}${body}${marker}`
    }
  })
  handlers.ttyporaEmoji = (node) => `:${node.name}:`
  data.toMarkdownExtensions = [...(data.toMarkdownExtensions ?? []), { handlers, unsafe: [{ character: '=', inConstruct: 'phrasing', after: '=' }, { character: '^', inConstruct: 'phrasing' }] }]
}

/** Plain heading/outline text using the same extension pairing and emoji catalog. */
export function plainMarkdownInlineText(input: string, inputOptions: Partial<MarkdownExtensionOptions> = {}): string {
  const options = { ...defaultMarkdownExtensions, ...inputOptions }
  const literals: string[] = []
  let tokenPrefix = '\u0000ttypora-code:'
  while (input.includes(tokenPrefix)) tokenPrefix = '\u0000' + tokenPrefix
  const literal = (value: string) => `${tokenPrefix}${literals.push(value) - 1};`
  let value = input.replace(/(?<!\\)(`+)([\s\S]*?)\1(?!`)/g, (_match, _marker, code: string) => literal(code.startsWith(' ') && code.endsWith(' ') && code.trim() ? code.slice(1, -1) : code))
    .replace(/(?<!\\)\$([^\n$]+)\$/g, (_match, math: string) => literal(math))
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, (_match, url: string) => literal(url.replace(/^mailto:/, '')))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  const point = (offset: number) => ({ offset, line: 1, column: offset + 1 })
  const node: AstNode = { type: 'text', value, position: { start: point(0), end: point(value.length) } }
  value = inlineExtensions([node], value, options, point, true).map(astText).join('')
  for (let iteration = 0; iteration < 8; iteration++) {
    const next = value.replace(/(?<!\\)(\*\*|~~)(\S(?:.*?\S)?)\1/g, '$2').replace(/(?<![\w\\])__(\S(?:.*?\S)?)__/g, '$1').replace(/(?<!\\)\*(\S(?:.*?\S)?)\*/g, '$1').replace(/(?<![\w\\])_(\S(?:.*?\S)?)_/g, '$1')
    if (next === value) break
    value = next
  }
  value = value.replace(/<[^>]+>/g, '')
  const entitySource = value
  value = value.replace(/&(?:#x[\da-f]+|#\d+|\w+);/gi, (entity: string, offset: number) => {
    if (escapedAt(entitySource, offset)) return entity
    const numeric = entity.match(/^&#(x[\da-f]+|\d+);$/i)
    if (!numeric) return (characterEntities as Record<string, string>)[entity.slice(1, -1)] ?? entity
    const code = parseInt(numeric[1].replace(/^x/i, ''), /^x/i.test(numeric[1]) ? 16 : 10)
    return String.fromCodePoint(code > 0x10ffff || !code || code >= 0xd800 && code <= 0xdfff ? 0xfffd : code)
  }).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~ ])/g, '$1')
  return value.replace(new RegExp(`${tokenPrefix}(\\d+);`, 'g'), (_match, index: string) => literals[Number(index)]).trim()
}

const loadMarkdownTools = () => Promise.all([import('unified'), import('remark-parse'), import('remark-gfm'), import('remark-math'), import('remark-frontmatter')])
let markdownTools: ReturnType<typeof loadMarkdownTools> | undefined

/** Pandoc receives standard inline HTML/glyphs; source edits are limited to parsed
 * extension nodes and leave code, destinations, metadata and every other byte alone.
 * Call the HTML sanitizer after this helper, before invoking Pandoc.
 */
export async function normalizeMarkdownForPandoc(markdown: string, options: Partial<MarkdownExtensionOptions> = {}): Promise<string> {
  const [{ unified }, { default: parse }, { default: gfm }, { default: math }, { default: frontmatter }] = await (markdownTools ??= loadMarkdownTools())
  const processor = unified().use(parse).use(gfm, { singleTilde: false }).use(math).use(frontmatter).use(remarkEditorExtensions, options)
  const tree = processor.runSync(processor.parse(markdown), markdown) as unknown as AstNode
  const edits: { from: number; to: number; value: string }[] = []
  const visit = (node: AstNode) => {
    const from = node.position?.start.offset, to = node.position?.end.offset
    if (from !== undefined && to !== undefined) {
      if (node.type === 'ttyporaHighlight') { edits.push({ from, to: from + 2, value: '<mark>' }, { from: to - 2, to, value: '</mark>' }) }
      if (node.type === 'ttyporaEmoji') edits.push({ from, to, value: node.value ?? '' })
    }
    node.children?.forEach(visit)
  }
  visit(tree)
  const pieces: string[] = []
  let cursor = 0
  edits.sort((a, b) => a.from - b.from).forEach(({ from, to, value }) => { pieces.push(markdown.slice(cursor, from), value); cursor = to })
  pieces.push(markdown.slice(cursor))
  return pieces.join('')
}

export function astText(node: AstNode): string {
  return node.value ?? node.children?.map(astText).join('') ?? ''
}

// Shared by the visual editor and export pipeline. Code and HTML literals are never rewritten.
export function remarkEditorExtensions(this: { data: () => object }, input: Partial<MarkdownExtensionOptions> = {}) {
  const options = { ...defaultMarkdownExtensions, ...input }
  installInlineStringifiers(this.data() as RemarkData)
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? '')
    const lineOffsets = [0]
    for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1)) lineOffsets.push(index + 1)
    const point = (offset: number) => {
      let low = 0, high = lineOffsets.length - 1
      while (low < high) { const middle = Math.ceil((low + high) / 2); if (lineOffsets[middle] <= offset) low = middle; else high = middle - 1 }
      return { offset, line: low + 1, column: offset - lineOffsets[low] + 1 }
    }
    const visit = (parent: AstNode) => {
      const literalAutolink = parent.type === 'link' && !source.slice(parent.position?.start.offset, parent.position?.end.offset).startsWith('[')
      if (!literalAutolink && ['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference'].includes(parent.type) && parent.children) parent.children = inlineExtensions(parent.children, source, options, point)
      parent.children = parent.children?.map((node) => {
        if (node.type === 'paragraph' && parent.type === 'root') {
          const raw = source.slice(node.position?.start.offset, node.position?.end.offset)
          const media = raw.match(/^\s*<(audio|video)\b/i)
          // CommonMark treats single-line media with separate opening/closing
          // tags as inline HTML. Promote only a complete standalone media block,
          // keeping every source byte and position for node-view bookmarks.
          if (media && (new RegExp(`</${media[1]}\\s*>\\s*$`, 'i').test(raw) || /\/\s*>\s*$/.test(raw))) return { ...node, type: 'ttyporaHtmlBlock', value: raw, children: undefined }
        }
        if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'html') {
          return { type: 'ttyporaHtmlBlock', value: node.children[0].value }
        }
        if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'text' && /^\[toc\]$/i.test(node.children[0].value?.trim() ?? '')) {
          return { type: 'ttyporaToc', value: '[TOC]' }
        }
        if (node.type === 'html' && parent.type === 'root') return { ...node, type: 'ttyporaHtmlBlock' }
        if (node.type === 'blockquote') {
          const first = node.children?.[0]?.children?.[0]
          const marker = first?.type === 'text' ? first.value?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/i) : null
          if (marker && first) {
            first.value = first.value!.slice(marker[0].length)
            if (!astText(node.children![0]).trim()) node.children!.shift()
            node = { ...node, type: 'ttyporaAlert', kind: marker[1].toUpperCase() }
          }
        }
        if (node.children && node.type !== 'code' && node.type !== 'inlineCode' && node.type !== 'yaml') visit(node)
        return node
      })
    }
    visit(tree as unknown as AstNode)
  }
}

export function remarkExportExtensions() {
  return (tree: Root) => {
    const headings: Heading[] = []
    const collect = (node: AstNode) => {
      if (node.type === 'heading') headings.push(node as unknown as Heading)
      node.children?.forEach(collect)
    }
    collect(tree as unknown as AstNode)
    const ids = uniqueHeadingIds(headings.map((heading) => astText(heading as unknown as AstNode)))
    headings.forEach((heading, index) => { heading.data = { hProperties: { id: ids[index] } } })
    const visit = (parent: AstNode) => {
      parent.children = parent.children?.filter((node) => node.type !== 'yaml').map((node) => {
        if (node.type === 'ttyporaToc') {
          return {
            type: 'ttyporaToc', data: { hName: 'nav', hProperties: { className: ['document-toc'], 'aria-label': '目录' } },
            children: headings.map((heading, index) => ({
              type: 'paragraph', data: { hProperties: { className: [`toc-level-${heading.depth}`] } },
              children: [{ type: 'link', url: `#${ids[index]}`, children: [{ type: 'text', value: astText(heading as unknown as AstNode) }] }],
            })),
          }
        }
        if (node.type === 'ttyporaHtmlBlock') return { ...node, type: 'html' }
        if (node.type === 'ttyporaAlert') {
          node = { ...node, type: 'blockquote', data: { hProperties: { className: ['markdown-alert', `markdown-alert-${String(node.kind).toLowerCase()}`] } }, children: [
            { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: String(node.kind) }] }] }, ...(node.children ?? []),
          ] }
        }
        if (node.children) visit(node)
        return node
      })
    }
    visit(tree as unknown as AstNode)
  }
}

export function alertMarkdownChildren(kind: string, children: RootContent[]): RootContent[] {
  return [{ type: 'paragraph', children: [{ type: 'text', value: `[!${kind}]` } as Text] }, ...children]
}
