import { afterEach, describe, expect, it, vi } from 'vitest'
import { Clock, Container, Ctx, type MilkdownPlugin } from '@milkdown/kit/ctx'
import { CommandManager, CommandsReady, InitReady, SchemaReady, commandsCtx, editorViewCtx, marksCtx, nodesCtx, prosePluginsCtx, remarkPluginsCtx, remarkStringifyOptionsCtx, schemaCtx } from '@milkdown/kit/core'
import { schema as commonmarkSchemas, hardbreakFilterNodes, hardbreakFilterPlugin, hardbreakSchema, insertHardbreakCommand, paragraphSchema, remarkAddOrderInListPlugin, remarkInlineLinkPlugin, remarkHtmlTransformer, remarkMarker, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark'
import { schema as gfmSchemas, remarkGFMPlugin, tableCellSchema, tableHeaderSchema, tableSchema } from '@milkdown/kit/preset/gfm'
import { Schema, type Node } from '@milkdown/kit/prose/model'
import { history, redo, undo } from '@milkdown/kit/prose/history'
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { CellSelection, TableMap } from '@milkdown/kit/prose/tables'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ParserState, SerializerState, type MarkdownNode } from '@milkdown/kit/transformer'
import { remark } from 'remark'
import remarkStringify from 'remark-stringify'
import { configureTableMarkdownCompatibility, tableLineBreakCompatibility } from '../src/renderer/editor/table-markdown-compatibility'
import { configureTableHardbreakCompatibility, insertTableHardbreakCommand, tableHardbreakCompatibility, transformTableHardbreaks } from '../src/renderer/editor/table-hardbreak-compatibility'

afterEach(() => vi.unstubAllGlobals())

// Use the actual core handlers, CommonMark/GFM schemas and production remark
// plugins, including the already adopted table text compatibility layer.
async function harness(compatible = true) {
  const lifecycle = new EventTarget()
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) vi.stubGlobal(name, lifecycle[name].bind(lifecycle))
  const ctx = new Ctx(new Container(), new Clock())
  ctx.inject(remarkStringifyOptionsCtx).inject(nodesCtx, []).inject(marksCtx, []).inject(remarkPluginsCtx, []).inject(editorViewCtx).inject(prosePluginsCtx, [])
  for (const plugin of [...commonmarkSchemas, ...gfmSchemas]) await plugin(ctx)()
  ctx.update(tableSchema.key, (previous) => (context) => ({ ...previous(context), content: 'table_header_row table_row*' }))
  if (compatible) configureTableHardbreakCompatibility(ctx)
  for (const node of [tableSchema, paragraphSchema, hardbreakSchema, tableCellSchema, tableHeaderSchema]) await node.node(ctx)()
  const schema = new Schema({ nodes: Object.fromEntries(ctx.get(nodesCtx)), marks: Object.fromEntries(ctx.get(marksCtx)) })
  ctx.inject(schemaCtx, schema)
  for (const timer of [InitReady, SchemaReady, CommandsReady]) {
    ctx.record(timer); const ready = ctx.wait(timer); ctx.done(timer); await ready
  }
  const commands = new CommandManager(); commands.setCtx(ctx); ctx.inject(commandsCtx, commands)
  await hardbreakFilterNodes(ctx)(); await hardbreakFilterPlugin(ctx)(); await insertHardbreakCommand(ctx)()
  const plugins: MilkdownPlugin[] = [remarkAddOrderInListPlugin, remarkInlineLinkPlugin, tableLineBreakCompatibility, remarkHtmlTransformer, remarkMarker, remarkPreserveEmptyLinePlugin, remarkGFMPlugin, ...(compatible ? [tableHardbreakCompatibility] : [])].flat()
  for (const plugin of plugins) {
    if (plugin === remarkGFMPlugin.plugin) ctx.update(remarkGFMPlugin.options.key, (options) => ({ ...options, singleTilde: false }))
    await plugin(ctx)()
  }
  configureTableMarkdownCompatibility(ctx)
  const processor = remark().use(remarkStringify, ctx.get(remarkStringifyOptionsCtx))
  for (const plugin of ctx.get(remarkPluginsCtx)) processor.use(plugin.plugin, plugin.options)
  const parse = ParserState.create(schema, processor), serializer = SerializerState.create(schema, processor)
  const serialize = (doc: Node) => { ctx.set(editorViewCtx, { state: EditorState.create({ doc }) } as never); return serializer(doc) }
  const paragraph = (children: readonly Node[] = []) => schema.nodes.paragraph.createChecked(null, [...children])
  const text = (value: string) => schema.text(value)
  const br = (isInline = false) => schema.nodes.hardbreak.create({ isInline })
  const table = (children: readonly Node[], header = false) => schema.nodes.table.createChecked(null, [
    schema.nodes.table_header_row.createChecked(null, [schema.nodes.table_header.createChecked({ alignment: 'left' }, paragraph(header ? children : [text('Header')]))]),
    ...(header ? [] : [schema.nodes.table_row.createChecked(null, [schema.nodes.table_cell.createChecked({ alignment: 'left' }, paragraph(children))])]),
  ])
  const doc = (children: readonly Node[], header = false) => schema.nodes.doc.createChecked(null, table(children, header))
  const editable = (before: Node, position = 0, plugins = ctx.get(prosePluginsCtx)) => {
    let state = EditorState.create({ doc: before, plugins: [history(), ...plugins] })
    const dispatch = (transaction: Transaction) => { state = state.apply(transaction); state.doc.check() }
    const firstCell = TableMap.get(before.firstChild!).map[before.firstChild!.childCount > 1 ? 1 : 0] + 1
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, firstCell + 2 + position)))
    const view = { get state() { return state }, editable: true, composing: false, dispatch } as unknown as EditorView
    ctx.set(editorViewCtx, view)
    return { state: () => state, dispatch, view, native: () => commands.call(insertHardbreakCommand.key), insert: () => insertTableHardbreakCommand(state, dispatch), cell: () => state.doc.firstChild!.lastChild!.firstChild! }
  }
  return { ctx, schema, processor, parse, serialize, paragraph, text, br, table, doc, editable }
}

describe('actual table hardbreak Markdown round trips', () => {
  it('reproduces both native interior and final hardbreak serialization loss', async () => {
    const e = await harness(false)
    for (const children of [[e.text('A'), e.br(), e.text('B')], [e.text('A'), e.br()], [e.br(true)]]) {
      const before = e.doc(children)
      expect(e.parse(e.serialize(before)).eq(before)).toBe(false)
    }
  })

  it.each([
    [false], [true], [false, false], [true, true], [false, true], [true, false],
    [false, true, false, true], [true, false, true, false],
  ].map((flags) => ({ flags })))('preserves break-only cells and exact inline flags $flags', async ({ flags }) => {
    const e = await harness()
    for (const header of [false, true]) {
      const before = e.doc(flags.map((flag) => e.br(flag)), header), markdown = e.serialize(before)
      expect(e.parse(markdown).eq(before), markdown).toBe(true)
      expect(e.serialize(e.parse(markdown))).toBe(markdown)
    }
  })

  it.each(['start', 'middle', 'end'] as const)('retains a hardbreak at %s without replacing surrounding editable text', async (where) => {
    const e = await harness()
    for (const flag of [false, true]) {
      const children = where === 'start' ? [e.br(flag), e.text('正文')] : where === 'end' ? [e.text('正文'), e.br(flag)] : [e.text('A'), e.br(flag), e.text('B')]
      const before = e.doc(children), markdown = e.serialize(before)
      expect(e.parse(markdown).eq(before), markdown).toBe(true)
      expect(markdown.split('\n').filter((line) => line.startsWith('|')).length).toBe(3)
    }
  })

  it('preserves literal CRLF/tab/spaces separately from hardbreak nodes and rich marks', async () => {
    const e = await harness(), before = e.doc([
      e.text(' '), e.schema.text('bold', [e.schema.marks.strong.create()]), e.text(' '), e.br(),
      e.text(' 第一行\r\n第二行\t '), e.br(true),
      e.schema.text('link', [e.schema.marks.link.create({ href: 'https://example.com/path?q=a%20b', title: 'title' })]), e.br(), e.br(),
    ])
    const markdown = e.serialize(before)
    expect(markdown).toContain('<br>'); expect(markdown).toContain('<span data-type="hardbreak"> </span>')
    expect(markdown).toContain('&#xD;&#xA;')
    expect(e.parse(markdown).eq(before), markdown).toBe(true)
  })

  it('recognizes standard BR variants inside cells, including adjacent HTML tokens', async () => {
    const e = await harness(), after = e.parse('| H |\n| --- |\n| <br><BR/><br /><span data-type="hardbreak"> </span><br> |\n')
    expect(after.firstChild!.lastChild!.firstChild!.firstChild!.content.content.map((node) => node.toJSON())).toEqual([
      { type: 'hardbreak', attrs: { isInline: false } }, { type: 'hardbreak', attrs: { isInline: false } },
      { type: 'hardbreak', attrs: { isInline: false } }, { type: 'hardbreak', attrs: { isInline: true } },
      { type: 'hardbreak', attrs: { isInline: false } },
    ])
    expect(e.parse(e.serialize(after)).eq(after)).toBe(true)
  })

  it('keeps empty header and body paragraphs empty while preserving real break-only cells', async () => {
    const e = await harness()
    for (const header of [false, true]) {
      for (const children of [[], [e.br()], [e.br(), e.br()]]) {
        const before = e.doc(children, header), markdown = e.serialize(before)
        expect(e.parse(markdown).eq(before), markdown).toBe(true)
        if (!children.length) expect(markdown).not.toMatch(/<br\s*\/?\s*>/)
      }
    }
    const original = e.parse('| **H** | B |\n| :--- | ---: |\n| a | b |\n')
    const emptyHeader = e.schema.nodes.table_header_row.createChecked(null, Array.from({ length: 2 }, (_, column) => e.schema.nodes.table_header.createChecked({ alignment: column ? 'right' : 'left' }, e.paragraph())))
    const previous = original.firstChild!
    const promoted = e.schema.nodes.table_row.createChecked(null, Array.from({ length: 2 }, (_, column) => e.schema.nodes.table_cell.createChecked(previous.firstChild!.child(column).attrs, previous.firstChild!.child(column).content)))
    const inserted = e.schema.nodes.doc.createChecked(null, e.schema.nodes.table.createChecked(null, [emptyHeader, promoted, previous.lastChild!]))
    expect(e.parse(e.serialize(inserted)).eq(inserted)).toBe(true)
  })
  it('keeps escaped text, inline code, link destinations and unsupported HTML attributes intact', async () => {
    const e = await harness(), before = e.parse('| H |\n| --- |\n| \\<br> and `<br>` [label](https://example.com/a%3Cbr%3E) <br class="custom"> |\n')
    const markdown = e.serialize(before), after = e.parse(markdown)
    expect(after.eq(before), markdown).toBe(true)
    expect(after.firstChild!.lastChild!.firstChild!.firstChild!.content.content.some((node) => node.type.name === 'hardbreak')).toBe(false)
    expect(markdown).toContain('https://example.com/a%3Cbr%3E'); expect(markdown).toContain('<br class="custom">')
  })

  it('preserves all native paragraph, blockquote and list parsing/serialization outside tables', async () => {
    const native = await harness(false), compatible = await harness()
    const source = 'Paragraph<br>text <span data-type="hardbreak"> </span> tail.\n\n> quoted  \n> next\n\n- one\\\n  two\n\n```html\n<br>\n```\n'
    expect(compatible.parse(source).toJSON()).toEqual(native.parse(source).toJSON())
    expect(compatible.serialize(compatible.parse(source))).toBe(native.serialize(native.parse(source)))
    for (const isInline of [false, true]) {
      const before = native.schema.nodes.doc.createChecked(null, native.paragraph([native.text('End'), native.br(isInline)]))
      expect(compatible.serialize(compatible.schema.nodeFromJSON(before.toJSON()))).toBe(native.serialize(before))
    }
    // A later sibling paragraph in the same serializer run must leave the cell
    // context, retaining the native paragraph trailing-break behavior.
    const mixed = compatible.schema.nodes.doc.createChecked(null, [compatible.table([compatible.text('Cell'), compatible.br()]), compatible.paragraph([compatible.text('Outside'), compatible.br()])])
    const markdown = compatible.serialize(mixed)
    expect(markdown).toContain('Cell<br>'); expect(markdown.endsWith('Outside\n')).toBe(true)
  })

  it('transforms only exact native inline markers and leaves non-cell trees unchanged', () => {
    const children: MarkdownNode[] = [{ type: 'html', value: '<br>' }, { type: 'html', value: '<span data-type="hardbreak">' }, { type: 'text', value: ' ' }, { type: 'html', value: '</span>' }]
    const ordinary = { type: 'root', children: [{ type: 'paragraph', children: structuredClone(children) }] } as MarkdownNode
    const before = structuredClone(ordinary); transformTableHardbreaks(ordinary); expect(ordinary).toEqual(before)
    const table = { type: 'root', children: [{ type: 'table', children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: structuredClone(children) }] }] }] } as MarkdownNode
    transformTableHardbreaks(table)
    expect(table.children![0].children![0].children![0].children).toEqual([{ type: 'break', data: { isInline: false } }, { type: 'break', data: { isInline: true } }])
  })
})

describe('table Shift+Enter command with the actual CommonMark filter', () => {
  it('demonstrates the native command consumes the first table key but its filter rejects the insertion', async () => {
    const e = await harness(), before = e.doc([e.text('ABC')]), editor = e.editable(before, 3)
    expect(editor.native()).toBe(true)
    expect(editor.state().doc.eq(before)).toBe(true)
  })

  it.each([false, true])('inserts consecutive keys in header=%j without extra paragraphs, preserving undo/redo and Markdown', async (header) => {
    const e = await harness(), before = e.doc([e.text('ABC')], header), editor = e.editable(before, 3)
    for (let count = 1; count <= 3; count++) {
      expect(editor.insert()).toBe(true); expect(editor.cell().childCount).toBe(1)
      expect(editor.cell().firstChild!.childCount).toBe(count + 1)
      expect(editor.cell().firstChild!.content.content.slice(1).map((node) => node.toJSON())).toEqual(Array.from({ length: count }, () => ({ type: 'hardbreak', attrs: { isInline: false } })))
      expect(e.parse(e.serialize(editor.state().doc)).eq(editor.state().doc)).toBe(true)
    }
    const after = editor.state().doc
    expect(undo(editor.state(), editor.dispatch)).toBe(true); expect(editor.state().doc.eq(before)).toBe(true)
    expect(redo(editor.state(), editor.dispatch)).toBe(true); expect(editor.state().doc.eq(after)).toBe(true)
  })

  it('exposes the native consecutive-break branch in a strict single-paragraph cell', async () => {
    const e = await harness(), before = e.doc([e.text('ABC'), e.br()]), editor = e.editable(before, 4)
    expect(editor.native()).toBe(true)
    expect(editor.state().doc.childCount).toBe(2)
    expect(editor.state().doc.firstChild!.lastChild!.firstChild!.firstChild!.toJSON()).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'ABC' }] })
    expect(editor.state().doc.lastChild!.toJSON()).toEqual({ type: 'paragraph' })
  })

  it('inserts in the middle even when the paragraph already ends in a break', async () => {
    const e = await harness(), before = e.doc([e.text('ABC'), e.br()]), editor = e.editable(before, 1)
    expect(editor.insert()).toBe(true)
    expect(editor.cell().firstChild!.content.content.map((node) => node.toJSON())).toEqual([
      { type: 'text', text: 'A' }, { type: 'hardbreak', attrs: { isInline: false } }, { type: 'text', text: 'BC' }, { type: 'hardbreak', attrs: { isInline: false } },
    ])
    expect(e.parse(e.serialize(editor.state().doc)).eq(editor.state().doc)).toBe(true)
  })

  it('replaces selected text with an unmarked break and supports a no-dispatch applicability check', async () => {
    const e = await harness(), before = e.doc([e.schema.text('ABC', [e.schema.marks.strong.create()])]), editor = e.editable(before)
    const start = editor.state().selection.from
    editor.dispatch(editor.state().tr.setSelection(TextSelection.create(editor.state().doc, start + 1, start + 2)).setStoredMarks([e.schema.marks.strong.create()]))
    expect(insertTableHardbreakCommand(editor.state())).toBe(true); expect(editor.state().doc.eq(before)).toBe(true)
    expect(editor.insert()).toBe(true)
    expect(editor.cell().firstChild!.child(1).toJSON()).toEqual({ type: 'hardbreak', attrs: { isInline: false } })
    expect(editor.cell().firstChild!.textContent).toBe('A\nC')
    expect(e.parse(e.serialize(editor.state().doc)).eq(editor.state().doc)).toBe(true)
  })

  it('declines ordinary paragraph/code, node selections, cross-cell text selections and CellSelection', async () => {
    const e = await harness()
    for (const block of [e.paragraph([e.text('ABC')]), e.schema.nodes.code_block.createChecked(null, e.text('ABC'))]) {
      const doc = e.schema.nodes.doc.createChecked(null, block), state = EditorState.create({ doc, selection: TextSelection.create(doc, 2) }), dispatch = vi.fn()
      expect(insertTableHardbreakCommand(state, dispatch)).toBe(false); expect(dispatch).not.toHaveBeenCalled()
    }
    const doc = e.doc([e.text('ABC')]), map = TableMap.get(doc.firstChild!), positions = map.map.map((position) => position + 1)
    for (const selection of [NodeSelection.create(doc, 0), TextSelection.create(doc, positions[0] + 2, positions[1] + 2), CellSelection.create(doc, positions[0], positions[1])]) {
      const dispatch = vi.fn(), state = EditorState.create({ doc, selection })
      expect(insertTableHardbreakCommand(state, dispatch)).toBe(false); expect(dispatch).not.toHaveBeenCalled()
    }
  })
})
