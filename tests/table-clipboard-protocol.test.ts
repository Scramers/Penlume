import { afterEach, describe, expect, it, vi } from 'vitest'
import { Clock, Container, Ctx } from '@milkdown/kit/ctx'
import { SchemaReady, editorViewCtx, editorViewOptionsCtx, parserCtx, prosePluginsCtx, remarkStringifyOptionsCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core'
import { Fragment, Schema, Slice, type Node } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { EditorView, type EditorProps } from '@milkdown/kit/prose/view'
import { CellSelection, TableMap } from '@milkdown/kit/prose/tables'
import { history, redo, undo, undoDepth } from '@milkdown/kit/prose/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { inlineCodeAttr, inlineCodeSchema, linkAttr, linkSchema, paragraphAttr, paragraphSchema, strongAttr, strongSchema } from '@milkdown/kit/preset/commonmark'
import { keepTableAlignPlugin, tableCellSchema, tableEditingPlugin, tableHeaderRowSchema, tableHeaderSchema, tableRowSchema, tableSchema } from '@milkdown/kit/preset/gfm'
import { ParserState, SerializerState } from '@milkdown/kit/transformer'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import { createTableClipboardProtocol, type TableClipboardProtocolOptions } from '../src/renderer/editor/table-clipboard-protocol'
import { parseTableTsv, TABLE_CLIPBOARD_LIMITS } from '../src/renderer/editor/table-clipboard'

afterEach(() => vi.unstubAllGlobals())
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// A minimal serialization DOM contract, not a mounted EditorView or browser.
// The actual public PM serializer creates the HTML and data-pm-slice metadata.
class SerializationNode {
  children: SerializationNode[] = []
  attributes: Record<string, string> = {}
  parent?: SerializationNode
  constructor(readonly nodeType: number, readonly nodeName: string, readonly text = '') {}
  get firstChild() { return this.children[0] ?? null }
  appendChild(node: SerializationNode) {
    if (node.nodeType === 11) { while (node.firstChild) this.appendChild(node.firstChild); return node }
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    this.children.push(node); node.parent = this; return node
  }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value) }
  setAttributeNS(_namespace: string, name: string, value: unknown) { this.setAttribute(name, value) }
  get innerHTML(): string { return this.children.map((node) => node.outerHTML).join('') }
  get outerHTML(): string { return this.nodeType === 3 ? escapeHtml(this.text) : `<${this.nodeName.toLowerCase()}${Object.entries(this.attributes).map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('')}>${this.innerHTML}</${this.nodeName.toLowerCase()}>` }
}
const serializationDocument = {
  createElement: (name: string) => new SerializationNode(1, name.toUpperCase()),
  createElementNS: (_namespace: string, name: string) => new SerializationNode(1, name.toUpperCase()),
  createTextNode: (text: string) => new SerializationNode(3, '#text', text),
  createDocumentFragment: () => new SerializationNode(11, '#document-fragment'),
  implementation: { createHTMLDocument: () => serializationDocument },
}
function clipboardEvent(text = '', html = '', type = 'paste') {
  const values = new Map([['text/plain', text], ['text/html', html]])
  const event = { type, preventDefault: vi.fn(), clipboardData: { getData: vi.fn((name: string) => values.get(name) ?? ''), clearData: vi.fn(() => values.clear()), setData: vi.fn((name: string, value: string) => values.set(name, value)) } }
  return { event: event as unknown as ClipboardEvent, raw: event, values }
}
async function editor(options: TableClipboardProtocolOptions = {}) {
  const lifecycle = new EventTarget()
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) vi.stubGlobal(name, lifecycle[name].bind(lifecycle))
  vi.stubGlobal('document', serializationDocument)
  const ctx = new Ctx(new Container(), new Clock())
  ctx.inject(remarkStringifyOptionsCtx)
  ctx.inject(paragraphAttr.key).inject(strongAttr.key).inject(linkAttr.key).inject(inlineCodeAttr.key)
  const schema = new Schema({ nodes: {
    doc: { content: 'block+', parseMarkdown: { match: (node: { type: string }) => node.type === 'root', runner: (state: ParserState, node: Parameters<ParserState['injectRoot']>[0], type: Parameters<ParserState['injectRoot']>[1]) => state.injectRoot(node, type) }, toMarkdown: { match: (node: Node) => node.type.name === 'doc', runner: (state: SerializerState, node: Node) => { state.openNode('root'); state.next(node.content) } } },
    paragraph: paragraphSchema.key._defaultValue(ctx),
    text: { group: 'inline', parseMarkdown: { match: (node: { type: string }) => node.type === 'text', runner: (state: ParserState, node: { value?: unknown }) => state.addText(String(node.value ?? '')) }, toMarkdown: { match: (node: Node) => node.type.name === 'text', runner: (state: SerializerState, node: Node) => state.addNode('text', undefined, node.text ?? '') } },
    table: { ...tableSchema.key._defaultValue(ctx), content: 'table_header_row table_row*' },
    table_header_row: tableHeaderRowSchema.key._defaultValue(ctx), table_row: tableRowSchema.key._defaultValue(ctx),
    table_header: tableHeaderSchema.key._defaultValue(ctx), table_cell: tableCellSchema.key._defaultValue(ctx),
  }, marks: { strong: strongSchema.key._defaultValue(ctx), link: linkSchema.key._defaultValue(ctx), inlineCode: inlineCodeSchema.key._defaultValue(ctx) } })
  const processor = remark().use(remarkGfm), parse = ParserState.create(schema, processor), serialize = SerializerState.create(schema, processor)
  ctx.inject(schemaCtx, schema).inject(prosePluginsCtx, []).inject(editorViewOptionsCtx, { editable: () => true }).inject(parserCtx, parse).inject(serializerCtx, serialize)
  ctx.record(SchemaReady); const ready = ctx.wait(SchemaReady); ctx.done(SchemaReady); await ready
  for (const plugin of [clipboard, keepTableAlignPlugin, tableEditingPlugin]) await plugin(ctx)()
  const paragraph = (text: string, strong = false) => schema.nodes.paragraph.create(null, text ? schema.text(text, strong ? [schema.marks.strong.create()] : []) : [])
  const table = (values = [['H1', 'H2'], ['A1', 'A2'], ['B1', 'B2']]) => schema.nodes.table.createChecked(null, values.map((row, r) => schema.nodes[r ? 'table_row' : 'table_header_row'].createChecked(null, row.map((text, c) => schema.nodes[r ? 'table_cell' : 'table_header'].create({ alignment: c ? 'center' : 'left' }, paragraph(text, text === 'A1'))))))
  let state = EditorState.create({ doc: schema.nodes.doc.create(null, [paragraph('Before'), table(), paragraph('After')]), plugins: [history(), ...ctx.get(prosePluginsCtx)] })
  let editable = true
  const dispatch = vi.fn((tr: Transaction) => { state = state.apply(tr); state.doc.check() })
  const view = { get state() { return state }, get editable() { return editable }, dispatch, props: { editable: () => editable }, _props: {}, directPlugins: [], someProp: EditorView.prototype.someProp, serializeForClipboard: EditorView.prototype.serializeForClipboard } as unknown as EditorView
  ctx.inject(editorViewCtx, view)
  const currentTable = () => { let node: Node | undefined, start = 0; state.doc.descendants((candidate, pos) => { if (!node && candidate.type.name === 'table') { node = candidate; start = pos + 1 }; return !node }); return { node: node!, start } }
  const position = (r: number, c: number) => { const t = currentTable(), map = TableMap.get(t.node); return t.start + map.map[r * map.width + c] }
  const caret = (r: number, c: number) => dispatch(state.tr.setSelection(TextSelection.create(state.doc, position(r, c) + 2)))
  const select = (ar = 1, ac = 0, hr = 2, hc = 1) => dispatch(state.tr.setSelection(CellSelection.create(state.doc, position(ar, ac), position(hr, hc))))
  const matrix = () => { const values: string[][] = []; currentTable().node.forEach((row) => { const cells: string[] = []; row.forEach((cell) => cells.push(cell.textContent)); values.push(cells) }); return values }
  const errors: unknown[] = []
  const protocol = createTableClipboardProtocol({ ...options, onError: (error) => { errors.push(error); options.onError?.(error) } })
  const paste = (text: string, slice = new Slice(Fragment.from(paragraph(text)), 1, 1), plain = true, html = '') => { const event = clipboardEvent(text, html); const processed = protocol.transformPasted(slice, view, plain); const handled = protocol.handlePaste(view, event.event, processed); return { ...event, handled, processed } }
  return { schema, state: () => state, view, dispatch, paragraph, table, currentTable, position, caret, select, matrix, protocol, paste, parse, serialize, errors, setEditable: (value: boolean) => { editable = value } }
}

describe('per-editor final paste-rule protocol', () => {
  it('uses explicit plain intent with an HTML flavor present and never reparses HTML', async () => {
    const e = await editor(); e.caret(1, 0)
    const slice = new Slice(Fragment.from(e.table([['HTML1', 'HTML2']])), 0, 0)
    const result = e.paste('Plain1\tPlain2', slice, true, '<table>HTML1</table>')
    expect(result.handled).toBe(true); expect(result.processed).toBe(slice)
    expect(e.matrix()[1]).toEqual(['Plain1', 'Plain2'])
    expect(result.raw.clipboardData.getData.mock.calls).toEqual([['text/plain']])
    const html = e.paste('Ignored1\tIgnored2', slice, false, '<table>different unprocessed HTML</table>')
    expect(html.handled).toBe(true); expect(html.raw.clipboardData.getData).not.toHaveBeenCalled()
    expect(e.matrix()[1]).toEqual(['HTML1', 'HTML2'])
  })
  it('keeps real open body fragments intact until the strict table transaction', async () => {
    const e = await editor(); e.select(2, 1, 1, 0)
    const slice = e.state().selection.content()
    expect(slice.content.firstChild!.type.name).toBe('table_row')
    const processed = e.protocol.transformPasted(slice, e.view, false)
    expect(processed).toBe(slice)
    const event = clipboardEvent('', '<table>already parsed</table>')
    expect(e.protocol.handlePaste(e.view, event.event, processed)).toBe(true)
    const selection = e.state().selection as CellSelection
    expect(selection.$anchorCell.pos).toBe(e.position(2, 1)); expect(selection.$headCell.pos).toBe(e.position(1, 0))
  })
  it('handles a rectangle through actual PM prop order before the installed Milkdown clipboard plugin', async () => {
    const e = await editor(); e.select()
    const props = (e.view as unknown as { _props: EditorProps })._props
    props.handlePaste = e.protocol.handlePaste
    const slice = new Slice(Fragment.from(e.table([['P1', 'P2'], ['P3', 'P4']])), 0, 0)
    const processed = e.protocol.transformPasted(slice, e.view, false), event = clipboardEvent('P1\tP2\nP3\tP4', '<table>processed</table>')
    expect(e.view.someProp('handlePaste', (handler) => handler(e.view, event.event, processed))).toBe(true)
    expect(e.matrix()).toEqual([['H1', 'H2'], ['P1', 'P2'], ['P3', 'P4']])
    let tables = 0; e.state().doc.descendants((node) => { if (node.type.name === 'table') { tables++; return false } })
    expect(tables).toBe(1)
  })
  it('normalizes an outside single data row then allows ordinary native insertion', async () => {
    const e = await editor()
    const row = e.table().child(1), slice = new Slice(Fragment.from(row), 1, 1)
    const result = e.paste('A1\tA2', slice, false, '<table>data only</table>')
    expect(result.handled).toBe(false)
    expect(result.processed.content.firstChild!.type.name).toBe('table')
    expect(result.processed.content.firstChild!.childCount).toBe(1)
    expect(result.processed.content.firstChild!.firstChild!.firstChild!.type.name).toBe('table_header')
    expect(e.matrix()[1]).toEqual(['A1', 'A2'])
    expect(result.raw.preventDefault).not.toHaveBeenCalled()
  })
  it.each(['malformed', 'merged', 'multiple', 'mixed', 'oversized'])('consumes a recognized %s grid without mutation or native fallback', async (kind) => {
    const rejected = vi.fn(), e = await editor({ onRejected: rejected }); e.caret(1, 0)
    const before = e.state().doc
    const table = e.table(), merged = e.schema.nodes.table_cell.create({ colspan: 1_000_000_000 }, e.paragraph('Merged'))
    const source = kind === 'merged' ? new Slice(Fragment.from(merged), 0, 0) : kind === 'multiple' ? new Slice(Fragment.from([table, table]), 0, 0) : kind === 'mixed' ? new Slice(Fragment.from([e.paragraph('prefix'), table]), 0, 0) : undefined
    const result = e.paste(kind === 'malformed' ? '"bad\tx' : kind === 'oversized' ? Array(51).fill('x').join('\t') : '', source, !source, source ? '<table>processed</table>' : '')
    expect(result.handled).toBe(true); expect(result.raw.preventDefault).toHaveBeenCalledOnce()
    expect(rejected).toHaveBeenCalledOnce(); expect(e.state().doc.eq(before)).toBe(true)
  })
  it('isolates factories and clears intent after use, reset, changed state or changed slice identity', async () => {
    const a = await editor(), b = await editor(); a.caret(1, 0); b.caret(1, 0)
    const scalar = new Slice(Fragment.from(a.paragraph('ordinary')), 1, 1)
    const processed = a.protocol.transformPasted(scalar, a.view, true)
    const event = clipboardEvent('a\tb')
    expect(b.protocol.handlePaste(a.view, event.event, processed)).toBe(false)
    expect(a.protocol.handlePaste(a.view, event.event, processed)).toBe(true)
    const once = a.state().doc
    expect(a.protocol.handlePaste(a.view, event.event, processed)).toBe(true)
    expect(a.state().doc).toBe(once) // Consumed while the resulting CellSelection is active.
    expect(b.matrix()[1]).toEqual(['A1', 'A2'])
    const html = new Slice(Fragment.from(a.table()), 0, 0), before = a.state().doc
    a.protocol.transformPasted(html, a.view, false); a.protocol.reset()
    expect(a.protocol.handlePaste(a.view, clipboardEvent().event, html)).toBe(true)
    a.protocol.transformPasted(html, a.view, false); a.caret(2, 0)
    expect(a.protocol.handlePaste(a.view, clipboardEvent().event, html)).toBe(true)
    a.protocol.transformPasted(html, a.view, false)
    expect(a.protocol.handlePaste(a.view, clipboardEvent().event, new Slice(html.content, 0, 0))).toBe(true)
    expect(a.state().doc.eq(before)).toBe(true)
  })
  it('passes ordinary paragraph paste and inline-code caret paste through without a boundary', async () => {
    const boundary = vi.fn(), e = await editor({ historyBoundary: boundary }); e.caret(1, 0)
    expect(e.paste('ordinary prose').handled).toBe(false)
    e.dispatch(e.state().tr.setStoredMarks([e.schema.marks.inlineCode.create()]))
    expect(e.paste('a\tb').handled).toBe(false)
    expect(boundary).not.toHaveBeenCalled()
    e.select(); e.setEditable(false)
    expect(e.paste('a\tb').handled).toBe(false)
  })
  it('preserves quoted Tab, CRLF, quote and pipe within the same cell through actual GFM Markdown save/reopen', async () => {
    const e = await editor(); e.caret(1, 0)
    const text = 'tab\tinside\r\nnext "quote"|pipe'
    expect(e.paste('"tab\tinside\r\nnext ""quote""|pipe"\tsecond').handled).toBe(true)
    const markdown = e.serialize(e.state().doc), reopened = e.parse(markdown)
    expect(markdown).toContain('&#xD;'); expect(markdown).toContain('&#xA;'); expect(markdown).toContain('\\|pipe')
    expect(reopened.eq(e.state().doc)).toBe(true)
    let tables = 0; reopened.descendants((node) => { if (node.type.name === 'table') { tables++; expect(node.child(1).child(0).textContent).toBe(text); expect(node.child(1).child(1).textContent).toBe('second'); return false } })
    expect(tables).toBe(1)
  })
})

describe('CellSelection clipboard copy/cut and history boundaries', () => {
  it('uses actual PM public serialization for HTML metadata/rich content and replaces only the plain flavor with TSV', async () => {
    const e = await editor(); e.select(2, 1, 1, 0)
    const before = e.state().doc, event = clipboardEvent('', '', 'copy')
    expect(e.protocol.handleDOMEvents.copy(e.view, event.event)).toBe(true)
    expect(e.errors).toEqual([])
    expect(event.values.get('text/html')).toContain('data-pm-slice="1 1 -2 []"')
    expect(event.values.get('text/html')).toContain('<strong>A1</strong>')
    expect(event.values.get('text/html')).toContain('text-align: center')
    expect(parseTableTsv(event.values.get('text/plain')!)).toEqual({ ok: true, value: [['A1', 'A2'], ['B1', 'B2']] })
    expect(event.raw.preventDefault).toHaveBeenCalledOnce(); expect(e.state().doc).toBe(before)
  })
  it('cuts exactly one rectangle with a single replacement and one undo, retaining headers and rich content on undo', async () => {
    const cleanup = vi.fn(), boundary = vi.fn(() => cleanup), e = await editor({ historyBoundary: boundary })
    e.select(0, 0, 1, 1)
    const before = e.state().doc, event = clipboardEvent('', '', 'cut'), dispatchCount = e.dispatch.mock.calls.length
    expect(e.protocol.handleDOMEvents.cut(e.view, event.event)).toBe(true)
    expect(e.errors).toEqual([])
    expect(e.matrix()).toEqual([['', ''], ['', ''], ['B1', 'B2']])
    expect(e.currentTable().node.firstChild!.type.name).toBe('table_header_row')
    expect(e.dispatch.mock.calls[dispatchCount][0].steps).toHaveLength(1)
    expect(e.dispatch.mock.calls[dispatchCount][0].getMeta('uiEvent')).toBe('cut')
    expect(undoDepth(e.state())).toBe(1); expect(boundary).toHaveBeenCalledWith(e.view, 'cut'); expect(cleanup).toHaveBeenCalledOnce()
    expect(undo(e.state(), e.dispatch)).toBe(true); expect(e.state().doc.eq(before)).toBe(true)
    expect(redo(e.state(), e.dispatch)).toBe(true); expect(e.matrix()[0]).toEqual(['', ''])
  })
  it('allows read-only copy, declines read-only cut and does not handle ordinary selections', async () => {
    const e = await editor(); e.caret(1, 0)
    expect(e.protocol.handleDOMEvents.copy(e.view, clipboardEvent().event)).toBe(false)
    expect(e.protocol.handleDOMEvents.cut(e.view, clipboardEvent().event)).toBe(false)
    e.select(); e.setEditable(false)
    const before = e.state().doc
    expect(e.protocol.handleDOMEvents.copy(e.view, clipboardEvent().event)).toBe(true)
    expect(e.protocol.handleDOMEvents.cut(e.view, clipboardEvent().event)).toBe(false)
    expect(e.state().doc).toBe(before)
  })
  it('does not delete on clipboard write/serialization failure or unsupported copy size', async () => {
    const errors = vi.fn(), e = await editor({ onError: errors }); e.select()
    const before = e.state().doc, event = clipboardEvent()
    event.raw.clipboardData.setData.mockImplementation(() => { throw new Error('Clipboard denied') })
    expect(e.protocol.handleDOMEvents.cut(e.view, event.event)).toBe(true)
    expect(e.state().doc).toBe(before); expect(errors).toHaveBeenCalledOnce()
    e.view.serializeForClipboard = () => { throw new Error('Serializer failed') }
    expect(e.protocol.handleDOMEvents.cut(e.view, clipboardEvent().event)).toBe(true)
    expect(e.state().doc).toBe(before); expect(errors).toHaveBeenCalledTimes(2)
    const tiny = createTableClipboardProtocol({ limits: { ...TABLE_CLIPBOARD_LIMITS, cells: 1 } })
    expect(tiny.handleDOMEvents.cut(e.view, clipboardEvent().event)).toBe(true)
    expect(e.state().doc).toBe(before)
  })
  it.each(['copy', 'cut'] as const)('rejects %s before clipboard writes or deletion when lossless serialization fails', async (operation) => {
    for (const reason of ['size-limit', 'unsupported-shape'] as const) {
      const rejected = vi.fn(), boundary = vi.fn(), e = await editor({ serializationRejection: () => reason, onRejected: rejected, historyBoundary: boundary })
      e.select()
      const before = e.state().doc, event = clipboardEvent('original clipboard', '<b>original clipboard</b>', operation)
      expect(e.protocol.handleDOMEvents[operation](e.view, event.event)).toBe(true)
      expect(event.raw.clipboardData.clearData).not.toHaveBeenCalled()
      expect(event.raw.clipboardData.setData).not.toHaveBeenCalled()
      expect(e.state().doc).toBe(before)
      expect(undoDepth(e.state())).toBe(0)
      expect(boundary).not.toHaveBeenCalled()
      expect(rejected).toHaveBeenCalledWith(reason)
      expect(e.errors).toEqual([])
    }
  })
  it('separates subsequent typing and guarantees optional application cleanup after a dispatch error', async () => {
    const cleanup = vi.fn(), boundary = vi.fn(() => cleanup), errors = vi.fn(), e = await editor({ historyBoundary: boundary, onError: errors })
    e.caret(1, 0); const before = e.state().doc
    e.paste('a\tb'); const pasted = e.state().doc
    e.dispatch(e.state().tr.setSelection(TextSelection.create(e.state().doc, e.position(1, 0) + 3)).insertText('!'))
    expect(undo(e.state(), e.dispatch)).toBe(true); expect(e.state().doc.eq(pasted)).toBe(true)
    expect(undo(e.state(), e.dispatch)).toBe(true); expect(e.state().doc.eq(before)).toBe(true)
    expect(boundary).toHaveBeenCalledWith(e.view, 'paste'); expect(cleanup).toHaveBeenCalledOnce()
    e.caret(1, 0)
    e.dispatch.mockImplementationOnce(() => { throw new Error('Dispatch failed') })
    expect(e.paste('c\td').handled).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(2); expect(errors).toHaveBeenCalledOnce(); expect(e.state().doc.eq(before)).toBe(true)
  })
})
