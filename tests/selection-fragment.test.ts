import { afterEach, describe, expect, it, vi } from 'vitest'
import { Clock, Container, Ctx, type MilkdownPlugin } from '@milkdown/kit/ctx'
import { InitReady, editorViewCtx, marksCtx, nodesCtx, remarkPluginsCtx, remarkStringifyOptionsCtx, schemaCtx } from '@milkdown/kit/core'
import { schema as commonmarkSchemas, codeBlockSchema, imageSchema, remarkAddOrderInListPlugin, remarkInlineLinkPlugin, remarkHtmlTransformer, remarkMarker, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark'
import { schema as gfmSchemas, remarkGFMPlugin, tableSchema } from '@milkdown/kit/preset/gfm'
import { imageBlockSchema, remarkImageBlockPlugin } from '@milkdown/kit/component/image-block'
import { Fragment, Schema, Slice, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { AllSelection, EditorState, NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { CellSelection, TableMap } from '@milkdown/kit/prose/tables'
import { ParserState, SerializerState, type NodeSchema } from '@milkdown/kit/transformer'
import { remark } from 'remark'
import remarkStringify from 'remark-stringify'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import { createMarkdownExtensions } from '../src/renderer/editor/markdown-extensions'
import { configureBlockImageCompatibility } from '../src/renderer/editor/image-compatibility'
import { configureCodeMathCompatibility } from '../src/renderer/editor/code-math-compatibility'
import { displayMathSchema, inlineMathSchema } from '../src/renderer/editor/code-math-schema'
import { configureTableMarkdownCompatibility, tableLineBreakCompatibility } from '../src/renderer/editor/table-markdown-compatibility'
import { remarkBlockImageCompatibility, serializeResizedBlockImage } from '../src/shared/block-image-markdown'
import { remarkEditorExtensions } from '../src/shared/markdown-extensions'
import { fromExactSelection, selectedPlainText, SELECTION_FRAGMENT_CHARACTER_LIMIT, serializeRichSelection, type SelectionFragment, type SelectionFragmentResult } from '../src/renderer/editor/selection-fragment'

afterEach(() => vi.unstubAllGlobals())

// Real installed CommonMark/GFM schemas and Milkdown ParserState/SerializerState,
// with the application's actual code/math/image/extension runners. No editor
// view or input rule is mounted. The view context is only what the native empty
// paragraph serializer requires to identify the document's final paragraph.
async function harness() {
  const lifecycle = new EventTarget()
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) vi.stubGlobal(name, lifecycle[name].bind(lifecycle))
  const ctx = new Ctx(new Container(), new Clock())
  ctx.inject(remarkStringifyOptionsCtx).inject(nodesCtx, []).inject(marksCtx, []).inject(remarkPluginsCtx, []).inject(editorViewCtx)
  for (const plugin of [...commonmarkSchemas, ...gfmSchemas, ...imageBlockSchema]) await plugin(ctx)()
  configureCodeMathCompatibility(ctx); configureBlockImageCompatibility(ctx)
  ctx.update(tableSchema.key, (previous) => (context) => ({ ...previous(context), content: 'table_header_row table_row*' }))
  for (const node of [codeBlockSchema, imageSchema, imageBlockSchema, tableSchema]) await node.node(ctx)()
  for (const plugin of createMarkdownExtensions({ emojiCompletion: false })) if (Object.hasOwn(plugin, 'type')) await plugin(ctx)()
  const schema = new Schema({ nodes: { ...Object.fromEntries(ctx.get(nodesCtx)), math_block: displayMathSchema(), math_inline: inlineMathSchema() }, marks: Object.fromEntries(ctx.get(marksCtx)) })
  ctx.inject(schemaCtx, schema)
  ctx.record(InitReady); const ready = ctx.wait(InitReady); ctx.done(InitReady); await ready
  const plugins: MilkdownPlugin[] = [remarkAddOrderInListPlugin, remarkInlineLinkPlugin, tableLineBreakCompatibility, remarkHtmlTransformer, remarkMarker, remarkPreserveEmptyLinePlugin, remarkGFMPlugin, remarkImageBlockPlugin].flat()
  for (const plugin of plugins) {
    if (plugin === remarkGFMPlugin.plugin) ctx.update(remarkGFMPlugin.options.key, (options) => ({ ...options, singleTilde: false }))
    await plugin(ctx)()
  }
  configureTableMarkdownCompatibility(ctx)
  const processor = remark().use(remarkStringify, ctx.get(remarkStringifyOptionsCtx)).use(remarkFrontmatter, ['yaml']).use(remarkMath).use(remarkBlockImageCompatibility).use(remarkEditorExtensions)
  for (const plugin of ctx.get(remarkPluginsCtx)) processor.use(plugin.plugin, plugin.options)
  const parse = ParserState.create(schema, processor), serializer = SerializerState.create(schema, processor)
  const serialize = (doc: ProseNode) => { ctx.set(editorViewCtx, { state: EditorState.create({ doc }) } as never); return serializer(doc) }
  return { schema, parse, serialize }
}

function value(result: SelectionFragmentResult): SelectionFragment {
  if (!result.ok) throw new Error(`Rejected fixture: ${result.reason}`)
  return result.value
}

// Test fixtures locate a unique literal in an actual PM text node. Production
// copying never searches visible text or maps back into original Markdown.
function position(doc: ProseNode, literal: string): number {
  const matches: number[] = []
  doc.descendants((node, offset) => { if (node.isText && node.text!.includes(literal)) matches.push(offset + node.text!.indexOf(literal)) })
  expect(matches).toHaveLength(1)
  return matches[0]
}

function semantic(node: ProseNode): unknown {
  const attrs = { ...node.attrs }
  // Heading IDs and list labels are maintained by UI/list-order plugins and
  // need not appear in a standalone fragment's Markdown bytes.
  delete attrs.id; delete attrs.label
  return { type: node.type.name, ...(node.text ? { text: node.text } : {}), attrs, marks: node.marks.map((mark) => ({ type: mark.type.name, attrs: { ...mark.attrs } })), children: Array.from({ length: node.childCount }, (_, index) => semantic(node.child(index))) }
}

describe('ordinary rich selection fragments', () => {
  it('copies a partial strong span in both directions and never changes the original model', async () => {
    const e = await harness(), doc = e.parse('Start **alpha** outside\n'), before = doc.toJSON()
    for (const [anchor, head] of [[8, 11], [11, 8]]) {
      const copied = value(serializeRichSelection(TextSelection.create(doc, anchor, head).content(), e.schema, e.serialize))
      expect(copied).toEqual({ kind: 'rich', markdown: '**lph**\n', plain: 'lph' })
      expect(e.parse(copied.markdown).firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['strong'])
      expect(doc.toJSON()).toEqual(before)
      expect(Object.isFrozen(copied)).toBe(true)
    }
  })

  it('keeps a partial link label and its actual href/title', async () => {
    const e = await harness(), doc = e.parse('A [target](https://example.com "Title") outside\n'), before = doc.toJSON()
    const copied = value(serializeRichSelection(TextSelection.create(doc, 4, 7).content(), e.schema, e.serialize))
    expect(copied.markdown).toBe('[arg](https://example.com "Title")\n')
    expect(copied.plain).toBe('arg')
    expect(e.parse(copied.markdown).firstChild!.firstChild!.marks[0].attrs).toEqual({ href: 'https://example.com', title: 'Title' })
    expect(doc.toJSON()).toEqual(before)
  })

  it('copies exactly the selected suffix/prefix across paragraph and heading boundaries', async () => {
    const e = await harness(), doc = e.parse('Keep **selected** tail\n\n## Next *picked* outside\n\nNot copied\n'), before = doc.toJSON()
    const from = position(doc, 'selected') + 2, to = position(doc, 'picked') + 4
    const copied = value(serializeRichSelection(TextSelection.create(doc, from, to).content(), e.schema, e.serialize))
    expect(copied.markdown).toBe('**lected** tail\n\n## Next *pick*\n')
    expect(copied.plain).toBe('lected tail\n\nNext pick')
    expect(e.parse(copied.markdown).child(1).attrs.level).toBe(2)
    expect(doc.toJSON()).toEqual(before)
  })

  it('refuses cut nested list ancestors when the installed serializer would turn their children into HTML', async () => {
    const e = await harness(), doc = e.parse('- Outer not selected\n  - Nested **alpha** ending\n  - Beta last\n\nOutside\n'), before = doc.toJSON()
    const copied = serializeRichSelection(TextSelection.create(doc, position(doc, 'alpha') + 1, position(doc, 'Beta') + 2).content(), e.schema, e.serialize)
    expect(copied).toEqual({ ok: false, reason: 'unsupported-content' })
    expect(doc.toJSON()).toEqual(before)
  })

  it('keeps the first selected ordered item number and checkbox semantics', async () => {
    const e = await harness(), doc = e.parse('7. First\n8. [x] Second\n9. [ ] Third\n'), before = doc.toJSON()
    const copied = value(serializeRichSelection(TextSelection.create(doc, position(doc, 'Second') + 1, position(doc, 'Third') + 3).content(), e.schema, e.serialize))
    const list = e.parse(copied.markdown).firstChild!
    expect(list.attrs.order).toBe(8)
    expect(list.child(0).attrs.checked).toBe(true)
    expect(list.child(1).attrs.checked).toBe(false)
    expect(list.child(0).textContent).toBe('econd')
    expect(list.child(1).textContent).toBe('Thi')
    expect(copied.plain).toBe('8. [x] econd\n9. [ ] Thi')
    expect(doc.toJSON()).toEqual(before)
  })

  it('preserves independent ordinary latex code and true display math source/metadata', async () => {
    const e = await harness(), doc = e.parse('```latex title="snippet.tex" {1,3}\n\\alpha + \\beta\n\nlast  \n```\n\n$$ equation-1\nx^2 + y^2\n+z\n$$\n\nOutside\n'), before = doc.toJSON()
    for (const index of [0, 1]) {
      const offset = index ? doc.child(0).nodeSize : 0
      const copied = value(serializeRichSelection(NodeSelection.create(doc, offset).content(), e.schema, e.serialize))
      expect(semantic(e.parse(copied.markdown).firstChild!)).toEqual(semantic(doc.child(index)))
      expect(copied.plain).toBe(doc.child(index).textContent)
      expect(copied.markdown).not.toContain('Outside')
      if (!index) { expect(copied.markdown).toContain('```latex title="snippet.tex" {1,3}'); expect(copied.markdown).not.toContain('$$') }
      else { expect(copied.markdown).toContain('$$equation-1'); expect(copied.markdown).not.toContain('```') }
    }
    expect(doc.toJSON()).toEqual(before)
  })

  it('gives inline math, emoji and both image types a non-disappearing readable representation', async () => {
    const e = await harness(), doc = e.parse('Before $E=mc^2$ :smile: and ![Star](assets/star.png "small") after\n\n![Diagram](assets/diagram.png "Figure 1")\n'), before = doc.toJSON()
    const copied = value(serializeRichSelection(new AllSelection(doc).content(), e.schema, e.serialize))
    expect(copied.plain).toBe('Before E=mc^2 😄 and Star (assets/star.png) — small after\n\nDiagram (assets/diagram.png) — Figure 1')
    expect(copied.markdown).toContain('$E=mc^2$')
    expect(copied.markdown).toContain(':smile:')
    expect(semantic(e.parse(copied.markdown))).toEqual(semantic(doc))
    expect(doc.toJSON()).toEqual(before)
  })

  it('keeps resized block image metadata, caption and Unicode description', async () => {
    const e = await harness(), attrs = { src: 'assets/图.png', alt: '图示', caption: 'Figure 1', ratio: 1.25, resizeWidth: 500 }
    const doc = e.parse(`${serializeResizedBlockImage(attrs)}\n\nOutside\n`), before = doc.toJSON()
    const copied = value(serializeRichSelection(NodeSelection.create(doc, 0).content(), e.schema, e.serialize))
    expect(copied.markdown).toContain('width="500"')
    expect(copied.markdown).toContain('data-ttypora-ratio="1.25"')
    expect(e.parse(copied.markdown).firstChild!.attrs).toEqual(attrs)
    expect(copied.plain).toBe('图示 (assets/图.png) — Figure 1')
    expect(doc.toJSON()).toEqual(before)
  })

  it('supports an inline atom NodeSelection and actual paragraph hardbreaks within the selected text', async () => {
    const e = await harness(), doc = e.parse('A $x+y$ end\n\nOne  \nTwo outside\n'), before = doc.toJSON()
    let mathPosition = -1
    doc.descendants((node, offset) => { if (node.type.name === 'math_inline') mathPosition = offset })
    const math = value(serializeRichSelection(NodeSelection.create(doc, mathPosition).content(), e.schema, e.serialize))
    expect(math).toEqual({ kind: 'rich', markdown: '$x+y$\n', plain: 'x+y' })
    const text = value(serializeRichSelection(TextSelection.create(doc, position(doc, 'One'), position(doc, 'Two') + 3).content(), e.schema, e.serialize))
    expect(text.plain).toBe('One\nTwo')
    expect(e.parse(text.markdown).firstChild!.child(1).type.name).toBe('hardbreak')
    expect(doc.toJSON()).toEqual(before)
  })

  it('extracts ordinary text inside one real table cell and refuses cross-cell/rectangular selections', async () => {
    const e = await harness(), doc = e.parse('| Header **picked** rest | Other |\n| --- | --- |\n| Body | Cell |\n'), before = doc.toJSON()
    const picked = position(doc, 'picked'), other = position(doc, 'Other')
    const copied = value(serializeRichSelection(TextSelection.create(doc, picked + 2, picked + 4).content(), e.schema, e.serialize))
    expect(copied).toEqual({ kind: 'rich', markdown: '**ck**\n', plain: 'ck' })
    const spy = vi.fn(e.serialize)
    expect(serializeRichSelection(TextSelection.create(doc, picked, other + 2).content(), e.schema, spy)).toEqual({ ok: false, reason: 'unsupported-selection' })
    const map = TableMap.get(doc.firstChild!), cells = CellSelection.create(doc, 1 + map.map[0], 1 + map.map.at(-1)!)
    expect(serializeRichSelection(cells.content(), e.schema, spy)).toEqual({ ok: false, reason: 'unsupported-selection' })
    expect(spy).not.toHaveBeenCalled()
    expect(doc.toJSON()).toEqual(before)
  })

  it('returns empty for real empty selections without calling the serializer', async () => {
    const e = await harness(), doc = e.parse('Body\n'), spy = vi.fn(e.serialize)
    expect(serializeRichSelection(TextSelection.create(doc, 2).content(), e.schema, spy)).toEqual({ ok: false, reason: 'empty' })
    expect(spy).not.toHaveBeenCalled()
    expect(selectedPlainText(Fragment.empty)).toBe('')
  })

  it('requires selected footnote definitions and recognizes the parser identifier convention', async () => {
    const e = await harness(), doc = e.parse('See[^Note] outside\n\n[^note]: Definition body\n'), before = doc.toJSON(), spy = vi.fn(e.serialize)
    let reference = -1
    doc.descendants((node, offset) => { if (node.type.name === 'footnote_reference') reference = offset })
    expect(reference).toBeGreaterThanOrEqual(0)
    expect(serializeRichSelection(NodeSelection.create(doc, reference).content(), e.schema, spy)).toEqual({ ok: false, reason: 'unsupported-content' })
    expect(spy).not.toHaveBeenCalled()
    const copied = value(serializeRichSelection(new AllSelection(doc).content(), e.schema, e.serialize)), reopened = e.parse(copied.markdown)
    expect(copied.markdown).toContain('[^Note]')
    expect(copied.markdown).toContain('[^note]: Definition body')
    expect(copied.plain).toBe('See[^Note] outside\n\n[^note]: Definition body')
    expect(reopened.firstChild!.child(1).type.name).toBe('footnote_reference')
    expect(reopened.lastChild!.textContent).toBe('Definition body')
    expect(doc.toJSON()).toEqual(before)
  })

  it('refuses a mark cut at whitespace that the native serializer would move out of that mark', async () => {
    const e = await harness(), doc = e.parse('Before **two three** after\n'), before = doc.toJSON(), spy = vi.fn(e.serialize)
    const start = position(doc, 'two three')
    expect(serializeRichSelection(TextSelection.create(doc, start + 3, start + 9).content(), e.schema, spy)).toEqual({ ok: false, reason: 'unsupported-content' })
    expect(spy).not.toHaveBeenCalled()
    expect(doc.toJSON()).toEqual(before)
  })

  it('refuses known silent-loss cases before serialization', async () => {
    const e = await harness(), s = e.schema, spy = vi.fn(e.serialize)
    const paragraph = (children: ProseNode[]) => s.nodes.paragraph.createChecked(null, children)
    const cases = [paragraph([s.nodes.math_inline.create({ value: '' })]), paragraph([s.nodes.math_inline.create({ value: 'x' }, null, [s.marks.inlineCode.create()])]), paragraph([s.text('A'), s.nodes.hardbreak.create({ isInline: false })]), paragraph([s.nodes.emoji.create({ name: 'smile', value: 'wrong' })]), paragraph([s.nodes.html.create({ value: '' })])]
    for (const node of cases) {
      const doc = s.nodes.doc.createChecked(null, node), before = doc.toJSON()
      expect(serializeRichSelection(new AllSelection(doc).content(), s, spy)).toEqual({ ok: false, reason: 'unsupported-content' })
      expect(doc.toJSON()).toEqual(before)
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses an unknown atom even if its serializer would silently do nothing', async () => {
    const e = await harness(), ghost: NodeSchema = { group: 'inline', inline: true, atom: true, attrs: { value: { default: 'hidden' } }, parseMarkdown: { match: () => false, runner: () => undefined }, toMarkdown: { match: (node) => node.type.name === 'ghost', runner: () => undefined } }
    const schema = new Schema({ nodes: { ...Object.fromEntries(Object.entries(e.schema.nodes).map(([name, type]) => [name, type.spec])), ghost }, marks: Object.fromEntries(Object.entries(e.schema.marks).map(([name, type]) => [name, type.spec])) })
    const paragraph = schema.nodes.paragraph.createChecked(null, [schema.text('Before '), schema.nodes.ghost.create(), schema.text(' after')]), doc = schema.nodes.doc.createChecked(null, paragraph), before = doc.toJSON(), spy = vi.fn(() => 'Before after\n')
    expect(serializeRichSelection(new AllSelection(doc).content(), schema, spy)).toEqual({ ok: false, reason: 'unsupported-content' })
    expect(() => selectedPlainText(doc.content)).toThrow('unsupported-content')
    expect(spy).not.toHaveBeenCalled()
    expect(doc.toJSON()).toEqual(before)
  })

  it('rejects a foreign schema, impossible open depths, failing/empty serializers and oversized output', async () => {
    const e = await harness(), other = await harness(), doc = e.parse('Body\n'), slice = new AllSelection(doc).content(), before = doc.toJSON()
    expect(serializeRichSelection(slice, other.schema, e.serialize)).toEqual({ ok: false, reason: 'unsupported-content' })
    expect(serializeRichSelection(new Slice(slice.content, 20, 0), e.schema, e.serialize)).toEqual({ ok: false, reason: 'unsupported-selection' })
    expect(serializeRichSelection(slice, e.schema, () => { throw new Error('unsupported') })).toEqual({ ok: false, reason: 'unsupported-content' })
    expect(serializeRichSelection(slice, e.schema, () => '')).toEqual({ ok: false, reason: 'unsupported-content' })
    expect(serializeRichSelection(slice, e.schema, () => 'x'.repeat(SELECTION_FRAGMENT_CHARACTER_LIMIT + 1))).toEqual({ ok: false, reason: 'size-limit' })
    expect(doc.toJSON()).toEqual(before)
  })

  it('checks selected text size before calling any Markdown serializer', async () => {
    const e = await harness(), doc = e.schema.nodes.doc.createChecked(null, e.schema.nodes.paragraph.createChecked(null, e.schema.text('x'.repeat(SELECTION_FRAGMENT_CHARACTER_LIMIT + 1)))), spy = vi.fn(() => 'too late')
    expect(serializeRichSelection(new AllSelection(doc).content(), e.schema, spy)).toEqual({ ok: false, reason: 'size-limit' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('exact source/native input selections', () => {
  it('keeps whitespace, partial Markdown syntax, CRLF and UTF-16 code units byte-for-character', () => {
    for (const kind of ['source', 'literal'] as const) for (const text of ['   \t\r\n ', '**partial', '\\alpha\r\n\t🙂', '\ud83d', '<img src=x onerror=bad()>']) {
      expect(fromExactSelection(text, kind)).toEqual({ ok: true, value: { kind, markdown: text, plain: text } })
    }
  })

  it('only treats zero characters as empty and enforces the 20 Mi-character limit', () => {
    expect(fromExactSelection('', 'source')).toEqual({ ok: false, reason: 'empty' })
    expect(fromExactSelection('', 'literal')).toEqual({ ok: false, reason: 'empty' })
    const limit = 'x'.repeat(SELECTION_FRAGMENT_CHARACTER_LIMIT)
    expect(value(fromExactSelection(limit, 'source')).markdown.length).toBe(SELECTION_FRAGMENT_CHARACTER_LIMIT)
    expect(fromExactSelection(`${limit}x`, 'literal')).toEqual({ ok: false, reason: 'size-limit' })
  })
})
