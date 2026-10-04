import { describe, expect, it } from 'vitest'
import { remark } from 'remark'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { closeHistory, history, redo, undo, undoDepth } from '@milkdown/kit/prose/history'
import { ParserState, SerializerState, type NodeSchema } from '@milkdown/kit/transformer'
import { createCodeMetadataPlugin } from '../src/renderer/editor/code-metadata'
import { compatibleCodeBlockSchema } from '../src/renderer/editor/code-math-schema'

function harness(source = '```\nconst value = 1\n```\n\nBody\n', guard = true) {
  const container = (name: string, markdown: string, content: string): NodeSchema => ({
    group: 'block', content,
    parseMarkdown: { match: (node) => node.type === markdown, runner: (state, node, type) => { state.openNode(type); state.next(node.children); state.closeNode() } },
    toMarkdown: { match: (node) => node.type.name === name, runner: (state, node) => { state.openNode(markdown); state.next(node.content); state.closeNode() } },
  })
  const nodes: Record<string, NodeSchema> = {
    doc: { content: 'block+', parseMarkdown: { match: (node) => node.type === 'root', runner: (state, node, type) => { state.injectRoot(node, type) } }, toMarkdown: { match: (node) => node.type.name === 'doc', runner: (state, node) => { state.openNode('root'); state.next(node.content) } } },
    paragraph: container('paragraph', 'paragraph', 'inline*'), blockquote: container('blockquote', 'blockquote', 'block+'),
    code_block: compatibleCodeBlockSchema({ group: 'block', content: 'text*', marks: '', code: true, attrs: { language: { default: '', validate: 'string' } }, parseMarkdown: { match: () => false, runner: () => undefined }, toMarkdown: { match: () => false, runner: () => undefined } }),
    text: { group: 'inline', parseMarkdown: { match: (node) => node.type === 'text', runner: (state, node) => { state.addText(String(node.value ?? '')) } }, toMarkdown: { match: (node) => node.type.name === 'text', runner: (state, node) => { state.addNode('text', undefined, node.text ?? '') } } },
  }
  const schema = new Schema({ nodes })
  const processor = remark(), parse = ParserState.create(schema, processor), serialize = SerializerState.create(schema, processor)
  let state = EditorState.create({ doc: parse(source), plugins: [history(), ...(guard ? [createCodeMetadataPlugin()] : [])] })
  const dispatch = (transaction: Transaction) => { const result = state.applyTransaction(transaction); state = result.state; state.doc.check(); return result.transactions }
  const roundTrip = () => { const markdown = serialize(state.doc); expect(parse(markdown).eq(state.doc), markdown).toBe(true); return markdown }
  return { state: () => state, schema, parse, serialize, dispatch, roundTrip }
}

describe('code metadata preservation with the installed Markdown serializer', () => {
  it('adds Text to an unlabeled fence only when metadata is edited, as a single undo event', () => {
    const editor = harness(), before = editor.state().doc
    editor.dispatch(editor.state().tr.setSelection(TextSelection.create(before, 3, 8)))
    const selected = editor.state().selection.toJSON()
    const transactions = editor.dispatch(editor.state().tr.setNodeAttribute(0, 'meta', 'title="中文.ts" {1,3-5}'))
    expect(transactions).toHaveLength(2)
    expect(editor.state().doc.firstChild?.attrs).toEqual({ language: 'text', meta: 'title="中文.ts" {1,3-5}' })
    expect(editor.state().doc.firstChild?.content.eq(before.firstChild!.content)).toBe(true)
    expect(editor.state().selection.toJSON()).toEqual(selected)
    expect(editor.roundTrip()).toContain('```text title="中文.ts" {1,3-5}')
    expect(undoDepth(editor.state())).toBe(1)
    expect(undo(editor.state(), editor.dispatch)).toBe(true)
    expect(editor.state().doc.eq(before)).toBe(true)
    expect(redo(editor.state(), editor.dispatch)).toBe(true)
    expect(editor.state().doc.firstChild?.attrs.language).toBe('text')
    editor.roundTrip()
  })

  it('retains metadata when the native language selector clears an existing language', () => {
    const editor = harness('```javascript title="example.js"\nconst value = 1\n```\n\nBody\n'), before = editor.state().doc
    editor.dispatch(editor.state().tr.setNodeAttribute(0, 'language', ''))
    expect(editor.state().doc.firstChild?.attrs).toEqual({ language: 'text', meta: 'title="example.js"' })
    expect(editor.roundTrip()).toContain('```text title="example.js"')
    expect(undoDepth(editor.state())).toBe(1)
    expect(undo(editor.state(), editor.dispatch)).toBe(true)
    expect(editor.state().doc.eq(before)).toBe(true)
    expect(redo(editor.state(), editor.dispatch)).toBe(true)
    editor.roundTrip()
  })

  it('leaves unlabeled code without metadata unchanged after ordinary body and code edits', () => {
    const editor = harness()
    editor.dispatch(editor.state().tr.insertText(' edited', editor.state().doc.content.size - 1))
    editor.dispatch(editor.state().tr.insertText('// comment\n', 1))
    expect(editor.state().doc.firstChild?.attrs).toEqual({ language: '', meta: null })
    expect(editor.roundTrip()).not.toContain('```text')
    editor.dispatch(closeHistory(editor.state().tr).setNodeAttribute(0, 'language', 'javascript'))
    editor.dispatch(closeHistory(editor.state().tr).setNodeAttribute(0, 'language', ''))
    expect(editor.state().doc.firstChild?.attrs.language).toBe('')
  })

  it('does not repair an unrelated untouched node when content before it shifts positions', () => {
    const editor = harness('Body\n\n```\nx\n```\n', false), first = editor.state().doc.firstChild!
    editor.dispatch(editor.state().tr.setNodeAttribute(first.nodeSize, 'meta', '{2}'))
    const invalid = editor.state().doc.child(1)
    const state = EditorState.create({ doc: editor.state().doc, plugins: [createCodeMetadataPlugin()] })
    const result = state.applyTransaction(state.tr.insertText(' more', 5))
    expect(result.transactions).toHaveLength(1)
    expect(result.state.doc.child(1).eq(invalid)).toBe(true)
  })

  it('normalizes newly inserted nested metadata nodes without changing their container or source', () => {
    const editor = harness('Body\n'), code = editor.schema.nodes.code_block.create({ language: '', meta: 'title="quote.txt"' }, editor.schema.text('``` inside code\n中文🙂'))
    editor.dispatch(editor.state().tr.insert(0, editor.schema.nodes.blockquote.create(null, code)))
    expect(editor.state().doc.firstChild?.type.name).toBe('blockquote')
    expect(editor.state().doc.firstChild?.firstChild?.attrs).toEqual({ language: 'text', meta: 'title="quote.txt"' })
    expect(editor.state().doc.firstChild?.textContent).toBe(code.textContent)
    expect(editor.roundTrip()).toContain('title="quote.txt"')
    expect(undoDepth(editor.state())).toBe(1)
    expect(undo(editor.state(), editor.dispatch)).toBe(true)
    expect(editor.state().doc.firstChild?.type.name).toBe('paragraph')
  })

  it('lets language be cleared once metadata has been removed', () => {
    const editor = harness('```javascript title="example.js"\nx\n```\n')
    editor.dispatch(editor.state().tr.setNodeAttribute(0, 'meta', null).setNodeAttribute(0, 'language', ''))
    expect(editor.state().doc.firstChild?.attrs).toEqual({ language: '', meta: null })
    expect(editor.roundTrip()).not.toContain('text')
  })

  it('uses the same safe language fallback in standalone serialization without mutating the document', () => {
    const editor = harness(undefined, false)
    editor.dispatch(editor.state().tr.setNodeAttribute(0, 'meta', 'title="saved.txt"'))
    const node = editor.state().doc.firstChild!
    expect(node.attrs.language).toBe('')
    const output = editor.serialize(editor.state().doc), reopened = editor.parse(output)
    expect(output).toContain('```text title="saved.txt"')
    expect(node.attrs.language).toBe('')
    expect(reopened.firstChild?.textContent).toBe(node.textContent)
    expect(reopened.firstChild?.attrs).toEqual({ language: 'text', meta: node.attrs.meta })
  })

  it('preserves literal backticks, HTML characters and metadata word order through actual escaping and parsing', () => {
    for (const meta of [
      'title="example`name.txt" {2}',
      'title="<span> & 中文🙂</span>" linenos',
      '{1,3-5} linenos title="last.txt"',
      'title="literal &#x60; &amp;" label=`inline`',
      ' title="padded.txt" ',
      '  ',
      '\ttitle="tabbed.txt"\t',
    ]) {
      const editor = harness()
      editor.dispatch(editor.state().tr.setNodeAttribute(0, 'meta', meta))
      const output = editor.roundTrip(), reopened = editor.parse(output)
      expect(reopened.firstChild?.attrs).toEqual({ language: 'text', meta })
      expect(editor.state().doc.firstChild?.attrs.meta).toBe(meta)
      editor.dispatch(closeHistory(editor.state().tr).setNodeAttribute(0, 'language', ''))
      expect(editor.state().doc.firstChild?.attrs).toEqual({ language: 'text', meta })
      expect(editor.roundTrip()).toBe(output)
    }
  })
})
