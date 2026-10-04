import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state'
import { history, redo, undo, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import type { EditorView } from '@codemirror/view'
import { defaultPreferences, type Preferences } from '../src/shared/preferences'
import { sourceTypingTransaction, sourceWritingAids } from '../src/renderer/editor/writing-aids'

const off: Preferences = { ...defaultPreferences, autoPair: false, smartPunctuation: false, autoLink: false }
const pairs = [['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`']] as const
const allCharacters = ['(', ')', '[', ']', '{', '}', '"', "'", '`', '-', '.', ' ', '\n', '\t', '\u00a0', '\u3000']

function editor(text: string, preferences = defaultPreferences, selection: EditorSelection = EditorSelection.single(text.length), extra: Extension = []) {
  let state = EditorState.create({ doc: text, selection, extensions: [markdown(), history(), sourceWritingAids(preferences), extra] })
  const view = {
    get state() { return state }, composing: false, compositionStarted: false,
    dispatch: (transaction: Transaction | Parameters<EditorState['update']>[0]) => { state = transaction instanceof Transaction ? transaction.state : state.update(transaction).state },
  } as unknown as EditorView
  const assistance = (input: string) => {
    const { from, to } = state.selection.main
    return sourceTypingTransaction(view, from, to, input, preferences)
  }
  const type = (input: string) => {
    const transaction = assistance(input)
    if (!transaction) throw new Error(`Expected assistance for ${JSON.stringify(input)}`)
    expect(transaction.isUserEvent('input.type')).toBe(true)
    view.dispatch(transaction)
    return transaction
  }
  return { view, assistance, type, get state() { return state } }
}

function forbidFullText(state: EditorState) {
  return vi.spyOn(state.doc, 'toString').mockImplementation(() => { throw new Error('Unexpected full document read') })
}
afterEach(() => vi.restoreAllMocks())

describe('source typing declines without reading the complete document', () => {
  it('does not read a million-character document for ordinary text under any aid settings', () => {
    const text = '普通正文 plain text。\n\n'.repeat(60_000).slice(0, 1_000_000)
    expect(text.length).toBe(1_000_000)
    const model = editor(text), before = model.state
    const read = forbidFullText(before)
    for (const autoPair of [false, true]) for (const smartPunctuation of [false, true]) for (const autoLink of [false, true]) {
      const preferences = { ...defaultPreferences, autoPair, smartPunctuation, autoLink }
      for (const input of ['a', '7', '文', '，', '“', '”', '‘', '’', '🙂']) {
        expect(sourceTypingTransaction(model.view, text.length, text.length, input, preferences), JSON.stringify({ input, autoPair, smartPunctuation, autoLink })).toBeNull()
      }
    }
    expect(read).not.toHaveBeenCalled()
    expect(model.state).toBe(before)
    expect(model.state.doc.length).toBe(1_000_000)
  })

  it.each([
    { name: 'all disabled', preferences: off, inputs: allCharacters },
    { name: 'pairing only', preferences: { ...off, autoPair: true }, inputs: ['-', '.', ' ', '\n', '\t'] },
    { name: 'punctuation only', preferences: { ...off, smartPunctuation: true }, inputs: ['(', ')', '[', ']', '{', '}', '`', ' ', '\n'] },
    { name: 'linking only', preferences: { ...off, autoLink: true }, inputs: ['(', ')', '"', "'", '`', '-', '.'] },
  ])('does not read disabled characters with $name', ({ preferences, inputs }) => {
    const model = editor('ordinary source', preferences), read = forbidFullText(model.state)
    for (const input of inputs) expect(model.assistance(input), JSON.stringify(input)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('leaves selected-text whitespace to the native input path', () => {
    const model = editor('label', { ...off, autoLink: true }, EditorSelection.single(5, 0)), before = model.state
    const read = forbidFullText(before)
    for (const input of [' ', '\n', '\t', '\u00a0', '\u3000']) expect(model.assistance(input)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(model.state).toBe(before)
  })
})

describe('source typing retains its protection before inspecting aid eligibility', () => {
  it.each(['composing', 'compositionStarted'] as const)('does not read or replace text while only %s is true', (flag) => {
    const model = editor(''), before = model.state, read = forbidFullText(before)
    const view = { state: before, composing: false, compositionStarted: false, [flag]: true }
    expect(sourceTypingTransaction(view, 0, 0, '(', defaultPreferences)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(model.state).toBe(before)
  })

  it('does not read a read-only document for a pairing character', () => {
    const model = editor('text', defaultPreferences, EditorSelection.single(4), EditorState.readOnly.of(true)), before = model.state
    const read = forbidFullText(before)
    expect(before.readOnly).toBe(true)
    expect(model.assistance('(')).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(model.state).toBe(before)
  })

  it('does not read or change multiple selection ranges for a pairing character', () => {
    const model = editor('text', defaultPreferences, EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)], 1), EditorState.allowMultipleSelections.of(true)), before = model.state
    const read = forbidFullText(before)
    expect(before.selection.ranges).toHaveLength(2)
    expect(model.assistance('(')).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(model.state).toBe(before)
  })

  it.each(['', '()', '"paste" -- ...', '🙂'])('does not inspect complete source for non-single-character input %j', (input) => {
    const model = editor(''), before = model.state, read = forbidFullText(before)
    expect(model.assistance(input)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(model.state).toBe(before)
  })
})

describe('eligible source input still produces real CodeMirror transactions and history', () => {
  it.each(pairs)('creates %s%s and skips its matching closer without an extra history change', (open, close) => {
    const model = editor('', { ...off, autoPair: true })
    model.type(open)
    expect(model.state.doc.toString()).toBe(open + close)
    expect(model.state.selection.main.anchor).toBe(1)
    expect(undoDepth(model.state)).toBe(1)
    const before = model.state.doc, transaction = model.type(close)
    expect(transaction.docChanged).toBe(false)
    expect(model.state.doc).toBe(before)
    expect(model.state.selection.main.anchor).toBe(2)
    expect(undoDepth(model.state)).toBe(1)
    expect(undo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe('')
    expect(redo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe(open + close)
  })

  for (const reversed of [false, true]) {
    it.each(pairs)(`wraps a ${reversed ? 'reverse' : 'forward'} selection with %s%s and preserves history and direction`, (open, close) => {
      const selection = EditorSelection.single(reversed ? 2 : 0, reversed ? 0 : 2)
      const model = editor('选择', { ...off, autoPair: true }, selection)
      model.type(open)
      expect(model.state.doc.toString()).toBe(open + '选择' + close)
      expect([model.state.selection.main.anchor, model.state.selection.main.head]).toEqual(reversed ? [3, 1] : [1, 3])
      expect(undoDepth(model.state)).toBe(1)
      expect(undo(model.view)).toBe(true)
      expect(model.state.doc.toString()).toBe('选择')
      expect(model.state.selection.eq(selection)).toBe(true)
      expect(redo(model.view)).toBe(true)
      expect(model.state.doc.toString()).toBe(open + '选择' + close)
      // Native CM redo maps the original selection over the entire replacement.
      expect([model.state.selection.main.anchor, model.state.selection.main.head]).toEqual(reversed ? [4, 0] : [0, 4])
    })
  }

  it.each([
    { text: '', input: '"', expected: '“' },
    { text: 'don', input: "'", expected: 'don’' },
    { text: '-', input: '-', expected: '—' },
    { text: '..', input: '.', expected: '…' },
  ])('retains smart-only input $input on $text', ({ text, input, expected }) => {
    const model = editor(text, { ...off, smartPunctuation: true })
    model.type(input)
    expect(model.state.doc.toString()).toBe(expected)
    expect(undo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe(text)
    expect(redo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe(expected)
  })

  it('retains smart-only quote replacement for a selected range', () => {
    const selection = EditorSelection.single(2, 0), model = editor('选择', { ...off, smartPunctuation: true }, selection)
    model.type('"')
    expect(model.state.doc.toString()).toBe('“')
    expect(undo(model.view)).toBe(true)
    expect(model.state.doc.toString()).toBe('选择'); expect(model.state.selection.eq(selection)).toBe(true)
  })

  it.each([['"', '“', '”'], ["'", '‘', '’']])('keeps smart and pairing enabled for %s, including skip over the curly closer', (input, open, close) => {
    const model = editor('', { ...off, autoPair: true, smartPunctuation: true })
    model.type(input)
    expect(model.state.doc.toString()).toBe(open + close)
    expect(model.state.selection.main.head).toBe(1)
    expect(model.type(input).docChanged).toBe(false)
    expect(model.state.selection.main.head).toBe(2)
    expect(undoDepth(model.state)).toBe(1)
    expect(undo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe('')
  })

  it.each([
    { text: '```js\n\n```', position: 6 },
    { text: '$ $', position: 1 },
  ])('does not disable ASCII pairing in literal source $text', ({ text, position }) => {
    const model = editor(text, { ...off, autoPair: true, smartPunctuation: true }, EditorSelection.single(position))
    model.type('"')
    const expected = text.slice(0, position) + '""' + text.slice(position)
    expect(model.state.doc.toString()).toBe(expected)
    expect(model.type('"').docChanged).toBe(false)
    expect(undo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe(text)
  })

  it.each([' ', '\n', '\t', '\u00a0', '\u3000'])('retains autoLink-only whitespace %j with one history change', (input) => {
    const original = 'https://example.com', model = editor(original, { ...off, autoLink: true })
    model.type(input)
    expect(model.state.doc.toString()).toBe('[https://example.com](<https://example.com/>)' + input)
    expect(undoDepth(model.state)).toBe(1)
    expect(undo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe(original)
    expect(redo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe('[https://example.com](<https://example.com/>)' + input)
  })
})
