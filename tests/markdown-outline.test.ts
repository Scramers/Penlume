import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractMarkdownHeadings } from '../src/shared/markdown-outline'
import { defaultMarkdownExtensions, type MarkdownExtensionOptions } from '../src/shared/preferences'
import { Clock, Container, Ctx, type MilkdownPlugin } from '@milkdown/kit/ctx'
import { InitReady, editorViewCtx, marksCtx, nodesCtx, remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { schema as commonmarkSchemas, imageSchema, remarkAddOrderInListPlugin, remarkInlineLinkPlugin, remarkHtmlTransformer, remarkMarker, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark'
import { schema as gfmSchemas, remarkGFMPlugin } from '@milkdown/kit/preset/gfm'
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { ParserState, SerializerState, type NodeSchema, type MarkSchema } from '@milkdown/kit/transformer'
import { remark } from 'remark'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import { remarkEditorExtensions } from '../src/shared/markdown-extensions'
import { displayMathSchema, inlineMathSchema } from '../src/renderer/editor/code-math-schema'
import { tableLineBreakCompatibility } from '../src/renderer/editor/table-markdown-compatibility'
import { configureInlineImageCompatibility } from '../src/renderer/editor/image-compatibility'

afterEach(() => vi.unstubAllGlobals())

/** Actual installed CommonMark/GFM schema and remark plugin order. The custom
 * atomic/format runners are the application's real data mapping without views;
 * no DOM headings, label matching, mocks of the parser or editor UI are involved.
 */
async function visualDocumentHarness(options: Partial<MarkdownExtensionOptions> = {}) {
  const lifecycle = new EventTarget()
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) vi.stubGlobal(name, lifecycle[name].bind(lifecycle))
  const ctx = new Ctx(new Container(), new Clock())
  ctx.inject(nodesCtx, []).inject(marksCtx, []).inject(remarkPluginsCtx, []).inject(editorViewCtx).inject(remarkStringifyOptionsCtx)
  for (const plugin of [...commonmarkSchemas, ...gfmSchemas]) {
    await plugin(ctx)()
    // Use the same public context configuration as the product, before the
    // native node plugin reads its schema factory into nodesCtx.
    if (plugin === imageSchema.ctx) configureInlineImageCompatibility(ctx)
  }
  ctx.record(InitReady); const ready = ctx.wait(InitReady); ctx.done(InitReady); await ready
  const plugins: MilkdownPlugin[] = [remarkAddOrderInListPlugin, remarkInlineLinkPlugin, remarkHtmlTransformer, remarkMarker, remarkPreserveEmptyLinePlugin, remarkGFMPlugin, tableLineBreakCompatibility].flat()
  for (const plugin of plugins) {
    if (plugin === remarkGFMPlugin.plugin) ctx.update(remarkGFMPlugin.options.key, (value) => ({ ...value, singleTilde: false }))
    await plugin(ctx)()
  }
  const nodes: Record<string, NodeSchema> = {
    ...Object.fromEntries(ctx.get(nodesCtx)),
    math_block: displayMathSchema(), math_inline: inlineMathSchema(),
    yaml_front_matter: { group: 'block', atom: true, attrs: { value: { default: '' } }, parseMarkdown: { match: ({ type }) => type === 'yaml', runner: (state, node, type) => { state.addNode(type, { value: node.value }) } }, toMarkdown: { match: () => false, runner: () => undefined } },
    html_block: { group: 'block', atom: true, attrs: { value: { default: '' } }, parseMarkdown: { match: ({ type }) => type === 'ttyporaHtmlBlock', runner: (state, node, type) => { state.addNode(type, { value: node.value }) } }, toMarkdown: { match: () => false, runner: () => undefined } },
    document_toc: { group: 'block', atom: true, parseMarkdown: { match: ({ type }) => type === 'ttyporaToc', runner: (state, _node, type) => { state.addNode(type) } }, toMarkdown: { match: () => false, runner: () => undefined } },
    alert: { group: 'block', content: 'block+', parseMarkdown: { match: ({ type }) => type === 'ttyporaAlert', runner: (state, node, type) => { state.openNode(type); state.next(node.children?.length ? node.children : [{ type: 'paragraph', children: [] }]); state.closeNode() } }, toMarkdown: { match: () => false, runner: () => undefined } },
    emoji: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } }, leafText: (node) => String(node.attrs.value), parseMarkdown: { match: ({ type }) => type === 'ttyporaEmoji', runner: (state, node, type) => { state.addNode(type, { value: node.value }) } }, toMarkdown: { match: () => false, runner: () => undefined } },
  }
  const marks: Record<string, MarkSchema> = { ...Object.fromEntries(ctx.get(marksCtx)) }
  for (const [name, markdown] of [['highlight', 'ttyporaHighlight'], ['superscript', 'ttyporaSuperscript'], ['subscript', 'ttyporaSubscript'], ['underline', 'ttyporaUnderline']]) {
    marks[name] = { parseMarkdown: { match: ({ type }) => type === markdown, runner: (state, node, type) => { state.openMark(type); state.next(node.children); state.closeMark(type) } }, toMarkdown: { match: () => false, runner: () => undefined } }
  }
  const schema = new Schema({ nodes, marks })
  const processor = remark()
  for (const plugin of ctx.get(remarkPluginsCtx)) processor.use(plugin.plugin, plugin.options)
  processor.use(remarkMath).use(remarkFrontmatter).use(remarkEditorExtensions, options)
  return { parse: ParserState.create(schema, processor), serialize: SerializerState.create(schema, processor) }
}

async function visualParser(options: Partial<MarkdownExtensionOptions> = {}) {
  return (await visualDocumentHarness(options)).parse
}

function modelHeadingLabel(node: ProseNode): string {
  if (node.isText) return node.text ?? ''
  if (['math_inline', 'emoji', 'html'].includes(node.type.name)) return String(node.attrs.value)
  if (node.type.name === 'image') return String(node.attrs.alt ?? '')
  if (node.type.name === 'footnote_reference') return String(node.attrs.label)
  if (node.type.name === 'hardbreak') return ' '
  let value = ''
  node.forEach((child) => { value += modelHeadingLabel(child) })
  return value
}

describe('markdown outline', () => {
  it('extracts ATX and setext headings with source lines', () => {
    expect(extractMarkdownHeadings('# One\n\nTwo\n---\n### **Three**')).toEqual([
      { level: 1, line: 1, text: 'One' },
      { level: 2, line: 3, text: 'Two' },
      { level: 3, line: 5, text: 'Three' },
    ])
  })

  it('ignores headings inside fenced code blocks', () => {
    expect(extractMarkdownHeadings('```md\n# Hidden\n```\n## Visible')).toEqual([
      { level: 2, line: 4, text: 'Visible' },
    ])
  })
  it('uses the shared inline extensions and emoji for heading text', () => {
    expect(extractMarkdownHeadings('# ==**中文**== H~2~O x^hello\\ world^ <u>下划线</u> :smile:')).toEqual([
      { level: 1, line: 1, text: '中文 H2O xhello world 下划线 😄' },
    ])
    expect(extractMarkdownHeadings('# ==plain== x^2^ H~2~O :smile:', { ...defaultMarkdownExtensions, highlight: false, superscript: false, subscript: false, emoji: false })[0].text).toBe('==plain== x^2^ H~2~O :smile:')
  })
  it('keeps code literals, escaped shortcode syntax and decoded entities in the outline', () => {
    expect(extractMarkdownHeadings('# `==code== ~2~ :smile:` \\:smile: &amp; :slightly_smiling_face: a*b*c')[0].text).toBe('==code== ~2~ :smile: :smile: & 🙂 abc')
  })
})

describe('canonical outline block and label semantics', () => {
  it('keeps empty headings and literal trailing hashes in their source order', () => {
    expect(extractMarkdownHeadings('#\n\n# ###\n\n# A###\n\n# Heading\n---')).toEqual([
      { level: 1, line: 1, text: '' }, { level: 1, line: 3, text: '' },
      { level: 1, line: 5, text: 'A###' }, { level: 1, line: 7, text: 'Heading' },
    ])
  })

  it('includes quote/list headings and Setext headings without stripping container prefixes itself', () => {
    expect(extractMarkdownHeadings('> # Quote\n\n- ## List\n\n  List Setext\n  -----------\n')).toEqual([
      { level: 1, line: 1, text: 'Quote' }, { level: 2, line: 3, text: 'List' },
      { level: 2, line: 5, text: 'List Setext' },
    ])
  })

  it('keeps duplicate footnote and root headings as separate ordered entries', () => {
    expect(extractMarkdownHeadings('Footnote[^x].\n\n[^x]:\n    ## Repeat\n\n# Repeat')).toEqual([
      { level: 2, line: 4, text: 'Repeat' }, { level: 1, line: 6, text: 'Repeat' },
    ])
  })

  it('uses the first line of a multi-line Setext heading and preserves word boundaries', () => {
    expect(extractMarkdownHeadings('First line\r\nsecond line\r\n---\r\n')).toEqual([{ level: 2, line: 1, text: 'First line second line' }])
    expect(extractMarkdownHeadings('One  \nTwo\n---')).toEqual([{ level: 2, line: 1, text: 'One Two' }])
  })

  it.each([
    '```md\n# Hidden\n```not a close\n# Still hidden\n```',
    '~~~md\n# Hidden\n~~~~not a close\n# Still hidden\n~~~',
    '    # Hidden',
    '$$ metadata\n# Hidden\n$$',
    '<div>\n# Hidden\n</div>',
    '<script>\n# Hidden\n</script>',
    '<!--\n# Hidden\n-->',
    '<![CDATA[\n# Hidden\n]]>',
  ])('does not include literal block headings from %j', (literal) => {
    const source = `${literal}\n\n## Visible\n`
    expect(extractMarkdownHeadings(source)).toEqual([{ level: 2, line: source.split('\n').length - 1, text: 'Visible' }])
  })

  it('does not scan HTML preview headings as Markdown headings', () => {
    expect(extractMarkdownHeadings('<h1>HTML preview title</h1>\n\n# Markdown')).toEqual([{ level: 1, line: 3, text: 'Markdown' }])
  })

  it('uses the installed YAML fence grammar, including its unsupported dot-terminated boundary', () => {
    expect(extractMarkdownHeadings('---\n# Metadata\n---\n\n# Body')).toEqual([{ level: 1, line: 5, text: 'Body' }])
    expect(extractMarkdownHeadings('---\n# Not YAML under the installed parser\n...\n# Body')).toEqual([
      { level: 1, line: 2, text: 'Not YAML under the installed parser' }, { level: 1, line: 4, text: 'Body' },
    ])
  })

  it('derives enabled formats and emoji from transformed AST nodes and preserves disabled literal syntax', () => {
    const source = '# ==highlight== x^2^ H~2~O <u>underline</u> :smile:'
    expect(extractMarkdownHeadings(source)[0].text).toBe('highlight x2 H2O underline 😄')
    expect(extractMarkdownHeadings(source, { highlight: false, superscript: false, subscript: false, underline: false, emoji: false })[0].text).toBe('==highlight== x^2^ H~2~O <u>underline</u> :smile:')
  })

  it('keeps the installed positionless softbreak preprocessing semantics for multi-line custom markup', () => {
    expect(extractMarkdownHeadings('==one==\n:smile:\n---')[0].text).toBe('==one== :smile:')
    expect(extractMarkdownHeadings('**:smile:**\nnext\n---')[0].text).toBe('😄 next')
  })

  it('preserves code and math literals rather than interpreting emoji, entities or extension syntax inside them', () => {
    expect(extractMarkdownHeadings('# $x^2$ `==code== :smile: &amp;`')[0].text).toBe('x^2 ==code== :smile: &amp;')
    expect(extractMarkdownHeadings('# $:smile:$')[0].text).toBe(':smile:')
    expect(extractMarkdownHeadings('# `a  b`')[0].text).toBe('a  b')
  })

  it('decodes parsed text exactly once and leaves escaped/encoded markers unpaired', () => {
    expect(extractMarkdownHeadings('# &#38;amp; &equals;&equals;encoded&equals;&equals; \\==literal\\==')[0].text).toBe('&amp; ==encoded== ==literal==')
    expect(extractMarkdownHeadings('# :smile::+1: \\:smile: :unknown:')[0].text).toBe('😄👍 :smile: :unknown:')
  })

  it('retains inline HTML source as text, while native empty-break tokens are removed upstream', () => {
    expect(extractMarkdownHeadings('# <span>raw &amp;</span><!--note--><br>')[0].text).toBe('<span>raw &</span><!--note-->')
    expect(extractMarkdownHeadings('# <BR>')[0].text).toBe('<BR>')
  })

  it('uses image alt, reference label and formula text without dropping atom-only headings', () => {
    expect(extractMarkdownHeadings('# ![封面](cover.png)\n\n# $x^2$\n\n# ![别名][image]\n\n# [链接][link]\n\n[image]: cover.png\n[link]: https://example.com')).toEqual([
      { level: 1, line: 1, text: '封面' }, { level: 1, line: 3, text: 'x^2' },
      { level: 1, line: 5, text: '别名' }, { level: 1, line: 7, text: '链接' },
    ])
    expect(extractMarkdownHeadings('# ![](cover.png)\n\n# After')).toEqual([
      { level: 1, line: 1, text: '' }, { level: 1, line: 3, text: 'After' },
    ])
  })

  it.each(['<br />', '<br>', '<br >', '<br/>'])('collects headings after the real alert/empty-line transforms for %s', (breakToken) => {
    expect(extractMarkdownHeadings(`> # [!NOTE]${breakToken}\n>\n> # Next\n\n# Last`)).toEqual([
      { level: 1, line: 3, text: 'Next' }, { level: 1, line: 5, text: 'Last' },
    ])
  })

  it('retains a preceding empty HTML paragraph, but removes definitions before alert detection', () => {
    expect(extractMarkdownHeadings('> <br>\n>\n> # [!NOTE]\n>\n> # Next').map((heading) => heading.text)).toEqual(['[!NOTE]', 'Next'])
    expect(extractMarkdownHeadings('> [id]: /url\n>\n> # [!NOTE]\n>\n> # Next').map((heading) => heading.text)).toEqual(['Next'])
  })
})

describe('canonical source indexes against actual visual PM heading nodes', () => {
  it.each([
    '#\n\n# ###\n\n# After',
    '> # Repeat\n>\n> ## Repeat\n\n- ### Repeat\n\n  Repeat\n  ---\n',
    'Footnote[^x].\n\n[^x]:\n    ## Repeat\n\n# Repeat',
    '$$\n# Hidden\n$$\n\n<div>\n# Hidden\n</div>\n\n# Real',
    'First line\nsecond line\n---\n\n# Later',
    '# A###\n\n# Heading\n---',
    '> # [!NOTE]<br>\n>\n> # Next\n\n# Last',
    '> <br>\n>\n> # [!NOTE]\n>\n> # Next',
    '> [id]: /url\n>\n> # [!NOTE]\n>\n> # Next',
    '# ![](cover.png)\n\n# $x^2$\n\n# :smile:',
    '# <span>raw</span>\n\n# <u>under</u>',
    '---\ntitle: Title\n---\n\n# Visible',
    '---\n# Not YAML under the installed parser\n...\n# Body',
    '==one==\n:smile:\n---\n\n# Next',
    '# &#38;amp; &equals;&equals;encoded&equals;&equals;',
    '# [==label==][ref]\n\n[ref]: /url',
    '# [^a]\n\n[^a]: note',
  ])('keeps a one-to-one preorder index with the actual PM parser for %j', async (source) => {
    const parse = await visualParser(), doc = parse(source)
    const model: Array<{ level: number; position: number; text: string }> = []
    doc.descendants((node, position) => { if (node.type.name === 'heading') { model.push({ level: Number(node.attrs.level), position, text: modelHeadingLabel(node).trim() }); return false } })
    const outline = extractMarkdownHeadings(source)
    expect(model.map((heading) => heading.level)).toEqual(outline.map((heading) => heading.level))
    expect(model.map((heading) => heading.text)).toEqual(outline.map((heading) => heading.text))
    expect(model.every((heading, index) => index === 0 || heading.position > model[index - 1].position)).toBe(true)
    expect(outline.every((heading, index) => index === 0 || heading.line > outline[index - 1].line)).toBe(true)
    doc.check()
  })

  it('matches the actual PM literal labels when all custom inline extensions are disabled', async () => {
    const options = { highlight: false, superscript: false, subscript: false, underline: false, emoji: false }
    const source = '# ==mark== x^2^ H~2~O <u>raw</u> :smile:'
    const parse = await visualParser(options), doc = parse(source)
    expect(extractMarkdownHeadings(source, options).map((heading) => heading.text)).toEqual([modelHeadingLabel(doc.firstChild!).trim()])
  })
})

describe('native inline image schema compatibility', () => {
  it.each([
    { source: '# ![](cover.png)', src: 'cover.png', alt: '', title: '' },
    { source: 'Before ![中文说明](assets/photo%20one.png) after.', src: 'assets/photo%20one.png', alt: '中文说明', title: '' },
    { source: '# ![说明](cover.png "独立标题 & 图")', src: 'cover.png', alt: '说明', title: '独立标题 & 图' },
    { source: '# ![说明][photo]\n\n[photo]: cover.png', src: 'cover.png', alt: '说明', title: '' },
  ])('keeps a valid native image and its attributes through real parse/serialize for $source', async ({ source, src, alt, title }) => {
    const { parse, serialize } = await visualDocumentHarness()
    const doc = parse(source)
    doc.check()
    const images: ProseNode[] = []
    doc.descendants((node) => { if (node.type.name === 'image') images.push(node) })
    expect(images).toHaveLength(1)
    expect(images[0].attrs).toEqual({ src, alt, title })
    const output = serialize(doc)
    const reopened = parse(output)
    reopened.check()
    expect(reopened.eq(doc)).toBe(true)
    if (!title) expect(output).not.toContain('""')
  })
})
