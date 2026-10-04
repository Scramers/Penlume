import { afterEach, describe, expect, it, vi } from 'vitest'
import { Clock, Container, Ctx, type MilkdownPlugin } from '@milkdown/kit/ctx'
import { InitReady, editorViewCtx, marksCtx, nodesCtx, remarkPluginsCtx, remarkStringifyOptionsCtx, schemaCtx } from '@milkdown/kit/core'
import { schema as commonmarkSchemas, remarkAddOrderInListPlugin, remarkInlineLinkPlugin, remarkLineBreak, remarkHtmlTransformer, remarkMarker, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark'
import { schema as gfmSchemas, remarkGFMPlugin, tableSchema } from '@milkdown/kit/preset/gfm'
import { Schema, type Node } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { CellSelection, TableMap } from '@milkdown/kit/prose/tables'
import { ParserState, SerializerState, type MarkdownNode } from '@milkdown/kit/transformer'
import { remark } from 'remark'
import remarkStringify from 'remark-stringify'
import { configureTableMarkdownCompatibility, tableLineBreakCompatibility, transformTableCompatibleLineBreaks } from '../src/renderer/editor/table-markdown-compatibility'
import { tableSelectionTsv } from '../src/renderer/editor/table-clipboard'

afterEach(() => vi.unstubAllGlobals())
async function harness(compatible = true) {
  const lifecycle = new EventTarget()
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) vi.stubGlobal(name, lifecycle[name].bind(lifecycle))
  const ctx = new Ctx(new Container(), new Clock())
  // These default options contain the real Milkdown core handlers, including its
  // trailing-whitespace text shortcut, not remark's default text serializer.
  ctx.inject(remarkStringifyOptionsCtx).inject(nodesCtx, []).inject(marksCtx, []).inject(remarkPluginsCtx, []).inject(editorViewCtx)
  for (const plugin of [...commonmarkSchemas, ...gfmSchemas]) await plugin(ctx)()
  const factory = ctx.get(tableSchema.key)
  ctx.set(tableSchema.key, (context) => ({ ...factory(context), content: 'table_header_row table_row*' }))
  await tableSchema.node(ctx)()
  const schema = new Schema({ nodes: Object.fromEntries(ctx.get(nodesCtx)), marks: Object.fromEntries(ctx.get(marksCtx)) })
  ctx.inject(schemaCtx, schema)
  ctx.record(InitReady); const ready = ctx.wait(InitReady); ctx.done(InitReady); await ready
  // Load the actual CommonMark remark plugins in production order. Only the
  // line-break plugin is substituted; marker/HTML/empty-line behavior stays real.
  const plugins: MilkdownPlugin[] = [remarkAddOrderInListPlugin, remarkInlineLinkPlugin, compatible ? tableLineBreakCompatibility : remarkLineBreak, remarkHtmlTransformer, remarkMarker, remarkPreserveEmptyLinePlugin, remarkGFMPlugin].flat()
  for (const plugin of plugins) {
    if (plugin === remarkGFMPlugin.plugin) ctx.update(remarkGFMPlugin.options.key, (options) => ({ ...options, singleTilde: false }))
    await plugin(ctx)()
  }
  if (compatible) configureTableMarkdownCompatibility(ctx)
  const processor = remark().use(remarkStringify, ctx.get(remarkStringifyOptionsCtx))
  for (const plugin of ctx.get(remarkPluginsCtx)) processor.use(plugin.plugin, plugin.options)
  const parse = ParserState.create(schema, processor), serializer = SerializerState.create(schema, processor)
  const serialize = (doc: Node) => { ctx.set(editorViewCtx, { state: EditorState.create({ doc }) } as never); return serializer(doc) }
  const paragraph = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : [])
  const table = (values: string[][]) => schema.nodes.table.createChecked(null, values.map((row, r) => schema.nodes[r ? 'table_row' : 'table_header_row'].createChecked(null, row.map((value, c) => schema.nodes[r ? 'table_cell' : 'table_header'].createChecked({ alignment: c ? 'right' : 'left' }, paragraph(value))))))
  const doc = (values: string[][]) => schema.nodes.doc.createChecked(null, [paragraph('Before'), table(values), paragraph('After')])
  return { ctx, schema, processor, parse, serialize, paragraph, table, doc }
}

describe('actual Milkdown/CommonMark/GFM table Markdown compatibility', () => {
  it('reproduces the actual legacy pipeline whitespace and inline-break failures', async () => {
    const e = await harness(false), values = [['H1', 'H2'], [' 左\t右 ', '第一行\r\n第二行'], ['中文 ', ' leading ']]
    const before = e.doc(values), markdown = e.serialize(before), after = e.parse(markdown)
    const table = after.child(1)
    expect(table.child(1).child(0).textContent).toBe('左\t右')
    expect(table.child(2).child(0).textContent).toBe('中文')
    expect(table.child(2).child(1).textContent).toBe('leading')
    expect(table.child(1).child(1).firstChild!.child(1).toJSON()).toEqual({ type: 'hardbreak', attrs: { isInline: true } })
    expect(after.eq(before)).toBe(false)
  })
  it.each([' 左\t右 ', '中文 ', ' leading ', 'trailing ', '   ', '\t', '\tleft', 'right\t', '\t both \t', 'middle\ttab', '第一行\r\n第二行', 'a\rb\nc\r\nd', 'a \t\r\n b', '\r\n', '他说"好"|pipe ', '*literal*|pipe ', '   |   '])('preserves the exact editable text of quoted field %j across save/reopen', async (value) => {
    const e = await harness(), before = e.doc([['Header', 'Other'], [value, 'second'], ['', '']])
    const markdown = e.serialize(before), after = e.parse(markdown)
    expect(after.eq(before), markdown).toBe(true)
    const table = after.child(1)
    expect(table.childCount).toBe(3); expect(table.child(1).childCount).toBe(2)
    expect(table.child(1).child(0).firstChild!.content.content.every((node) => node.isText)).toBe(true)
    expect(table.child(1).child(0).textContent).toBe(value)
    expect(e.serialize(after)).toBe(markdown)
  })
  it('keeps numeric references to whitespace inside one cell and ordinary inner spaces readable', async () => {
    const e = await harness(), before = e.doc([['Header A', 'Header B'], [' lead\tinside ', 'a\r\nb']]), markdown = e.serialize(before)
    expect(markdown).toContain('Header A'); expect(markdown).toContain('&#x20;lead\tinside&#x20;')
    expect(markdown).toContain('a&#xD;&#xA;b')
    expect(e.parse(markdown).eq(before)).toBe(true)
  })
  it('preserves ordinary rich header/body, code pipes, link destinations/titles and mark-adjacent spaces', async () => {
    const e = await harness(), source = '| **Header A** | [Header B](https://example.com/head "title") | `Head\\|C` |\n| :--- | :---: | ---: |\n| before **bold** after | [link](https://example.com/path?q=a%20b "Body title") | `a\\|b` |\n| _emphasis_ and ~~strike~~ | mixed `code` text | plain |\n'
    const before = e.parse(source), markdown = e.serialize(before), after = e.parse(markdown)
    expect(after.eq(before), markdown).toBe(true)
    expect(markdown).toContain('before&#x20;**bold**&#x20;after')
    expect(markdown).toContain('https://example.com/path?q=a%20b')
    expect(markdown).toContain('"Body title"')
    expect(after.firstChild!.child(1).child(2).firstChild!.firstChild!.marks[0].type.name).toBe('inlineCode')
  })
  it('keeps header-only and all-empty final rows in the actual schema', async () => {
    const e = await harness()
    for (const values of [[[' H ', '\t']], [['Head', 'Other'], ['', ''], ['', '']]]) {
      const before = e.doc(values)
      expect(e.parse(e.serialize(before)).eq(before)).toBe(true)
    }
  })
  it('preserves reverse cell selection addresses and plain TSV through the unchanged PM node model', async () => {
    const e = await harness(), before = e.doc([['Head', 'Other'], [' Left ', 'a\r\nb'], ['\t', '']]), after = e.parse(e.serialize(before))
    const table = after.child(1), start = after.firstChild!.nodeSize + 1, map = TableMap.get(table)
    let state = EditorState.create({ doc: after, selection: CellSelection.create(after, start + map.map[3 * map.width - 1], start + map.map[map.width]) })
    expect(tableSelectionTsv(state)).toEqual({ ok: true, value: ' Left \t"a\r\nb"\r\n"\t"\t' })
    const selected = state.selection as CellSelection
    expect(map.findCell(selected.$anchorCell.pos - start)).toMatchObject({ top: 2, left: 1 })
    expect(map.findCell(selected.$headCell.pos - start)).toMatchObject({ top: 1, left: 0 })
    const caret = start + map.map[map.width] + 3
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)).insertText('X'))
    expect(state.doc.child(1).child(1).child(0).textContent).toBe(' XLeft ')
    expect(e.parse(e.serialize(state.doc)).eq(state.doc)).toBe(true)
  })
  it('matches the upstream transform on non-table AST, including nested text and whitespace before CRLF', async () => {
    const original = await harness(false), replacement = await harness()
    const source = 'Paragraph  \nnext\nline.\n\n> quote\r\n> continuation\n\n- one\n  continuation\n\n**bold\nsecond** and [link\nlabel](https://example.com).\n\n```js title="a b"\n const n = " x ";\n```\n'
    const tree = original.processor.parse(source)
    // Isolate the actual native plugin from its registered factory, independent
    // of parser runners, then compare both tree transformations exactly.
    const nativeCtx = new Ctx(new Container(), new Clock())
    nativeCtx.inject(remarkPluginsCtx, []).record(InitReady)
    const ready = nativeCtx.wait(InitReady); nativeCtx.done(InitReady); await ready
    for (const plugin of remarkLineBreak) await plugin(nativeCtx)()
    const plug = nativeCtx.get(remarkPluginsCtx)[0]
    const native = remark().use(plug.plugin, plug.options)
    const expected = native.runSync(structuredClone(tree))
    const actual = structuredClone(tree); transformTableCompatibleLineBreaks(actual as unknown as MarkdownNode)
    expect(actual).toEqual(expected)
    const legacy = original.parse(source), fixed = replacement.parse(source)
    expect(fixed.toJSON()).toEqual(legacy.toJSON())
    expect(replacement.serialize(fixed)).toBe(original.serialize(legacy))
  })
})
