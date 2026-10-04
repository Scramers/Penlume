import { describe, expect, it, vi } from 'vitest'
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { createMarkdownSerializationCache } from '../src/renderer/editor/markdown-serialization-cache'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    image: { group: 'block', atom: true, attrs: { src: { default: '' } } },
    text: { group: 'inline' },
  },
  marks: { strong: {} },
})
const doc = (text: string) => schema.node('doc', null, schema.node('paragraph', null, schema.text(text)))

describe('canonical Markdown serialization cache', () => {
  it('reuses one PM document through repeated reads, selection and stored-mark transactions', () => {
    const cache = createMarkdownSerializationCache(), document = doc('abc')
    const serialize = vi.fn(() => 'abc\n')
    let state = EditorState.create({ doc: document })
    expect(cache.read(state.doc, serialize)).toBe('abc\n')
    expect(cache.read(state.doc, serialize)).toBe('abc\n')
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))
    state = state.apply(state.tr.setStoredMarks([schema.marks.strong.create()]))
    expect(state.doc).toBe(document)
    expect(cache.read(state.doc, serialize)).toBe('abc\n')
    expect(serialize).toHaveBeenCalledExactlyOnceWith(document)
  })

  it('immediately exposes text edits without waiting for a listener timer', () => {
    const cache = createMarkdownSerializationCache()
    let state = EditorState.create({ doc: doc('abc') })
    const serialize = vi.fn((document: ProseNode) => `${document.textContent}\n`)
    expect(cache.read(state.doc, serialize)).toBe('abc\n')
    state = state.apply(state.tr.insertText('d', 4))
    expect(cache.read(state.doc, serialize)).toBe('abcd\n')
    expect(cache.read(state.doc, serialize)).toBe('abcd\n')
    expect(serialize).toHaveBeenCalledTimes(2)
  })

  it('invalidates for an attribute-only edit with unchanged text content', () => {
    const cache = createMarkdownSerializationCache()
    let state = EditorState.create({ doc: schema.node('doc', null, schema.node('image', { src: 'a.png' })) })
    const serialize = vi.fn((document: ProseNode) => `![](${document.firstChild!.attrs.src})\n`)
    expect(cache.read(state.doc, serialize)).toBe('![](a.png)\n')
    const before = state.doc
    state = state.apply(state.tr.setNodeAttribute(0, 'src', 'b.png'))
    expect(state.doc.textContent).toBe(before.textContent)
    expect(state.doc).not.toBe(before)
    expect(cache.read(state.doc, serialize)).toBe('![](b.png)\n')
    expect(serialize).toHaveBeenCalledTimes(2)
  })

  it('uses object identity even when a replacement document is structurally equal', () => {
    const cache = createMarkdownSerializationCache(), first = doc('same')
    const replacement = schema.nodeFromJSON(first.toJSON())
    const serialize = vi.fn(() => 'same\n')
    expect(replacement.eq(first)).toBe(true)
    expect(replacement).not.toBe(first)
    cache.read(first, serialize)
    cache.read(replacement, serialize)
    expect(serialize).toHaveBeenCalledTimes(2)
  })

  it('retains only the latest document, including an undo-like A to B to A sequence', () => {
    const cache = createMarkdownSerializationCache(), first = doc('a'), second = doc('b')
    const serialize = vi.fn((document: ProseNode) => `${document.textContent}\n`)
    expect(cache.read(first, serialize)).toBe('a\n')
    expect(cache.read(second, serialize)).toBe('b\n')
    expect(cache.read(first, serialize)).toBe('a\n')
    expect(serialize).toHaveBeenCalledTimes(3)
  })

  it('clears a lifecycle or replacement entry even if the same PM object is reused', () => {
    const cache = createMarkdownSerializationCache(), document = doc('same')
    const serialize = vi.fn().mockReturnValueOnce('first canonical\n').mockReturnValueOnce('new canonical\n')
    expect(cache.read(document, serialize)).toBe('first canonical\n')
    cache.clear()
    expect(cache.read(document, serialize)).toBe('new canonical\n')
    expect(serialize).toHaveBeenCalledTimes(2)
  })

  it('does not cache a thrown result or retain the displaced document entry', () => {
    const cache = createMarkdownSerializationCache(), first = doc('a'), second = doc('b')
    const serialize = vi.fn().mockReturnValueOnce('a\n').mockImplementationOnce(() => { throw new Error('serializer failed') }).mockReturnValueOnce('b\n').mockReturnValueOnce('a\n')
    expect(cache.read(first, serialize)).toBe('a\n')
    expect(() => cache.read(second, serialize)).toThrow('serializer failed')
    expect(cache.read(second, serialize)).toBe('b\n')
    expect(cache.read(first, serialize)).toBe('a\n')
    expect(serialize).toHaveBeenCalledTimes(4)
  })
})
