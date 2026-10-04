import { describe, expect, it } from 'vitest'
import { remark } from 'remark'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root } from 'mdast'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { history, redo, undo } from '@milkdown/kit/prose/history'
import { ParserState, SerializerState, type NodeSchema } from '@milkdown/kit/transformer'
import { blockImageAttributes, blockImageRatio, blockImageResizeWidth, parseResizedBlockImage, remarkBlockImageCompatibility, restoreResizedBlockImages, serializeResizedBlockImage, type BlockImageAttributes } from '../src/shared/block-image-markdown'
import { compatibleBlockImageSchema } from '../src/renderer/editor/image-compatibility'
import { renderDocumentHtml } from '../src/renderer/export-document'
import { sanitizePandocMarkdownHtml } from '../src/main/pandoc-html'
import { remarkEditorExtensions } from '../src/shared/markdown-extensions'

const image: BlockImageAttributes = { src: 'assets/图 片.png?x=1&y=2', alt: '用户图片说明', caption: '独立标题', ratio: 1.25, resizeWidth: 500 }

// Real Milkdown parser/serializer plus ProseMirror history exercise the overridden runners.
// The small document schema supplies only surrounding text blocks, not image behavior.
function editorHarness() {
  const nodes: Record<string, NodeSchema> = {
    doc: {
      content: 'block+',
      parseMarkdown: { match: ({ type }) => type === 'root', runner: (state, node, type) => { state.injectRoot(node, type) } },
      toMarkdown: { match: (node) => node.type.name === 'doc', runner: (state, node) => { state.openNode('root'); state.next(node.content) } },
    },
    paragraph: {
      group: 'block', content: 'inline*',
      parseMarkdown: { match: ({ type }) => type === 'paragraph', runner: (state, node, type) => { state.openNode(type); state.next(node.children); state.closeNode() } },
      toMarkdown: { match: (node) => node.type.name === 'paragraph', runner: (state, node) => { state.openNode('paragraph'); state.next(node.content); state.closeNode() } },
    },
    text: {
      group: 'inline',
      parseMarkdown: { match: ({ type }) => type === 'text', runner: (state, node) => { state.addText(String(node.value ?? '')) } },
      toMarkdown: { match: (node) => node.type.name === 'text', runner: (state, node) => { state.addNode('text', undefined, node.text ?? '') } },
    },
    'image-block': compatibleBlockImageSchema({
      group: 'block', atom: true,
      attrs: { src: { default: '' }, caption: { default: '' }, ratio: { default: 1 } },
      parseMarkdown: { match: () => false, runner: () => undefined },
      toMarkdown: { match: () => false, runner: () => undefined },
    }),
  }
  const schema = new Schema({ nodes })
  const processor = remark().use(remarkBlockImageCompatibility).use(() => (tree: Root) => {
    // Same public AST contract as Crepe's single-image paragraph promotion.
    tree.children = tree.children.map((node) => node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'image'
      ? { ...node.children[0], type: 'image-block' } as unknown as Root['children'][number] : node)
  })
  return { schema, parse: ParserState.create(schema, processor), serialize: SerializerState.create(schema, processor) }
}

describe('block image Markdown compatibility', () => {
  it('keeps numeric and empty alt as descriptions with an independent title', () => {
    for (const alt of ['0.75', '1.00', '0', '', '图示']) expect(blockImageAttributes({ url: 'x.png', alt, title: 'Caption' })).toEqual({ src: 'x.png', alt, caption: 'Caption', ratio: 1, resizeWidth: null })
    expect(blockImageAttributes({ url: 'x.png', alt: '0.25', ttyporaRatio: 0.8 }).ratio).toBe(0.8)
    expect(blockImageAttributes({}).caption).toBe('')
  })

  it('round trips escaped Unicode alt, title and URL without exposing markup', () => {
    const attributes = { ...image, alt: '引号 " & <标签>\n下一行\t说明', caption: '标题\r\n"文档" & ©' }
    const html = serializeResizedBlockImage(attributes)!
    expect(html).toContain('width="500" data-ttypora-ratio="1.25"')
    expect(html).toContain('&quot; &amp; &lt;标签&gt;&#10;')
    expect(html).not.toContain('<标签>')
    expect(parseResizedBlockImage(`\n${html}\n`)).toEqual(attributes)
  })

  it('keeps finite legacy percentages readable and returns ordinary Markdown after resetting resize', () => {
    expect(serializeResizedBlockImage({ ...image, ratio: 0.57, resizeWidth: null })).toContain('width="57%"')
    for (const ratio of [1, 0, -0.5, NaN, Infinity, 0.00001, 10.01, 1e200, Number.MAX_VALUE]) {
      expect(serializeResizedBlockImage({ ...image, ratio, resizeWidth: null })).toBeNull()
      expect(blockImageRatio(ratio)).toBe(1)
    }
    for (const ratio of [0.75, 1.5, 0.0001, 10]) {
      const html = serializeResizedBlockImage({ ...image, ratio, resizeWidth: null })!
      expect(html).not.toMatch(/width="[^"%]*e/)
      expect(parseResizedBlockImage(html)).toMatchObject({ ratio, resizeWidth: null })
    }
  })

  it('bounds explicit pixel metadata and keeps pixel sizing independent of container percentage', () => {
    for (const resizeWidth of [0, -1, NaN, Infinity, 100000.01, 1e200]) {
      expect(blockImageResizeWidth(resizeWidth)).toBeNull()
      expect(serializeResizedBlockImage({ ...image, resizeWidth })).toBeNull()
    }
    for (const resizeWidth of [0.5, 500, 500.25, 100000]) {
      expect(parseResizedBlockImage(serializeResizedBlockImage({ ...image, resizeWidth })!)).toEqual({ ...image, resizeWidth })
    }
    expect(blockImageAttributes({ ttyporaRatio: 1.25, ttyporaResizeWidth: 500 })).toMatchObject({ ratio: 1.25, resizeWidth: 500 })
    expect(serializeResizedBlockImage(image)).toContain('width="500"')
    expect(serializeResizedBlockImage(image)).not.toContain('width="125%"')
  })

  it('rejects complex, unknown, inconsistent or noncanonical hand-written HTML', () => {
    const html = serializeResizedBlockImage(image)!
    const variants = [
      html.replace('width="500"', 'width="0"'), html.replace('width="500"', 'width="100001"'), html.replace('ratio="1.25"', 'ratio="NaN"'),
      html.replace('ratio="1.25"', 'ratio="100000000000000000000"'), html.replace('>', ' onclick="bad()">'),
      html.replace('>', ' loading="lazy">'), html.replace('>', ' />'), html.replace('src=', 'SRC='),
      html.replace('&amp;', '&copy;'), `<figure>${html}</figure>`, `${html}\n${html}`,
      html.replace('alt="用户图片说明"', "alt='用户图片说明'"),
      '<img src="x.png" alt="0.75" title="Caption" width="75%">',
    ]
    for (const variant of variants) expect(parseResizedBlockImage(variant), variant).toBeNull()
  })

  it('restores generated standalone images in document, quote and list blocks before raw HTML promotion', () => {
    const html = serializeResizedBlockImage(image)!
    const processor = remark().use(remarkBlockImageCompatibility)
    const tree = processor.runSync(processor.parse(`${html}\n\n> ${html}\n\n- ${html}\n`)) as unknown as { type: string; children?: unknown[] }
    const serialized = JSON.stringify(tree)
    expect(serialized.match(/"type":"image-block"/g)).toHaveLength(3)
    expect(serialized.match(/"ttyporaRatio":1.25/g)).toHaveLength(3)
    expect(serialized.match(/"ttyporaResizeWidth":500/g)).toHaveLength(3)
    expect(serialized).toContain('用户图片说明')
  })

  it('leaves raw HTML, inline images, code and front matter to their existing handlers', () => {
    const html = serializeResizedBlockImage(image)!
    const input = `---\ntitle: '${html}'\n---\n\n\`\`\`html\n${html}\n\`\`\`\n\nBefore ${html} after.\n\n${html.replace('>', ' class="manual">')}\n`
    const processor = remark().use(remarkFrontmatter, ['yaml'])
    const before = processor.parse(input)
    const after = structuredClone(before)
    restoreResizedBlockImages(after)
    expect(after).toEqual(before)
    const standalone = processor.runSync(processor.parse(html))
    restoreResizedBlockImages(standalone)
    // The application raw-HTML extension must not claim the restored native image block.
    const combined = remark().use(remarkBlockImageCompatibility).use(remarkEditorExtensions)
    const promoted = combined.runSync(combined.parse(html))
    expect((promoted as Root).children[0].type).toBe('image-block')
  })

  it('keeps standard Markdown alt and caption after real document text edits', () => {
    const { parse, serialize } = editorHarness()
    for (const alt of ['用户图片说明', '0.75', '']) {
      const doc = parse(`![${alt}](assets/photo.png "Caption")\n\nBefore\n`)
      expect(doc.firstChild?.attrs).toMatchObject({ src: 'assets/photo.png', alt, caption: 'Caption', ratio: 1 })
      const state = EditorState.create({ doc })
      const edited = state.apply(state.tr.insertText(' edited', state.doc.content.size - 1))
      const output = serialize(edited.doc)
      expect(output).toContain(`![${alt}](assets/photo.png "Caption")`)
      expect(output).toContain('Before edited')
      expect(output).not.toContain('data-ttypora-ratio')
      expect(parse(output).firstChild?.attrs).toEqual(doc.firstChild?.attrs)
    }
  })

  it('stores resizing in serialized changes and preserves description through actual undo and redo', () => {
    const { parse, serialize } = editorHarness()
    let state = EditorState.create({ doc: parse('![用户图片说明](photo.png "Caption")\n'), plugins: [history()] })
    const original = serialize(state.doc)
    state = state.apply(state.tr.setNodeAttribute(0, 'ratio', 1.25).setNodeAttribute(0, 'resizeWidth', 500))
    const resized = serialize(state.doc)
    expect(resized).not.toBe(original)
    expect(resized).toContain('alt="用户图片说明" title="Caption" width="500" data-ttypora-ratio="1.25"')
    const reopened = parse(resized)
    expect(reopened.firstChild?.attrs).toMatchObject({ alt: '用户图片说明', caption: 'Caption', ratio: 1.25, resizeWidth: 500 })
    expect(serialize(reopened)).toBe(resized)
    expect(undo(state, (transaction) => { state = state.apply(transaction) })).toBe(true)
    expect(serialize(state.doc)).toBe(original)
    expect(redo(state, (transaction) => { state = state.apply(transaction) })).toBe(true)
    expect(serialize(state.doc)).toBe(resized)
    state = state.apply(state.tr.setNodeAttribute(0, 'ratio', 1))
    expect(serialize(state.doc)).toContain('width="500" data-ttypora-ratio="1"')
    state = state.apply(state.tr.setNodeAttribute(0, 'ratio', 1).setNodeAttribute(0, 'resizeWidth', null))
    expect(serialize(state.doc)).toBe(original)
  })

  it('round trips an explicit pixel width when ratio is one and only clears sizing with an explicit reset', () => {
    const { parse, serialize } = editorHarness()
    const attributes = { ...image, ratio: 1 }
    const html = serializeResizedBlockImage(attributes)!
    expect(html).toContain('width="500" data-ttypora-ratio="1"')
    expect(parseResizedBlockImage(html)).toEqual(attributes)
    let state = EditorState.create({ doc: parse(`${html}\n\nBefore\n`) })
    expect(state.doc.firstChild?.attrs).toMatchObject({ ratio: 1, resizeWidth: 500 })
    expect(serialize(state.doc)).toContain(html)
    state = state.apply(state.tr.insertText(' edited', state.doc.content.size - 1))
    expect(serialize(state.doc)).toContain(html)
    const reopened = parse(serialize(state.doc))
    expect(reopened.firstChild?.attrs).toMatchObject({ ratio: 1, resizeWidth: 500 })
    state = state.apply(state.tr.setNodeAttribute(0, 'ratio', 1).setNodeAttribute(0, 'resizeWidth', null))
    const reset = serialize(state.doc)
    expect(reset).toContain('![用户图片说明]')
    expect(reset).not.toContain('data-ttypora-ratio')
    expect(parse(reset).firstChild?.attrs).toMatchObject({ ratio: 1, resizeWidth: null })
  })

  it('edits caption without changing alt or the stored resize ratio', () => {
    const { parse, serialize } = editorHarness()
    const doc = parse(serializeResizedBlockImage(image)!)
    const state = EditorState.create({ doc })
    const edited = state.apply(state.tr.setNodeAttribute(0, 'caption', '新标题'))
    expect(parse(serialize(edited.doc)).firstChild?.attrs).toMatchObject({ alt: image.alt, caption: '新标题', ratio: image.ratio, resizeWidth: 500 })
  })

  it('does not infer or write pixel width when parsing, serializing or editing unrelated text', () => {
    const { parse, serialize } = editorHarness()
    const legacy = serializeResizedBlockImage({ ...image, ratio: 0.75, resizeWidth: null })!
    let state = EditorState.create({ doc: parse(`${legacy}\n\nBefore\n`) })
    expect(state.doc.firstChild?.attrs.resizeWidth).toBeNull()
    expect(serialize(state.doc)).toContain(legacy)
    expect(parse(serialize(state.doc)).firstChild?.attrs.resizeWidth).toBeNull()
    state = state.apply(state.tr.insertText(' edited', state.doc.content.size - 1))
    expect(serialize(state.doc)).toContain(legacy)
    expect(state.doc.firstChild?.attrs.resizeWidth).toBeNull()
    // The first explicit resize stores both values together; later body changes keep those pixels.
    state = state.apply(state.tr.setNodeAttribute(0, 'ratio', 1.25).setNodeAttribute(0, 'resizeWidth', 500))
    state = state.apply(state.tr.insertText(' again', state.doc.content.size - 1))
    expect(serialize(state.doc)).toContain(serializeResizedBlockImage(image)!)
    expect(state.doc.firstChild?.attrs).toMatchObject({ resizeWidth: 500, ratio: 1.25 })
  })

  it('keeps malformed or inconsistent resize HTML verbatim in the application raw HTML block', () => {
    const original = serializeResizedBlockImage(image)!
    const processor = remark().use(remarkBlockImageCompatibility).use(remarkEditorExtensions)
    const legacy = serializeResizedBlockImage({ ...image, ratio: 0.75, resizeWidth: null })!
    for (const html of [original.replace('width="500"', 'width="100001"'), legacy.replace('width="75%"', 'width="20%"'), original.replace('ratio="1.25"', 'ratio="1e200"'), original.replace('>', ' aria-label="manual">')]) {
      const tree = processor.runSync(processor.parse(html), html) as Root
      expect(tree.children[0]).toMatchObject({ type: 'ttyporaHtmlBlock', value: html })
    }
  })

  it('preserves separate accessible alt and title in DOM serialization and clipboard parsing', () => {
    const { schema } = editorHarness()
    const node = schema.nodes['image-block'].create(image)
    const specification = schema.nodes['image-block'].spec
    const output = specification.toDOM!(node) as [string, Record<string, unknown>]
    expect(output).toEqual(['img', { 'data-type': 'image-block', src: image.src, alt: image.alt, title: image.caption, width: 500, 'data-ttypora-ratio': 1.25 }])
    const legacyOutput = specification.toDOM!(schema.nodes['image-block'].create({ ...image, ratio: 0.75, resizeWidth: null })) as [string, Record<string, unknown>]
    expect(legacyOutput[1].width).toBe('75%')
    const rule = specification.parseDOM![0]
    const getAttrs = rule.getAttrs!
    const element = (attributes: Record<string, string>) => ({ getAttribute: (name: string) => attributes[name] ?? null }) as unknown as HTMLElement
    expect(getAttrs(element({ src: 'photo.png', alt: '0.75', title: 'Caption', width: '500', 'data-ttypora-ratio': '1.25' }))).toEqual({ src: 'photo.png', alt: '0.75', caption: 'Caption', ratio: 1.25, resizeWidth: 500 })
    expect(getAttrs(element({ src: 'photo.png', alt: '0.75', title: 'Caption', width: '50%', 'data-ttypora-ratio': '0.5' }))).toMatchObject({ ratio: 0.5, resizeWidth: null })
    expect(getAttrs(element({ src: 'photo.png', alt: '0.75', caption: 'Legacy caption', width: '100001', ratio: '1e200' }))).toEqual({ src: 'photo.png', alt: '0.75', caption: 'Legacy caption', ratio: 1, resizeWidth: null })
    expect(getAttrs(element({ src: 'photo.png', alt: '0.75', title: '', caption: 'Legacy caption' }))).toMatchObject({ alt: '0.75', caption: '', ratio: 1 })
  })

  it('retains width, alt and title in the real standalone HTML exporter', async () => {
    const output = await renderDocumentHtml(serializeResizedBlockImage(image)!, 'Image export')
    expect(output).toContain('width="500"')
    expect(output).toContain('alt="用户图片说明"')
    expect(output).toContain('title="独立标题"')
    expect(output).not.toContain('data-ttypora-ratio')
  })

  it('retains visible dimensions and accessible text through actual Pandoc input sanitization', async () => {
    const output = await sanitizePandocMarkdownHtml(serializeResizedBlockImage(image)!)
    expect(output).toContain('width="500"')
    expect(output).toContain('alt="用户图片说明"')
    expect(output).toContain('title="独立标题"')
    expect(output).not.toContain('data-ttypora-ratio')
  })
})
