import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Clock, Container, Ctx } from '@milkdown/kit/ctx'
import { marksCtx, nodesCtx, remarkStringifyOptionsCtx, schemaCtx } from '@milkdown/kit/core'
import { DOMParser, DOMSerializer, Schema, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView, type EditorProps } from '@milkdown/kit/prose/view'
import { CellSelection, TableMap } from '@milkdown/kit/prose/tables'
import { schema as commonmarkSchemas } from '@milkdown/kit/preset/commonmark'
import { schema as gfmSchemas, tableCellSchema, tableHeaderSchema, tableSchema } from '@milkdown/kit/preset/gfm'
import { inlineMathSchema } from '../src/renderer/editor/code-math-schema'
import { createMarkdownExtensions } from '../src/renderer/editor/markdown-extensions'
import { TABLE_CLIPBOARD_LIMITS } from '../src/renderer/editor/table-clipboard'
import { configureTableClipboardContent, createTableClipboardSerializer, tableClipboardContentFragment, TABLE_CLIPBOARD_CONTENT_ATTRIBUTE as attribute } from '../src/renderer/editor/table-clipboard-content'

afterEach(() => vi.unstubAllGlobals())

// Use a real W3C DOM document with CSS/style adapters for PM's HTML selectors,
// and the actual HTML lexer for CRLF/entity behavior. This is not a mounted GUI.
function domDocument() {
  const document = new DOMImplementation().createDocument(null, 'html', null) as unknown as Document
  const prototype = Object.getPrototypeOf(document.createElement('div'))
  prototype.matches = function (selector: string) {
    const result = /^([\w-]+)(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/.exec(selector)
    return Boolean(result && this.nodeName.toLowerCase() === result[1] && (!result[2] || this.hasAttribute(result[2]) && (result[3] === undefined || this.getAttribute(result[2]) === result[3])))
  }
  prototype.querySelectorAll = function (selector: string): Element[] {
    const results: Element[] = []
    for (let child = this.firstChild as Element | null; child; child = child.nextSibling as Element | null) if (child.nodeType === 1) {
      if (child.matches(selector)) results.push(child)
      results.push(...Array.from(child.querySelectorAll(selector)))
    }
    return results
  }
  prototype.querySelector = function (selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  Object.defineProperty(prototype, 'style', { configurable: true, get() {
    const element = this as Element
    const values = Object.fromEntries(String(this.getAttribute('style') ?? '').split(';').map((part) => part.split(':').map((value) => value.trim())))
    return { textAlign: values['text-align'] ?? '', fontWeight: values['font-weight'] ?? '', getPropertyValue: (name: string) => values[name] ?? '', get cssText() { return element.getAttribute('style') ?? '' }, set cssText(value: string) { element.setAttribute('style', value) } }
  } })
  Object.defineProperty(prototype, 'innerHTML', { configurable: true, get() {
    const xml = new XMLSerializer()
    return Array.from(this.childNodes as NodeListOf<ChildNode>, (node) => xml.serializeToString(node as never)).join('')
  } })
  Object.assign(document.implementation, { createHTMLDocument: () => document })
  vi.stubGlobal('document', document); vi.stubGlobal('HTMLElement', prototype.constructor)
  return document
}

function html(document: Document, source: string): HTMLElement {
  const root = document.createElement('div')
  const append = (parent: globalThis.Node, node: DefaultTreeAdapterMap['childNode']) => {
    if ('value' in node) { parent.appendChild(document.createTextNode(node.value)); return }
    if (!('tagName' in node)) return
    const element = document.createElement(node.tagName)
    for (const attr of node.attrs) element.setAttribute(attr.name, attr.value)
    parent.appendChild(element)
    for (const child of node.childNodes) append(element, child)
  }
  for (const node of parseFragment(source).childNodes) append(root, node)
  return root
}

async function editor(compatible = true, limits = TABLE_CLIPBOARD_LIMITS) {
  const document = domDocument(), lifecycle = new EventTarget()
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) vi.stubGlobal(name, lifecycle[name].bind(lifecycle))
  const ctx = new Ctx(new Container(), new Clock())
  ctx.inject(remarkStringifyOptionsCtx).inject(nodesCtx, []).inject(marksCtx, [])
  for (const plugin of [...commonmarkSchemas, ...gfmSchemas]) await plugin(ctx)()
  // Register the real app $mark/$node definitions, without mounting their views,
  // creating input rules, or substituting invented mark schemas.
  for (const plugin of createMarkdownExtensions({ emoji: false, emojiCompletion: false })) if (Object.hasOwn(plugin, 'type')) await plugin(ctx)()
  ctx.update(tableSchema.key, (previous) => (context) => ({ ...previous(context), content: 'table_header_row table_row*' }))
  if (compatible) configureTableClipboardContent(ctx, limits)
  for (const node of [tableSchema, tableCellSchema, tableHeaderSchema]) await node.node(ctx)()
  const schema = new Schema({ nodes: { ...Object.fromEntries(ctx.get(nodesCtx)), math_inline: inlineMathSchema() }, marks: Object.fromEntries(ctx.get(marksCtx)) })
  ctx.inject(schemaCtx, schema)
  const paragraph = (content: string | ProseNode[] = '') => schema.nodes.paragraph.createChecked(null, typeof content === 'string' ? content ? schema.text(content) : [] : content)
  const table = (values: (string | ProseNode[])[][]) => schema.nodes.table.createChecked(null, values.map((row, r) => schema.nodes[r ? 'table_row' : 'table_header_row'].createChecked(null,
    row.map((value, c) => schema.nodes[r ? 'table_cell' : 'table_header'].createChecked({ alignment: c ? 'right' : 'center' }, paragraph(value))))))
  const copied = (node: ProseNode, serializer: DOMSerializer = createTableClipboardSerializer(schema)) => {
    const doc = schema.nodes.doc.createChecked(null, [node]), map = TableMap.get(node)
    const state = EditorState.create({ doc, selection: CellSelection.create(doc, 1 + map.map[0], 1 + map.map.at(-1)!) })
    const props: EditorProps = { clipboardSerializer: serializer }
    const view = { state, _props: props, props, directPlugins: [], someProp: EditorView.prototype.someProp, serializeForClipboard: EditorView.prototype.serializeForClipboard } as unknown as EditorView
    return view.serializeForClipboard(state.selection.content())
  }
  const parse = (dom: HTMLElement) => DOMParser.fromSchema(schema).parseSlice(dom, { preserveWhitespace: true })
  return { document, ctx, schema, paragraph, table, copied, parse }
}

const marker = (content: unknown, version = 1) => JSON.stringify({ version, content })
const textParagraph = (text = 'Exact\r\nvalue') => [{ type: 'paragraph', content: [{ type: 'text', text }] }]

describe('native table HTML clipboard content markers', () => {
  it('reproduces native HTML CRLF loss despite data-pm-slice and numeric references', async () => {
    const e = await editor(false), source = e.table([['Head'], [' Left\tfirst\r\nnext ']])
    const copied = e.copied(source, DOMSerializer.fromSchema(e.schema))
    expect(copied.dom.innerHTML).toContain('data-pm-slice')
    const parsed = e.parse(html(e.document, copied.dom.innerHTML))
    expect(parsed.content.firstChild!.child(1).firstChild!.textContent).toBe(' Left\tfirst next ')
    const encoded = html(e.document, '<table><tr data-is-header><th><p>Head</p></th></tr><tr><td><p>a&#xD;&#xA;b</p></td></tr></table>')
    expect(e.parse(encoded).content.firstChild!.child(1).firstChild!.textContent).toBe('a b')
    expect(DOMParser.fromSchema(e.schema).parseSlice(encoded, { preserveWhitespace: 'full' }).content.firstChild!.child(1).firstChild!.textContent).toBe('a\nb')
  })
  it.each([' 左\t右 ', '中文 ', '   ', '\t', 'a\rb\nc\r\nd', 'a \t\r\n b', '\r\n', '他说"好"|pipe '])('restores exact native quoted field %j through HTML lexer and PM DOM parser', async (value) => {
    const e = await editor(), source = e.table([[' Header ', 'Other'], [value, 'Last']]), copied = e.copied(source)
    expect(copied.dom.innerHTML).toContain(attribute)
    const parsed = e.parse(html(e.document, copied.dom.innerHTML))
    expect(parsed.content.firstChild!.eq(source)).toBe(true)
    parsed.content.firstChild!.check()
    expect(parsed.content.firstChild!.child(1).firstChild!.firstChild!.content.content.every((node) => node.isText)).toBe(true)
  })
  it('keeps native rich marks, links, inline code, math, both break types, alignment and metadata', async () => {
    const e = await editor(), s = e.schema
    const rich = [s.text(' Bold\r\ntext ', [s.marks.strong.create()]), s.text(' emphasis ', [s.marks.emphasis.create({ marker: '_' })]), s.text('strike', [s.marks.strike_through.create()]),
      s.text('pipe|code\r\n ', [s.marks.inlineCode.create()]), s.text(' Link ', [s.marks.link.create({ href: 'https://example.com/path?a=1&b=2', title: 'Title "quoted"' })]),
      s.nodes.math_inline.create({ value: 'x\r\n+y' }), s.nodes.hardbreak.create({ isInline: false }), s.nodes.hardbreak.create({ isInline: true }), s.text(' end ')]
    const source = e.table([[rich, 'Header B'], ['data', rich]]), native = e.copied(source, DOMSerializer.fromSchema(s)), copied = e.copied(source)
    const expectedDom = html(e.document, native.dom.innerHTML), markedDom = html(e.document, copied.dom.innerHTML)
    for (const tag of ['td', 'th']) for (const element of Array.from(markedDom.querySelectorAll(tag))) element.removeAttribute(attribute)
    expect(markedDom.innerHTML).toBe(expectedDom.innerHTML)
    expect(e.parse(html(e.document, copied.dom.innerHTML)).content.firstChild!.eq(source)).toBe(true)
    expect(copied.text).toBe(native.text); expect(copied.slice.eq(native.slice)).toBe(true)
  })
  it.each(['highlight', 'superscript', 'subscript', 'underline'])('keeps the actual app %s mark on quoted CRLF table header/body', async (name) => {
    const e = await editor(), value = e.schema.text(' marked \r\n text\t ', [e.schema.marks[name].create()])
    expect(e.schema.marks[name].spec.attrs).toBeUndefined()
    const source = e.table([[[value], 'Header'], ['Body', [value]]]), copied = e.copied(source)
    expect(e.parse(html(e.document, copied.dom.innerHTML)).content.firstChild!.eq(source)).toBe(true)
  })
  it('preserves nested app marks and commonmark marks in the same quoted field', async () => {
    const e = await editor(), marks = ['strong', 'highlight', 'superscript', 'subscript', 'underline'].map((name) => e.schema.marks[name].create())
    const source = e.table([[[e.schema.text(' Nested\r\nvalue ', marks)]], ['Body']]), copied = e.copied(source)
    expect(e.parse(html(e.document, copied.dom.innerHTML)).content.firstChild!.eq(source)).toBe(true)
  })
  it('leaves ordinary paragraph serialization and editor schema DOM untouched', async () => {
    const e = await editor(), para = e.paragraph(' ordinary\r\ntext '), serializer = createTableClipboardSerializer(e.schema)
    const native = DOMSerializer.fromSchema(e.schema)
    expect(new XMLSerializer().serializeToString(serializer.serializeNode(para, { document: e.document }) as never)).toBe(new XMLSerializer().serializeToString(native.serializeNode(para, { document: e.document }) as never))
    const cell = e.table([['cell']]).firstChild!.firstChild!
    expect(JSON.stringify(e.schema.nodes.table_header.spec.toDOM!(cell))).not.toContain(attribute)
  })
  it('keeps external HTML on its exact native rules', async () => {
    const e = await editor(), legacy = await editor(false)
    const source = '<table><tr><th style="text-align:right"><p> H </p></th></tr><tr><td style="text-align:center"><p> before\r\n<strong>bold</strong> after <a href="../safe.md">link</a></p></td></tr></table>'
    expect(e.parse(html(e.document, source)).toJSON()).toEqual(legacy.parse(html(legacy.document, source)).toJSON())
  })
  it.each([
    'not JSON', marker(textParagraph(), 2), JSON.stringify({ version: 1, content: textParagraph(), extra: true }), marker([]), marker([...textParagraph(), ...textParagraph()]),
    marker([{ type: 'code_block', content: [{ type: 'text', text: 'secret' }] }]), marker([{ type: 'paragraph', content: [{ type: 'paragraph', content: [] }] }]),
    marker([{ type: 'paragraph', content: [{ type: 'unknown', attrs: { value: 'secret' } }] }]),
    marker([{ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'https://example.com/a.png', alt: null, title: null } }] }]),
    marker([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'unknown' }] }] }]),
    marker([{ type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: 'yes' } }] }]),
    marker([{ type: 'paragraph', content: [{ type: 'math_inline', attrs: { value: 123 } }] }]),
    marker([{ type: 'paragraph', content: [{ type: 'text', text: 'x', attrs: { onclick: 'alert(1)' } }] }]),
    marker([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'strong' }, { type: 'strong' }] }] }]),
    marker([{ type: 'paragraph', content: null }]), marker([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: null }] }]),
    marker([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'strong', attrs: { marker: 'invalid' } }] }] }]),
  ])('rejects malformed/unsupported marker without throwing or changing native visible content: %s', async (value) => {
    const e = await editor(), dom = html(e.document, '<table><tr data-is-header><th><p>Visible header</p></th></tr><tr><td><p>Visible fallback</p></td></tr></table>')
    for (const tag of ['th', 'td']) dom.querySelector(tag)!.setAttribute(attribute, value)
    expect(tableClipboardContentFragment(value, e.schema)).toBeNull()
    expect(() => e.parse(dom)).not.toThrow()
    expect(e.parse(dom).content.firstChild!.child(1).firstChild!.textContent).toBe('Visible fallback')
    e.parse(dom).content.firstChild!.check()
  })
  it.each(['javascript:alert(1)', ' java\tscript:alert(1)', 'data:text/html,evil', 'vbscript:evil', 'file:///secret'])('does not elevate forged unsafe link %j', async (href) => {
    const e = await editor(), value = marker([{ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href, title: null } }] }] }])
    expect(tableClipboardContentFragment(value, e.schema)).toBeNull()
  })
  it.each(['../safe.md', '#anchor', '?query=1', 'https://example.com', 'mailto:a@example.com', 'tel:+123', 'ftp://example.com'])('accepts native safe link %j', async (href) => {
    const e = await editor(), value = marker([{ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href, title: null } }] }] }])
    expect(tableClipboardContentFragment(value, e.schema)?.firstChild!.firstChild!.marks[0].attrs.href).toBe(href)
  })
  it('checks marker size, inline count, invalid limits and schema-specific missing/forbidden nodes', async () => {
    const e = await editor(), value = marker(textParagraph()), limits = { ...TABLE_CLIPBOARD_LIMITS, characters: value.length }
    expect(tableClipboardContentFragment(value, e.schema, limits)).not.toBeNull()
    expect(tableClipboardContentFragment(value, e.schema, { ...limits, characters: value.length - 1 })).toBeNull()
    expect(tableClipboardContentFragment(value, e.schema, { ...limits, rows: Number.NaN })).toBeNull()
    expect(tableClipboardContentFragment(value, e.schema, {} as never)).toBeNull()
    const nodes = Array.from({ length: 4097 }, () => ({ type: 'hardbreak', attrs: { isInline: false } }))
    expect(tableClipboardContentFragment(marker([{ type: 'paragraph', content: nodes }]), e.schema)).toBeNull()
    const missing = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} } })
    expect(tableClipboardContentFragment(marker([{ type: 'paragraph', content: [{ type: 'math_inline', attrs: { value: 'x' } }] }]), missing)).toBeNull()
    expect(tableClipboardContentFragment(marker([{ type: 'paragraph', content: [{ type: 'hardbreak', attrs: { isInline: false } }] }]), missing)).toBeNull()
  })
  it('preserves a previous serializer, skips unsafe/oversized source metadata, and keeps empty cells valid', async () => {
    const e = await editor(), previous = DOMSerializer.fromSchema(e.schema)
    const custom = new DOMSerializer({ ...previous.nodes, table_header: (node) => ['th', { ...node.attrs, 'data-custom': 'retained', style: 'text-align:right' }, 0] }, previous.marks)
    const source = e.table([[''], ['']]), copied = e.copied(source, createTableClipboardSerializer(e.schema, custom))
    expect(copied.dom.querySelector('th')!.getAttribute('data-custom')).toBe('retained')
    expect(copied.dom.querySelector('th')!.getAttribute('style')).toBe('text-align:right')
    expect(tableClipboardContentFragment(copied.dom.querySelector('th')!.getAttribute(attribute), e.schema)?.firstChild!.childCount).toBe(0)
    const limited = e.copied(e.table([['Long value']]), createTableClipboardSerializer(e.schema, previous, { ...TABLE_CLIPBOARD_LIMITS, characters: 1 }))
    expect(limited.dom.querySelector('th')!.hasAttribute(attribute)).toBe(false)
    const unsafe = e.copied(e.table([[[e.schema.text('link', [e.schema.marks.link.create({ href: 'javascript:evil' })])]]]))
    expect(unsafe.dom.querySelector('th')!.hasAttribute(attribute)).toBe(false)
    expect(unsafe.dom.querySelector('a')!.getAttribute('href')).toBe('')
  })
  it('bounds total metadata per serialization, then resets the budget and isolates serializers', async () => {
    const e = await editor(), source = e.table([['Head', 'Second'], ['Body', 'Last']])
    const cap = marker(textParagraph('Second')).length
    const serializer = createTableClipboardSerializer(e.schema, undefined, { ...TABLE_CLIPBOARD_LIMITS, characters: cap })
    const copy = () => e.copied(source, serializer)
    for (const copied of [copy(), copy()]) {
      const cells = [...Array.from(copied.dom.querySelectorAll('th')), ...Array.from(copied.dom.querySelectorAll('td'))]
      const values = cells.map((cell) => cell.getAttribute(attribute)).filter((value): value is string => Boolean(value))
      expect(values).toHaveLength(1)
      expect(values.reduce((total, value) => total + value.length, 0)).toBeLessThanOrEqual(cap)
      expect(serializer.contentStatus).toEqual({ ok: false, reason: 'size-limit' })
    }
    const complete = createTableClipboardSerializer(e.schema)
    expect(e.copied(source, complete).dom.querySelector('td')!.hasAttribute(attribute)).toBe(true)
    expect(complete.contentStatus).toEqual({ ok: true })
    e.copied(e.table([['H']]), serializer)
    expect(serializer.contentStatus).toEqual({ ok: true })
  })
  it('preserves a previous DOM-valued cell serializer without mutating its element', async () => {
    const e = await editor(), native = DOMSerializer.fromSchema(e.schema), element = e.document.createElement('th')
    element.setAttribute('data-custom', 'kept')
    const previous = new DOMSerializer({ ...native.nodes, table_header: () => ({ dom: element, contentDOM: element }) }, native.marks)
    const serializer = createTableClipboardSerializer(e.schema, previous), result = e.copied(e.table([['Head']]), serializer)
    expect(result.dom.querySelector('th')!.getAttribute('data-custom')).toBe('kept')
    expect(element.hasAttribute(attribute)).toBe(false)
    expect(serializer.contentStatus).toEqual({ ok: false, reason: 'unsupported-content' })
  })
  it('reports the native fallback for actual emoji rather than claiming lossless quoted content', async () => {
    const e = await editor(), source = e.table([[[e.schema.text(' Left\r\n '), e.schema.nodes.emoji.create({ name: 'smile', value: '😄' })]]])
    const serializer = createTableClipboardSerializer(e.schema), copied = e.copied(source, serializer)
    expect(copied.dom.querySelector('th')!.hasAttribute(attribute)).toBe(false)
    expect(serializer.contentStatus).toEqual({ ok: false, reason: 'unsupported-content' })
    expect(copied.dom.querySelector('span[data-emoji]')!.getAttribute('data-emoji')).toBe('smile')
  })
  it('does not restore many individually valid markers exceeding the table-wide metadata budget', async () => {
    const value = marker(textParagraph()), e = await editor(true, { ...TABLE_CLIPBOARD_LIMITS, characters: value.length })
    const dom = html(e.document, '<table><tr data-is-header><th><p>Visible H</p></th></tr><tr><td><p>Visible B</p></td></tr></table>')
    for (const tag of ['th', 'td']) dom.querySelector(tag)!.setAttribute(attribute, value)
    const parsed = e.parse(dom).content.firstChild!
    expect(parsed.firstChild!.firstChild!.textContent).toBe('Visible H')
    expect(parsed.child(1).firstChild!.textContent).toBe('Visible B')
  })
})
