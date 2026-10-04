import { afterEach, describe, expect, it, vi } from 'vitest'
import { Clock, Container, Ctx } from '@milkdown/kit/ctx'
import { SchemaReady, editorViewCtx, editorViewOptionsCtx, parserCtx, prosePluginsCtx, remarkStringifyOptionsCtx, schemaCtx } from '@milkdown/kit/core'
import { Fragment, Schema, Slice, type Node } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { CellSelection, TableMap, handlePaste as nativeTablePaste, selectedRect } from '@milkdown/kit/prose/tables'
import { closeHistory, history, redo, undo, undoDepth } from '@milkdown/kit/prose/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { trailingConfig, trailingPlugin } from '@milkdown/kit/plugin/trailing'
import { inlineCodeSchema, linkSchema, paragraphSchema, strongSchema } from '@milkdown/kit/preset/commonmark'
import { keepTableAlignPlugin, tableCellSchema, tableEditingPlugin, tableHeaderRowSchema, tableHeaderSchema, tableRowSchema, tableSchema } from '@milkdown/kit/preset/gfm'
import { ParserState, SerializerState } from '@milkdown/kit/transformer'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import { parseTableTsv, serializeTableTsv, tableGridFromSlice, normalizeTableClipboardSlice, tablePasteTransaction, tableSelectionTsv, TABLE_CLIPBOARD_LIMITS, validTableClipboardDimensions, type TableClipboardResult } from '../src/renderer/editor/table-clipboard'

afterEach(() => vi.unstubAllGlobals())
function value<T>(result: TableClipboardResult<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.reason); return result.value }

async function editor(values = [['H1', 'H2', 'H3'], ['A1', 'A2', 'A3'], ['B1', 'B2', 'B3']], surrounding = true) {
  const lifecycle = new EventTarget()
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) vi.stubGlobal(name, lifecycle[name].bind(lifecycle))
  const ctx = new Ctx(new Container(), new Clock())
  ctx.inject(remarkStringifyOptionsCtx)
  const schema = new Schema({ nodes: {
    doc: { content: 'block+', parseMarkdown: { match: (node: { type: string }) => node.type === 'root', runner: (state: ParserState, node: Parameters<ParserState['injectRoot']>[0], type: Parameters<ParserState['injectRoot']>[1]) => state.injectRoot(node, type) }, toMarkdown: { match: (node: Node) => node.type.name === 'doc', runner: (state: SerializerState, node: Node) => { state.openNode('root'); state.next(node.content) } } },
    paragraph: paragraphSchema.key._defaultValue(ctx),
    text: { group: 'inline', parseMarkdown: { match: (node: { type: string }) => node.type === 'text', runner: (state: ParserState, node: { value?: unknown }) => state.addText(String(node.value ?? '')) }, toMarkdown: { match: (node: Node) => node.type.name === 'text', runner: (state: SerializerState, node: Node) => state.addNode('text', undefined, node.text ?? '') } },
    table: { ...tableSchema.key._defaultValue(ctx), content: 'table_header_row table_row*' },
    table_header_row: tableHeaderRowSchema.key._defaultValue(ctx), table_row: tableRowSchema.key._defaultValue(ctx),
    table_header: tableHeaderSchema.key._defaultValue(ctx), table_cell: tableCellSchema.key._defaultValue(ctx),
  }, marks: { strong: strongSchema.key._defaultValue(ctx), link: linkSchema.key._defaultValue(ctx), inlineCode: inlineCodeSchema.key._defaultValue(ctx) } })
  const processor = remark().use(remarkGfm), parse = ParserState.create(schema, processor), serialize = SerializerState.create(schema, processor)
  ctx.inject(schemaCtx, schema).inject(prosePluginsCtx, []).inject(trailingConfig.key).inject(editorViewOptionsCtx, { editable: () => true }).inject(parserCtx, parse)
  ctx.record(SchemaReady); const ready = ctx.wait(SchemaReady); ctx.done(SchemaReady); await ready
  // Actual Milkdown plugins, including appendTransaction. state.apply runs these hooks.
  for (const plugin of [trailingPlugin, clipboard, keepTableAlignPlugin, tableEditingPlugin]) await plugin(ctx)()
  const paragraph = (text = '') => schema.nodes.paragraph.create(null, text ? schema.text(text) : [])
  const table = (matrix: (string | Node)[][] = values, alignments = ['left', 'center', 'right']) => schema.nodes.table.createChecked(null, matrix.map((row, r) => schema.nodes[r ? 'table_row' : 'table_header_row'].createChecked(null, row.map((text, c) => typeof text === 'string' ? schema.nodes[r ? 'table_cell' : 'table_header'].createChecked({ alignment: alignments[c] ?? 'left' }, paragraph(text)) : text))))
  const doc = schema.nodes.doc.create(null, surrounding ? [paragraph('Before'), table(), paragraph('After')] : table())
  let state = EditorState.create({ doc, plugins: [history(), ...ctx.get(prosePluginsCtx)] })
  const dispatch = (tr: Transaction) => { state = state.apply(tr); state.doc.check() }
  const currentTable = () => { let node: Node | null = null, start = 0; state.doc.descendants((candidate, pos) => { if (!node && candidate.type.name === 'table') { node = candidate; start = pos + 1 }; return !node }); if (!node) throw new Error('Missing table'); return { node: node as Node, start } }
  const cellPosition = (row: number, column: number) => { const current = currentTable(); return current.start + TableMap.get(current.node).map[row * current.node.firstChild!.childCount + column] }
  const caret = (row: number, column: number, offset = 2) => dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPosition(row, column) + offset)))
  const select = (ar: number, ac: number, hr: number, hc: number) => dispatch(state.tr.setSelection(CellSelection.create(state.doc, cellPosition(ar, ac), cellPosition(hr, hc))))
  const matrix = () => fragment(currentTable().node.content).map((row) => fragment(row.content).map((cell) => cell.textContent))
  const view = { get state() { return state }, dispatch, editable: true, props: { editable: () => true } } as unknown as EditorView
  ctx.inject(editorViewCtx, view)
  const paste = (input: Parameters<typeof tablePasteTransaction>[1], afterBoundary = true) => { const tr = value(tablePasteTransaction(state, input)); dispatch(closeHistory(tr)); if (afterBoundary) dispatch(closeHistory(state.tr).setMeta('addToHistory', false)); return tr }
  const selectionAddresses = () => { const selection = state.selection as CellSelection, rect = selectedRect(state); return [rect.map.findCell(selection.$anchorCell.pos - rect.tableStart), rect.map.findCell(selection.$headCell.pos - rect.tableStart)].map((cell) => [cell.top, cell.left]) }
  return { ctx, schema, parse, serialize, paragraph, table, state: () => state, dispatch, currentTable, cellPosition, caret, select, matrix, view, paste, selectionAddresses }
}
function fragment(content: Fragment): Node[] { const nodes: Node[] = []; content.forEach((node) => nodes.push(node)); return nodes }
function copied(table: Node, ar: number, ac: number, hr: number, hc: number): Slice {
  const doc = table.type.schema.nodes.doc.create(null, table), map = TableMap.get(table)
  return CellSelection.create(doc, 1 + map.map[ar * map.width + ac], 1 + map.map[hr * map.width + hc]).content()
}

describe('strict TSV clipboard values', () => {
  it.each([
    ['a\tb\r\n', [['a', 'b']]], ['a\t\r\n', [['a', '']]], ['a\tb\r\n\t\r\n', [['a', 'b'], ['', '']]],
    ['"a\tb"\t"line1\nline2"\r\n"a""b"\t 中文🙂 ', [['a\tb', 'line1\nline2'], ['a"b', ' 中文🙂 ']]],
    ['"a\r\nb"\tc', [['a\r\nb', 'c']]],
  ] as const)('preserves quoted values and deliberate empty cells in %s', (text, expected) => {
    const rows = value(parseTableTsv(text))
    expect(rows).toEqual(expected)
    expect(value(parseTableTsv(value(serializeTableTsv(rows)), { allowSingleColumn: true }))).toEqual(expected)
  })
  it('distinguishes literal prose, single-column selection data and an explicit empty final row', () => {
    expect(parseTableTsv('ordinary paragraph')).toEqual({ ok: false, reason: 'not-grid' })
    expect(parseTableTsv('"quoted\ttab"')).toEqual({ ok: false, reason: 'not-grid' })
    expect(value(parseTableTsv('a\nb', { allowSingleColumn: true }))).toEqual([['a'], ['b']])
    const encoded = value(serializeTableTsv([['a'], ['']]))
    expect(encoded).toBe('a\r\n""')
    expect(value(parseTableTsv(encoded, { allowSingleColumn: true }))).toEqual([['a'], ['']])
    expect(value(parseTableTsv('', { allowSingleColumn: true }))).toEqual([['']])
  })
  it.each(['"open\tvalue', 'bad"quote\tx', '"closed"suffix\tx', '"closed" \tx'])('rejects malformed quoting without returning a partial grid: %s', (text) => {
    expect(parseTableTsv(text)).toEqual({ ok: false, reason: 'invalid-tsv' })
  })
  it('rejects ragged, oversized and invalid dimensions before constructing cells', () => {
    expect(parseTableTsv('a\tb\nc')).toEqual({ ok: false, reason: 'irregular-grid' })
    expect(serializeTableTsv([['a', 'b'], ['c']])).toEqual({ ok: false, reason: 'irregular-grid' })
    expect(parseTableTsv('a\tb', { limits: { ...TABLE_CLIPBOARD_LIMITS, characters: 2 } })).toEqual({ ok: false, reason: 'size-limit' })
    expect(serializeTableTsv([['"']], { ...TABLE_CLIPBOARD_LIMITS, characters: 3 })).toEqual({ ok: false, reason: 'size-limit' })
    expect(parseTableTsv(Array(51).fill('a').join('\t'))).toEqual({ ok: false, reason: 'size-limit' })
    expect(parseTableTsv('a\tb\tc\nd\te\nf', { limits: { ...TABLE_CLIPBOARD_LIMITS, cells: 4 } })).toEqual({ ok: false, reason: 'size-limit' })
    for (const [rows, columns] of [[0, 1], [1, 0], [-1, 2], [Infinity, 1], [1, NaN], [1.5, 2], [Number.MAX_SAFE_INTEGER + 1, 1], [41, 50]]) expect(validTableClipboardDimensions(rows, columns)).toBe(false)
    expect(validTableClipboardDimensions(40, 50)).toBe(true)
  })
})

describe('actual GFM clipboard slices and header normalization', () => {
  it('reads real open body, cross-header, full-table and single-cell selection slices', async () => {
    const e = await editor(), table = e.currentTable().node
    for (const [ar, ac, hr, hc, width, height] of [[1, 0, 2, 1, 2, 2], [0, 0, 1, 1, 2, 2], [0, 0, 2, 2, 3, 3], [1, 1, 1, 1, 1, 1]]) {
      const slice = copied(table, ar, ac, hr, hc)
      expect(slice.openStart).toBe(1); expect(slice.openEnd).toBe(1)
      const grid = value(tableGridFromSlice(slice))
      expect(grid).toMatchObject({ width, height })
      expect(grid.cells[0][0].eq(table.child(ar).child(ac))).toBe(true)
      if (slice.content.firstChild?.type.name !== 'table') expect(value(normalizeTableClipboardSlice(slice, e.schema, { insideTable: true, isPlainText: false }))).toBe(slice)
    }
  })
  it('promotes a sole no-th HTML data row without adding an empty row and retains rich content', async () => {
    const e = await editor()
    const content = e.paragraph('Only|data').copy(Fragment.from(e.schema.text('Only|data', [e.schema.marks.strong.create()])))
    const sourceCell = e.schema.nodes.table_cell.create({ alignment: 'right' }, content)
    const source = e.schema.nodes.table.create(null, [e.schema.nodes.table_header_row.create(), e.schema.nodes.table_row.create(null, [sourceCell])])
    const normalized = value(normalizeTableClipboardSlice(new Slice(Fragment.from(source), 0, 0), e.schema, { insideTable: false, isPlainText: false }))
    const table = normalized.content.firstChild!
    expect(table.childCount).toBe(1)
    expect(table.firstChild!.firstChild!.type.name).toBe('table_header')
    expect(table.firstChild!.firstChild!.content.eq(sourceCell.content)).toBe(true)
    expect(table.firstChild!.firstChild!.attrs.alignment).toBe('right')
    const doc = e.schema.nodes.doc.create(null, table)
    expect(e.parse(e.serialize(doc)).eq(doc)).toBe(true)
  })
  it('coalesces an outside-table cross-header row fragment and promotes an outside single body row', async () => {
    const e = await editor(), table = e.currentTable().node
    const crossing = copied(table, 0, 0, 1, 1)
    const fixed = value(normalizeTableClipboardSlice(crossing, e.schema, { insideTable: false, isPlainText: false }))
    expect(fixed.content.childCount).toBe(1)
    expect(fixed.content.firstChild!.childCount).toBe(2)
    const body = copied(table, 1, 0, 1, 1)
    const single = value(normalizeTableClipboardSlice(body, e.schema, { insideTable: false, isPlainText: false })).content.firstChild!
    expect(single.childCount).toBe(1)
    expect(single.firstChild!.child(0).content.eq(table.child(1).child(0).content)).toBe(true)
    expect(value(normalizeTableClipboardSlice(body, e.schema, { insideTable: false, isPlainText: true }))).toBe(body)
  })
  it('rejects merged, mixed, multiple-table and partial-deep shapes without silently truncating content', async () => {
    const e = await editor(), table = e.currentTable().node
    const merged = e.schema.nodes.table_header.create({ colspan: 1_000_000_000 }, e.paragraph('Merged'))
    expect(tableGridFromSlice(new Slice(Fragment.from(merged), 0, 0))).toEqual({ ok: false, reason: 'merged-cells' })
    for (const slice of [new Slice(Fragment.from([table, table]), 0, 0), new Slice(Fragment.from([e.paragraph('Before'), table]), 0, 0), new Slice(Fragment.from([table.firstChild!, table]), 1, 1), new Slice(Fragment.from(table), 3, 3)]) expect(tableGridFromSlice(slice)).toEqual({ ok: false, reason: 'unsupported-shape' })
    expect(tableGridFromSlice(new Slice(Fragment.from(e.paragraph('plain')), 1, 1))).toEqual({ ok: false, reason: 'not-grid' })
  })
  it('preflights total cells and rejects inconsistent row dimensions or later header rows', async () => {
    const e = await editor(), table = e.currentTable().node
    expect(tableGridFromSlice(new Slice(Fragment.from(table), 0, 0), { ...TABLE_CLIPBOARD_LIMITS, cells: 8 })).toEqual({ ok: false, reason: 'size-limit' })
    const short = e.schema.nodes.table_row.create(null, table.child(1).child(0))
    expect(tableGridFromSlice(new Slice(Fragment.from([table.child(1), short]), 1, 1))).toEqual({ ok: false, reason: 'irregular-grid' })
    expect(tableGridFromSlice(new Slice(Fragment.from([table.child(1), table.child(0)]), 1, 1))).toEqual({ ok: false, reason: 'unsupported-shape' })
    expect(tableGridFromSlice(new Slice(Fragment.from([table.child(0), table.child(0)]), 1, 1))).toEqual({ ok: false, reason: 'unsupported-shape' })
  })
})

describe('one strict-schema table paste transaction', () => {
  it('replaces a body rectangle where the native table handler throws, with actual plugin append hooks active', async () => {
    const e = await editor(), source = new Slice(Fragment.from(e.table([['P1', 'P2'], ['P3', 'P4']])), 0, 0)
    e.caret(1, 0)
    const before = e.state().doc
    expect(() => nativeTablePaste(e.view, {} as ClipboardEvent, source)).toThrow(RangeError)
    expect(e.state().doc.eq(before)).toBe(true)
    const tr = e.paste({ isPlainText: false, slice: source })
    expect(tr.steps).toHaveLength(1)
    expect(e.matrix()).toEqual([['H1', 'H2', 'H3'], ['P1', 'P2', 'A3'], ['P3', 'P4', 'B3']])
    expect(e.state().doc.firstChild!.textContent).toBe('Before'); expect(e.state().doc.lastChild!.textContent).toBe('After')
    expect(e.currentTable().node.child(1).child(0).type.name).toBe('table_cell')
    expect(e.selectionAddresses()).toEqual([[1, 0], [2, 1]])
    expect(e.state().plugins.filter((plugin) => plugin.spec.appendTransaction).length).toBeGreaterThanOrEqual(3)
    expect(e.parse(e.serialize(e.state().doc)).eq(e.state().doc)).toBe(true)
  })
  it('avoids the actual Milkdown clipboard rectangle split rather than relying on schema check alone', async () => {
    const e = await editor(), source = new Slice(Fragment.from(e.table([['P1', 'P2'], ['P3', 'P4']])), 0, 0)
    e.select(1, 0, 2, 1)
    const original = e.state()
    const event = { clipboardData: { getData: (type: string) => type === 'text/html' ? '<table>HTML already parsed</table>' : type === 'text/plain' ? 'P1\tP2\nP3\tP4' : '' } } as unknown as ClipboardEvent
    const plugin = clipboard.plugin()
    expect(plugin.props.handlePaste!.call(plugin, e.view, event, source)).toBe(true)
    let legacyTables = 0; e.state().doc.descendants((node) => { if (node.type.name === 'table') { legacyTables++; return false } })
    expect(legacyTables).toBeGreaterThan(1)
    const fixed = original.apply(value(tablePasteTransaction(original, { isPlainText: false, slice: source })))
    fixed.doc.check()
    let tables = 0; fixed.doc.descendants((node) => { if (node.type.name === 'table') { tables++; return false } })
    expect(tables).toBe(1)
  })
  it('grows a header-only table into strict body rows and columns, preserving destination and new-column alignment', async () => {
    const e = await editor([['Only']], false)
    e.caret(0, 0)
    const source = new Slice(Fragment.from(e.table([['Header|A', 'Header B'], ['Body A', 'Body B']], ['right', 'center'])), 0, 0)
    e.paste({ isPlainText: false, slice: source })
    expect(e.matrix()).toEqual([['Header|A', 'Header B'], ['Body A', 'Body B']])
    const table = e.currentTable().node
    expect(table.child(0).type.name).toBe('table_header_row'); expect(table.child(1).type.name).toBe('table_row')
    table.forEach((row, _offset, r) => row.forEach((cell, _offset, c) => { expect(cell.type.name).toBe(r ? 'table_cell' : 'table_header'); expect(cell.attrs.alignment).toBe(c ? 'center' : 'left') }))
    expect(e.state().doc.lastChild!.type.name).toBe('paragraph') // actual trailingPlugin appendTransaction
    const reopened = EditorState.create({ doc: e.parse(e.serialize(e.state().doc)), plugins: e.state().plugins })
    // The Markdown parser omits the editor's empty final caret paragraph; the
    // actual trailing plugin restores it on the next transaction.
    expect(reopened.apply(reopened.tr).doc.eq(e.state().doc)).toBe(true)
  })
  it('tiles and clips selected rectangles while retaining reverse endpoints and rich unselected cells', async () => {
    const e = await editor()
    const untouchedPos = e.cellPosition(2, 2)
    e.dispatch(e.state().tr.addMark(untouchedPos + 2, untouchedPos + 4, e.schema.marks.strong.create()))
    const untouched = e.currentTable().node.child(2).child(2)
    e.select(2, 1, 1, 0)
    const source = copied(e.table([['ignored header'], ['**literal**|pipe']]), 1, 0, 1, 0)
    e.paste({ isPlainText: false, slice: source })
    expect(e.matrix()).toEqual([['H1', 'H2', 'H3'], ['**literal**|pipe', '**literal**|pipe', 'A3'], ['**literal**|pipe', '**literal**|pipe', 'B3']])
    expect(e.selectionAddresses()).toEqual([[2, 1], [1, 0]])
    expect(e.currentTable().node.child(2).child(2).eq(untouched)).toBe(true)
    e.paste({ isPlainText: true, text: 'A\tB\tC\nD\tE\tF\nG\tH\tI' })
    expect(e.matrix().slice(1).map((row) => row.slice(0, 2))).toEqual([['A', 'B'], ['D', 'E']])
    expect(e.currentTable().node.firstChild!.childCount).toBe(3)
  })
  it('retains rich HTML content and treats explicitly plain TSV as literal text, including source-safe newlines', async () => {
    const e = await editor()
    const rich = e.schema.nodes.table_header.create({ alignment: 'right' }, e.schema.nodes.paragraph.create(null, [e.schema.text('Strong|', [e.schema.marks.strong.create()]), e.schema.text('Link', [e.schema.marks.link.create({ href: 'https://example.com', title: '中文' })]), e.schema.text('x|y', [e.schema.marks.inlineCode.create()])]))
    e.select(0, 0, 1, 0)
    e.paste({ isPlainText: false, slice: new Slice(Fragment.from(rich), 0, 0) })
    for (const r of [0, 1]) expect(e.currentTable().node.child(r).child(0).content.eq(rich.content)).toBe(true)
    expect(e.currentTable().node.child(1).child(0).type.name).toBe('table_cell')
    e.paste({ isPlainText: true, text: '"literal **bold**|\nline2"' })
    expect(e.currentTable().node.child(1).child(0).firstChild!.firstChild!.marks).toEqual([])
    expect(e.parse(e.serialize(e.state().doc)).eq(e.state().doc)).toBe(true)
  })
  it('fills a CellSelection from scalar HTML but declines ordinary prose and inline-code caret paste', async () => {
    const e = await editor()
    e.caret(1, 0)
    expect(tablePasteTransaction(e.state(), { isPlainText: true, text: 'plain text' })).toEqual({ ok: false, reason: 'not-grid' })
    e.dispatch(e.state().tr.setStoredMarks([e.schema.marks.inlineCode.create()]))
    expect(tablePasteTransaction(e.state(), { isPlainText: true, text: 'a\tb' })).toEqual({ ok: false, reason: 'not-grid' })
    e.select(1, 0, 2, 1)
    const paragraph = e.schema.nodes.paragraph.create(null, e.schema.text('scalar', [e.schema.marks.strong.create()]))
    e.paste({ isPlainText: false, slice: new Slice(Fragment.from(paragraph), 1, 1) })
    expect(e.matrix().slice(1).map((row) => row.slice(0, 2))).toEqual([['scalar', 'scalar'], ['scalar', 'scalar']])
    expect(e.currentTable().node.child(1).child(0).firstChild!.firstChild!.marks[0].type.name).toBe('strong')
  })
  it('rejects unsafe source, growth and selected-area sizes with no transaction or partial document mutation', async () => {
    const e = await editor()
    e.caret(2, 2)
    const before = e.state().doc
    for (const input of [{ isPlainText: true as const, text: '"bad\tdata' }, { isPlainText: false as const, slice: new Slice(Fragment.from([e.table(), e.table()]), 0, 0) }]) expect(tablePasteTransaction(e.state(), input).ok).toBe(false)
    expect(tablePasteTransaction(e.state(), { isPlainText: true, text: 'a\tb\nc\td' }, { ...TABLE_CLIPBOARD_LIMITS, rows: 3, columns: 3 })).toEqual({ ok: false, reason: 'size-limit' })
    e.select(0, 0, 2, 2)
    expect(tablePasteTransaction(e.state(), { isPlainText: true, text: 'scalar' }, { ...TABLE_CLIPBOARD_LIMITS, cells: 4 })).toEqual({ ok: false, reason: 'size-limit' })
    expect(e.state().doc.eq(before)).toBe(true)
  })
  it('allows a small overwrite in an existing larger table and makes an identical paste a document no-op', async () => {
    const e = await editor([['H'], ['1'], ['2'], ['3']])
    e.select(3, 0, 3, 0)
    const limits = { ...TABLE_CLIPBOARD_LIMITS, rows: 1, columns: 1, cells: 1 }
    const tr = value(tablePasteTransaction(e.state(), { isPlainText: true, text: '3' }, limits))
    expect(tr.docChanged).toBe(false); expect(tr.steps).toHaveLength(0)
    expect(value(tablePasteTransaction(e.state(), { isPlainText: true, text: 'changed' }, limits)).steps).toHaveLength(1)
    expect(e.matrix()).toEqual([['H'], ['1'], ['2'], ['3']])
  })
  it('rejects outside, cross-cell, merged and foreign-schema targets or sources without dispatch', async () => {
    const e = await editor(), other = await editor()
    const input = { isPlainText: true as const, text: 'a\tb' }
    e.dispatch(e.state().tr.setSelection(TextSelection.create(e.state().doc, 1)))
    expect(tablePasteTransaction(e.state(), input)).toEqual({ ok: false, reason: 'not-table' })
    const crossing = EditorState.create({ doc: e.state().doc, selection: TextSelection.create(e.state().doc, e.cellPosition(1, 0) + 2, e.cellPosition(1, 1) + 2) })
    expect(tablePasteTransaction(crossing, input)).toEqual({ ok: false, reason: 'invalid-target' })
    e.caret(1, 0)
    const before = e.state().doc
    expect(tablePasteTransaction(e.state(), { isPlainText: false, slice: new Slice(Fragment.from(other.table()), 0, 0) })).toEqual({ ok: false, reason: 'invalid-schema' })
    expect(normalizeTableClipboardSlice(new Slice(Fragment.from(other.table()), 0, 0), e.schema, { insideTable: false, isPlainText: false })).toEqual({ ok: false, reason: 'invalid-schema' })
    expect(e.state().doc.eq(before)).toBe(true)
    const merged = e.table([['H'], ['Body']])
    const cell = merged.child(1).child(0)
    const bad = merged.copy(Fragment.from([merged.child(0), merged.child(1).copy(Fragment.from(cell.type.create({ ...cell.attrs, colspan: 1_000_000_000 }, cell.content)))]))
    const doc = e.schema.nodes.doc.create(null, bad)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1 + merged.child(0).nodeSize + 3) })
    expect(tablePasteTransaction(state, input)).toEqual({ ok: false, reason: 'merged-cells' })
    expect(state.doc).toBe(doc)
  })
  it.each([false, true])('requires the after-paste native history boundary=%s to separate subsequent typing', async (afterBoundary) => {
    const e = await editor()
    e.caret(1, 0)
    const before = e.state().doc
    e.paste({ isPlainText: true, text: 'Paste A\tPaste B' }, afterBoundary)
    const pasted = e.state().doc
    const cell = e.cellPosition(1, 0), end = cell + e.currentTable().node.child(1).child(0).nodeSize - 2
    e.dispatch(e.state().tr.setSelection(TextSelection.create(e.state().doc, end)).insertText('!'))
    expect(undo(e.state(), e.dispatch)).toBe(true)
    expect(e.state().doc.eq(afterBoundary ? pasted : before)).toBe(true)
    if (afterBoundary) {
      expect(undo(e.state(), e.dispatch)).toBe(true)
      expect(e.state().doc.eq(before)).toBe(true)
      expect(redo(e.state(), e.dispatch)).toBe(true)
      expect(e.state().doc.eq(pasted)).toBe(true)
    }
  })
  it('keeps one paste as one undo/redo event with the exact prior rectangle and rich document restored', async () => {
    const e = await editor()
    e.select(2, 1, 1, 0)
    const before = e.state().doc, addresses = e.selectionAddresses()
    e.paste({ isPlainText: true, text: 'a\tb\nc\td' })
    const after = e.state().doc
    expect(undoDepth(e.state())).toBe(1)
    expect(undo(e.state(), e.dispatch)).toBe(true)
    expect(e.state().doc.eq(before)).toBe(true); expect(e.selectionAddresses()).toEqual(addresses)
    expect(redo(e.state(), e.dispatch)).toBe(true); expect(e.state().doc.eq(after)).toBe(true)
  })
  it('exports real partial and cross-header selections with exact TSV dimensions', async () => {
    const e = await editor([['Head|A', 'Head B'], ['"Quote"', 'line1\nline2'], ['Empty', '']])
    e.select(1, 0, 2, 1)
    expect(value(parseTableTsv(value(tableSelectionTsv(e.state())), { allowSingleColumn: true }))).toEqual([['"Quote"', 'line1\nline2'], ['Empty', '']])
    e.select(0, 0, 1, 1)
    expect(value(parseTableTsv(value(tableSelectionTsv(e.state())), { allowSingleColumn: true }))).toEqual([['Head|A', 'Head B'], ['"Quote"', 'line1\nline2']])
  })
})
