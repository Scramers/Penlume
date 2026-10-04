import { describe, expect, it } from 'vitest'
import { remark } from 'remark'
import remarkMath from 'remark-math'
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection, type Transaction } from '@milkdown/kit/prose/state'
import { history, redo, undo, undoDepth } from '@milkdown/kit/prose/history'
import { ParserState, SerializerState, type NodeSchema } from '@milkdown/kit/transformer'
import { displayMathSchema, inlineMathSchema } from '../src/renderer/editor/code-math-schema'
import { inlineMathValueTransaction } from '../src/renderer/editor/code-math-view'

function harness() {
  const container = (name: string, markdown: string, content: string, group?: string): NodeSchema => ({
    content, group,
    parseMarkdown: { match: (node) => node.type === markdown, runner: (state, node, type) => { state.openNode(type); state.next(node.children); state.closeNode() } },
    toMarkdown: { match: (node) => node.type.name === name, runner: (state, node) => { state.openNode(markdown); state.next(node.content); state.closeNode() } },
  })
  const schema = new Schema({ nodes: {
    doc: { content: 'block+', parseMarkdown: { match: (node) => node.type === 'root', runner: (state, node, type) => { state.injectRoot(node, type) } }, toMarkdown: { match: (node) => node.type.name === 'doc', runner: (state, node) => { state.openNode('root'); state.next(node.content) } } },
    paragraph: container('paragraph', 'paragraph', 'inline*', 'block'),
    blockquote: container('blockquote', 'blockquote', 'block+', 'block'),
    math_block: displayMathSchema(), math_inline: inlineMathSchema(),
    text: { group: 'inline', parseMarkdown: { match: (node) => node.type === 'text', runner: (state, node) => { state.addText(String(node.value ?? '')) } }, toMarkdown: { match: (node) => node.type.name === 'text', runner: (state, node) => { state.addNode('text', undefined, node.text ?? '') } } },
  } satisfies Record<string, NodeSchema> })
  const processor = remark().use(remarkMath)
  const paragraph = (text: string) => schema.node('paragraph', null, schema.text(text))
  const following = paragraph('Following paragraph must stay prose.')
  const inlineDocument = (value: string, standalone: boolean) => schema.node('doc', null, [
    schema.node('paragraph', null, standalone ? [schema.nodes.math_inline.create({ value })] : [schema.text('Before '), schema.nodes.math_inline.create({ value }), schema.text(' after')]),
    following,
  ])
  return { schema, following, inlineDocument, parse: ParserState.create(schema, processor), serialize: SerializerState.create(schema, processor) }
}

function inlinePosition(doc: ProseNode): number {
  let position: number | undefined
  doc.descendants((node, offset) => { if (node.type.name === 'math_inline') position = offset })
  if (position === undefined) throw new Error('Inline formula is absent')
  return position
}

function formulas(doc: ProseNode) {
  const nodes: Array<{ type: string; value: string }> = []
  doc.descendants((node) => {
    if (node.type.name === 'math_inline') nodes.push({ type: node.type.name, value: String(node.attrs.value) })
    if (node.type.name === 'math_block') nodes.push({ type: node.type.name, value: node.textContent })
  })
  return nodes
}

describe('empty inline formula persistence and clearing', () => {
  for (const standalone of [false, true]) {
    const location = standalone ? 'its own paragraph' : 'the middle of prose'
    it(`omits an empty editable draft in ${location} without introducing dollars or consuming following prose`, () => {
      const { inlineDocument, parse, serialize, following } = harness()
      const draft = inlineDocument('', standalone), output = serialize(draft), reopened = parse(output)
      expect(formulas(draft)).toEqual([{ type: 'math_inline', value: '' }])
      expect(output).not.toContain('$')
      expect(formulas(reopened)).toEqual([])
      expect(reopened.lastChild?.eq(following)).toBe(true)
      expect(reopened.textContent).toBe((standalone ? '' : 'Before  after') + following.textContent)
      expect(parse(serialize(reopened)).eq(reopened)).toBe(true)
    })

    it.each([' ', '  ', '\t', '\n', ' \r\n ', 'x+y', '\\frac{1}{2}', '$'])('retains the nonempty formula %j and following prose through repeated actual serialization', (value) => {
      const { inlineDocument, parse, serialize, following } = harness()
      let doc = inlineDocument(value, standalone)
      for (let pass = 0; pass < 4; pass++) {
        const output = serialize(doc)
        doc = parse(output)
        expect(formulas(doc), `${location}, pass ${pass}`).toEqual([{ type: 'math_inline', value }])
        expect(doc.lastChild?.eq(following)).toBe(true)
        expect(doc.childCount).toBe(2)
      }
    })

    it.each(['x', ' ', '\\frac{1}{2}'])(`clears an existing %j formula in ${location} as one undoable deletion`, (value) => {
      const { inlineDocument, parse, serialize, following } = harness()
      const original = inlineDocument(value, standalone), position = inlinePosition(original)
      let state = EditorState.create({ doc: original, selection: NodeSelection.create(original, position), plugins: [history()] })
      const dispatch = (transaction: Transaction) => { state = state.apply(transaction); state.doc.check() }
      const transaction = inlineMathValueTransaction(state, position, '')!
      expect(transaction).not.toBeNull()
      const applied = state.applyTransaction(transaction)
      expect(applied.transactions).toHaveLength(1)
      state = applied.state
      const cleared = state.doc
      expect(formulas(cleared)).toEqual([])
      expect(cleared.lastChild?.eq(following)).toBe(true)
      expect(formulas(parse(serialize(cleared)))).toEqual([])
      expect(parse(serialize(cleared)).lastChild?.eq(following)).toBe(true)
      expect(undoDepth(state)).toBe(1)
      expect(undo(state, dispatch)).toBe(true)
      expect(state.doc.eq(original)).toBe(true)
      expect(undoDepth(state)).toBe(0)
      expect(redo(state, dispatch)).toBe(true)
      expect(state.doc.eq(cleared)).toBe(true)
    })
  }

  it('keeps a newly inserted empty draft editable until real input supplies its source', () => {
    const { inlineDocument, parse, serialize } = harness()
    const original = inlineDocument('', false), position = inlinePosition(original)
    let state = EditorState.create({ doc: original, plugins: [history()] })
    for (const composing of [true, false]) expect(inlineMathValueTransaction(state, position, '', composing)).toBeNull()
    expect(state.doc.eq(original)).toBe(true)
    state = state.apply(inlineMathValueTransaction(state, position, 'x+y')!)
    expect(formulas(state.doc)).toEqual([{ type: 'math_inline', value: 'x+y' }])
    expect(formulas(parse(serialize(state.doc)))).toEqual([{ type: 'math_inline', value: 'x+y' }])
  })

  it('does not mutate the document or history for temporary empty IME input or an unchanged cancellation', () => {
    const { inlineDocument } = harness()
    const original = inlineDocument('x+y', false), position = inlinePosition(original)
    const state = EditorState.create({ doc: original, plugins: [history()] })
    for (let update = 0; update < 3; update++) expect(inlineMathValueTransaction(state, position, '', true)).toBeNull()
    expect(state.doc.eq(original)).toBe(true)
    expect(undoDepth(state)).toBe(0)
    expect(inlineMathValueTransaction(state, position, 'x+y', false)).toBeNull()
    expect(undoDepth(state)).toBe(0)
  })

  it.each(['', '新公式'])('commits the final IME value %j after a temporary empty replacement in one reversible transaction', (value) => {
    const { inlineDocument, parse, serialize, following } = harness()
    const original = inlineDocument('x+y', false), position = inlinePosition(original)
    let state = EditorState.create({ doc: original, selection: NodeSelection.create(original, position), plugins: [history()] })
    const dispatch = (transaction: Transaction) => { state = state.apply(transaction); state.doc.check() }
    expect(inlineMathValueTransaction(state, position, '', true)).toBeNull()
    const applied = state.applyTransaction(inlineMathValueTransaction(state, position, value, false)!)
    expect(applied.transactions).toHaveLength(1)
    state = applied.state
    const committed = state.doc
    const expected = value ? [{ type: 'math_inline', value }] : []
    expect(formulas(committed)).toEqual(expected)
    expect(formulas(parse(serialize(committed)))).toEqual(expected)
    expect(committed.lastChild?.eq(following)).toBe(true)
    expect(undoDepth(state)).toBe(1)
    expect(undo(state, dispatch)).toBe(true)
    expect(state.doc.eq(original)).toBe(true)
    expect(redo(state, dispatch)).toBe(true)
    expect(state.doc.eq(committed)).toBe(true)
  })

  it('preserves the formula and its source when a later intermediate IME replacement is empty', () => {
    const { inlineDocument } = harness()
    const original = inlineDocument('x+y', false), position = inlinePosition(original)
    let state = EditorState.create({ doc: original })
    state = state.apply(inlineMathValueTransaction(state, position, '候选', true)!)
    const intermediate = state.doc
    expect(formulas(intermediate)).toEqual([{ type: 'math_inline', value: '候选' }])
    expect(inlineMathValueTransaction(state, position, '', true)).toBeNull()
    expect(state.doc).toBe(intermediate)
    state = state.apply(inlineMathValueTransaction(state, position, '最终', false)!)
    expect(formulas(state.doc)).toEqual([{ type: 'math_inline', value: '最终' }])
  })
})

describe('display formula metadata round trips', () => {
  it.each([
    'label=&#x60; &amp; &NotEqualTilde;',
    'A&B `tick` price=$1',
    'path="C:\\temp\\file.txt" quote=\\" slash=\\\\ end',
    ' label="padded" ', '  ', '\tlabel\t', '\nlabel\n', 'inside\r\nline', '中文🙂',
  ])('preserves %j through five parse/serialize cycles in root and quoted blocks', (meta) => {
    const { schema, parse, serialize, following } = harness()
    for (const quoted of [false, true]) {
      const formula = schema.nodes.math_block.create({ meta }, schema.text('x^2 + y^2'))
      const original = schema.node('doc', null, [quoted ? schema.node('blockquote', null, formula) : formula, following])
      let current = original
      for (let pass = 0; pass < 5; pass++) {
        const output = serialize(current)
        current = parse(output)
        expect(current.eq(original), `${JSON.stringify(meta)}, quoted=${quoted}, pass=${pass}`).toBe(true)
        expect(current.lastChild?.eq(following)).toBe(true)
      }
    }
  })

  it('decodes a loaded literal entity once and remains stable after an unrelated body edit', () => {
    const { parse, serialize } = harness()
    const doc = parse('$$ label=&amp;#x60;\nx\n$$\n\nFollowing paragraph\n')
    expect(doc.firstChild?.attrs.meta).toBe('label=&#x60;')
    let state = EditorState.create({ doc })
    state = state.apply(state.tr.insertText(' edited', state.doc.content.size - 1))
    let current = state.doc
    for (let pass = 0; pass < 5; pass++) {
      current = parse(serialize(current))
      expect(current.eq(state.doc)).toBe(true)
      expect(current.firstChild?.attrs.meta).toBe('label=&#x60;')
      expect(current.lastChild?.textContent).toBe('Following paragraph edited')
    }
  })
})
