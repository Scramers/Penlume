import { describe, expect, it } from 'vitest'
import { remark } from 'remark'
import remarkMath from 'remark-math'
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { history, redo, undo, closeHistory } from '@milkdown/kit/prose/history'
import { ParserState, SerializerState, type NodeSchema } from '@milkdown/kit/transformer'
import { compatibleCodeBlockSchema, displayMathSchema, inlineMathSchema, renderMathPreview } from '../src/renderer/editor/code-math-schema'

function harness() {
  const container = (name: string, markdown: string, content: string, group?: string): NodeSchema => ({
    content, group,
    parseMarkdown: { match: ({ type }) => type === markdown, runner: (state, node, type) => { state.openNode(type); state.next(node.children); state.closeNode() } },
    toMarkdown: { match: (node) => node.type.name === name, runner: (state, node) => { state.openNode(markdown); state.next(node.content); state.closeNode() } },
  })
  const nodes: Record<string, NodeSchema> = {
    doc: { content: 'block+', parseMarkdown: { match: ({ type }) => type === 'root', runner: (state, node, type) => { state.injectRoot(node, type) } }, toMarkdown: { match: (node) => node.type.name === 'doc', runner: (state, node) => { state.openNode('root'); state.next(node.content) } } },
    paragraph: container('paragraph', 'paragraph', 'inline*', 'block'),
    blockquote: container('blockquote', 'blockquote', 'block+', 'block'),
    bullet_list: { ...container('bullet_list', 'list', 'list_item+', 'block'), toMarkdown: { match: (node) => node.type.name === 'bullet_list', runner: (state, node) => { state.openNode('list', undefined, { ordered: false, spread: true }); state.next(node.content); state.closeNode() } } },
    list_item: { ...container('list_item', 'listItem', 'block+'), toMarkdown: { match: (node) => node.type.name === 'list_item', runner: (state, node) => { state.openNode('listItem', undefined, { spread: true }); state.next(node.content); state.closeNode() } } },
    code_block: compatibleCodeBlockSchema({
      group: 'block', content: 'text*', marks: '', code: true, attrs: { language: { default: '' } },
      parseMarkdown: { match: () => false, runner: () => undefined },
      // Emulate upstream's old mistaken behavior: the compatibility runner must replace it.
      toMarkdown: { match: () => true, runner: (state, node) => { state.addNode('math', undefined, node.textContent) } },
    }),
    math_block: displayMathSchema(), math_inline: inlineMathSchema(),
    text: { group: 'inline', parseMarkdown: { match: ({ type }) => type === 'text', runner: (state, node) => { state.addText(String(node.value ?? '')) } }, toMarkdown: { match: (node) => node.type.name === 'text', runner: (state, node) => { state.addNode('text', undefined, node.text ?? '') } } },
  }
  const schema = new Schema({ nodes })
  const processor = remark().use(remarkMath)
  return { schema, parse: ParserState.create(schema, processor), serialize: SerializerState.create(schema, processor) }
}

function semanticBlocks(doc: ProseNode) {
  const blocks: Array<{ type: string; text: string; attrs: Record<string, unknown> }> = []
  doc.descendants((node) => { if (['code_block', 'math_block', 'math_inline'].includes(node.type.name)) blocks.push({ type: node.type.name, text: node.textContent, attrs: { ...node.attrs } }) })
  return blocks
}

describe('code and true math Markdown compatibility', () => {
  it('never treats an ordinary latex, LaTeX or math language fence as display math', () => {
    const { parse, serialize } = harness()
    for (const language of ['latex', 'LaTeX', 'LATEX', 'math', 'tex', 'javascript']) {
      const source = `\`\`\`${language} title="代码示例" {1,3-5}\n\\begin{document}\n普通代码正文\n\\end{document}\n\`\`\`\n\nBody\n`
      const doc = parse(source)
      expect(doc.firstChild?.type.name).toBe('code_block')
      expect(doc.firstChild?.attrs).toEqual({ language, meta: 'title="代码示例" {1,3-5}' })
      let state = EditorState.create({ doc })
      state = state.apply(state.tr.insertText(' edited', state.doc.content.size - 1))
      const output = serialize(state.doc)
      expect(output).toContain(`\`\`\`${language} title="代码示例" {1,3-5}`)
      expect(output).not.toContain('$$')
      expect(output).toContain('Body edited')
      expect(parse(output).firstChild?.eq(doc.firstChild!)).toBe(true)
    }
  })

  it('preserves true display math and inline formulas after unrelated body edits', () => {
    const { parse, serialize } = harness()
    const doc = parse('$$ equation-label\nx^2 + y^2 = z^2\n$$\n\nBody $E = mc^2$ after\n')
    expect(doc.firstChild?.type.name).toBe('math_block')
    expect(doc.firstChild?.attrs).toEqual({ meta: 'equation-label' })
    let state = EditorState.create({ doc })
    state = state.apply(state.tr.insertText(' edited', state.doc.content.size - 1))
    const output = serialize(state.doc)
    expect(output).toContain('$$equation-label\nx^2 + y^2 = z^2\n$$')
    expect(output).toContain('$E = mc^2$')
    expect(output).not.toContain('```LaTeX')
    expect(semanticBlocks(parse(output))).toEqual(semanticBlocks(doc))
  })

  it('retains quote and list containers around independent code and formula nodes', () => {
    const { parse, serialize } = harness()
    const source = '> ```latex title="quote.tex"\n> x &= y\n> ```\n>\n> $$ quoted-equation\n> a+b=c\n> $$\n\n- Item\n\n  ```math {2}\n  math language code\n  ```\n\n  $$ list-equation\n  c^2 = a^2 + b^2\n  $$\n\nBody\n'
    const doc = parse(source)
    const before = semanticBlocks(doc)
    expect(before.map((block) => block.type)).toEqual(['code_block', 'math_block', 'code_block', 'math_block'])
    expect(doc.firstChild?.type.name).toBe('blockquote')
    expect(doc.child(1).type.name).toBe('bullet_list')
    const state = EditorState.create({ doc })
    const edited = state.apply(state.tr.insertText(' edited', state.doc.content.size - 1))
    const reopened = parse(serialize(edited.doc))
    expect(semanticBlocks(reopened)).toEqual(before)
    expect(reopened.firstChild?.type.name).toBe('blockquote')
    expect(reopened.child(1).type.name).toBe('bullet_list')
  })

  it('keeps multiline source, trailing blanks and info metadata through actual history', () => {
    const { parse, serialize } = harness()
    const source = '```latex title="a & b.tex" linenos {1,3-5}\n\\frac{a}{b}\n\n\\alpha + \\beta  \n```\n\n$$ equation\nx^2\n\n+y^2  \n$$\n\nBody\n'
    let state = EditorState.create({ doc: parse(source), plugins: [history()] })
    const original = serialize(state.doc)
    expect(state.doc.firstChild?.attrs.meta).toBe('title="a & b.tex" linenos {1,3-5}')
    expect(state.doc.firstChild?.textContent.endsWith('  ')).toBe(true)
    const formulaPosition = state.doc.firstChild!.nodeSize
    state = state.apply(state.tr.insertText('+z', formulaPosition + 1))
    const edited = serialize(state.doc)
    expect(parse(edited).child(1).textContent).toBe('+zx^2\n\n+y^2  ')
    expect(parse(edited).firstChild?.attrs).toEqual(state.doc.firstChild?.attrs)
    expect(undo(state, (tr) => { state = state.apply(tr) })).toBe(true)
    expect(serialize(state.doc)).toBe(original)
    expect(redo(state, (tr) => { state = state.apply(tr) })).toBe(true)
    expect(serialize(state.doc)).toBe(edited)
    state = state.apply(closeHistory(state.tr).setNodeAttribute(0, 'meta', 'title="new.tex"'))
    expect(serialize(state.doc)).toContain('```latex title="new.tex"')
    expect(undo(state, (tr) => { state = state.apply(tr) })).toBe(true)
    expect(serialize(state.doc)).toBe(edited)
  })

  it('keeps empty and unlabelled code and math as their own types', () => {
    const { parse, serialize } = harness()
    for (const source of ['```\n\n```\n', '~~~latex\n~~~\n', '$$\n$$\n']) {
      const doc = parse(source)
      const output = serialize(doc)
      expect(semanticBlocks(parse(output))).toEqual(semanticBlocks(doc))
      expect(doc.firstChild?.attrs.meta).toBeNull()
      expect(doc.firstChild?.type.name).toBe(source.startsWith('$$') ? 'math_block' : 'code_block')
    }
  })

  it('keeps language changes independent of true math and metadata', () => {
    const { parse, serialize } = harness()
    let state = EditorState.create({ doc: parse('```js {2}\nlet n = 1\n```\n') })
    state = state.apply(state.tr.setNodeAttribute(0, 'language', 'LaTeX'))
    const output = serialize(state.doc)
    expect(output).toContain('```LaTeX {2}')
    expect(output).not.toContain('$$')
    expect(parse(output).firstChild?.attrs).toEqual({ language: 'LaTeX', meta: '{2}' })
  })

  it('uses CodeMirror line breaks for CRLF code and math without losing Unicode source or metadata', () => {
    const { parse, serialize } = harness()
    const doc = parse('> ```latex title="中文.tex"\r\n> 第一行🙂\r\n> 第二行\\alpha\r\n> ```\r\n>\r\n> $$ equation\r\n> a^2\r\n> +b^2\r\n> $$\r\n')
    const blocks = semanticBlocks(doc)
    expect(blocks.map((block) => block.text)).toEqual(['第一行🙂\n第二行\\alpha', 'a^2\n+b^2'])
    expect(blocks[0].attrs).toEqual({ language: 'latex', meta: 'title="中文.tex"' })
    expect(semanticBlocks(parse(serialize(doc)))).toEqual(blocks)
  })

  it('keeps malformed formula source editable through serialization and undo', () => {
    const { parse, serialize } = harness()
    let state = EditorState.create({ doc: parse('$$\n\\frac{a}\n$$\n\nBody $\\unknowncommand$\n'), plugins: [history()] })
    const original = serialize(state.doc)
    expect(renderMathPreview(state.doc.firstChild!.textContent, true).error).toContain('KaTeX parse error')
    state = state.apply(state.tr.insertText('{b}', 1 + state.doc.firstChild!.content.size))
    expect(renderMathPreview(state.doc.firstChild!.textContent, true)).toMatchObject({ error: null, html: expect.stringContaining('class="katex') })
    expect(parse(serialize(state.doc)).firstChild!.textContent).toBe('\\frac{a}{b}')
    expect(undo(state, (tr) => { state = state.apply(tr) })).toBe(true)
    expect(serialize(state.doc)).toBe(original)
  })

  it('renders diagnostics as data and disallows trusted HTML and URL commands', () => {
    const invalid = renderMathPreview('\\invalidcommand{<img src=x onerror=alert(1)>}', true)
    expect(invalid.html).toBeNull()
    expect(invalid.error).toContain('Undefined control sequence')
    const url = renderMathPreview('\\href{javascript:alert(1)}{click}', false)
    expect(url.html).not.toContain('<a ')
    expect(url.html).not.toContain('href=')
    const html = renderMathPreview('\\htmlClass{evil}{x}', false)
    expect(html.html).not.toContain('class="evil"')
    expect(renderMathPreview('\\frac{1}{2}', true).error).toBeNull()
  })
})
