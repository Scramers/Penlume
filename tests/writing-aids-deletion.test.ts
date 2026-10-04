import { describe, expect, it, vi } from 'vitest'
import { EditorState, Transaction, type Extension } from '@codemirror/state'
import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView, keymap } from '@codemirror/view'
import { defaultPreferences, type Preferences } from '../src/shared/preferences'
import { pairedDeletion } from '../src/shared/writing-aids'
import { codePairExtension, sourceWritingAids } from '../src/renderer/editor/writing-aids'

const pairs = [
  ['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’'],
] as const

function editor(text: string, anchor: number, extension: Extension) {
  let state = EditorState.create({ doc: text, selection: { anchor }, extensions: [markdown(), history(), extension] })
  const dispatch = vi.fn((transaction: Transaction | Parameters<EditorState['update']>[0]) => {
    state = transaction instanceof Transaction ? transaction.state : state.update(transaction).state
  })
  const view = { get state() { return state }, composing: false, compositionStarted: false, dispatch } as unknown as EditorView
  const backspace = state.facet(keymap).flat().find((binding) => binding.key === 'Backspace')?.run
  if (!backspace) throw new Error('Writing aids did not register Backspace')
  return { get state() { return state }, view, dispatch, backspace }
}

const modes: Array<{ name: string; extension: (preferences: Preferences) => Extension }> = [
  { name: 'source', extension: sourceWritingAids },
  { name: 'code', extension: codePairExtension },
]

describe('paired Backspace boundaries', () => {
  it.each(pairs)('deletes only the empty middle of %s%s, with UTF-16 offsets intact', (open, close) => {
    expect(pairedDeletion(open + close, 1, 1)).toEqual({ from: 0, to: 2 })
    const prefix = '前🙂', text = prefix + open + close + '后', middle = prefix.length + 1
    expect(pairedDeletion(text, middle, middle)).toEqual({ from: prefix.length, to: prefix.length + 2 })
  })

  it('refuses every document end, including a closing bracket after skip', () => {
    const endings = ['', ...pairs.flat(), ...pairs.map(([open, close]) => open + close), 'abc', '中文', '🙂', 'text)', 'text]']
    for (let code = 0; code < 256; code++) endings.push(String.fromCharCode(code))
    for (const text of endings) expect(pairedDeletion(text, text.length, text.length), JSON.stringify(text)).toBeNull()
  })

  it('refuses non-openers, mismatched closers, invalid offsets and non-empty selections', () => {
    for (const offset of [-1, 0, 1, 2, Infinity]) expect(pairedDeletion('', offset, offset)).toBeNull()
    const openers = new Set(pairs.map(([open]) => open))
    for (let code = 0; code < 256; code++) {
      const character = String.fromCharCode(code)
      if (!openers.has(character as typeof pairs[number][0])) {
        expect(pairedDeletion(character + ')', 1, 1), JSON.stringify(character)).toBeNull()
      }
    }
    for (const text of ['(]', '[)', '{]', '“’', '‘”', '文)', '🙂)']) {
      expect(pairedDeletion(text, text.length - 1, text.length - 1), text).toBeNull()
    }
    for (const [from, to] of [[-1, -1], [0, 0], [2, 2], [3, 3], [1.5, 1.5], [NaN, NaN], [Infinity, Infinity], [0, 1], [1, 2], [2, 1]]) {
      expect(pairedDeletion('()', from, to), `${from}, ${to}`).toBeNull()
    }
  })
})

for (const mode of modes) {
  describe(`${mode.name} Backspace command`, () => {
    it('leaves ordinary deletion at document ends to the native command without dispatching', () => {
      for (const autoPair of [true, false]) {
        const preferences = { ...defaultPreferences, autoPair }
        for (const text of ['', '()', '[]', '{}', '""', "''", '``', '“”', '‘’', 'a', ')', '中文', '🙂']) {
          const model = editor(text, text.length, mode.extension(preferences)), before = model.state
          expect(model.backspace(model.view), `${JSON.stringify(text)}, autoPair=${autoPair}`).toBe(false)
          expect(model.dispatch).not.toHaveBeenCalled()
          expect(model.state).toBe(before)
        }
      }
    })

    it.each(pairs)('deletes %s%s in one history step and restores it with undo/redo', (open, close) => {
      const prefix = '前🙂', original = prefix + open + close + '后', middle = prefix.length + 1
      const model = editor(original, middle, mode.extension({ ...defaultPreferences, autoPair: true }))
      expect(model.backspace(model.view)).toBe(true)
      expect(model.dispatch).toHaveBeenCalledTimes(1)
      expect(model.state.doc.toString()).toBe(prefix + '后')
      expect(model.state.selection.main.anchor).toBe(prefix.length)
      expect(undoDepth(model.state)).toBe(1)
      expect(undo(model.view)).toBe(true)
      expect(model.state.doc.toString()).toBe(original)
      expect(model.state.selection.main.anchor).toBe(middle)
      expect(undoDepth(model.state)).toBe(0)
      expect(redoDepth(model.state)).toBe(1)
      expect(redo(model.view)).toBe(true)
      expect(model.state.doc.toString()).toBe(prefix + '后')
      expect(model.state.selection.main.anchor).toBe(prefix.length)
      expect(redoDepth(model.state)).toBe(0)
    })

    it('does not replace a non-empty selection with a paired deletion', () => {
      const model = editor('()', 1, mode.extension(defaultPreferences))
      model.view.dispatch({ selection: { anchor: 0, head: 2 } })
      model.dispatch.mockClear()
      const before = model.state
      expect(model.backspace(model.view)).toBe(false)
      expect(model.dispatch).not.toHaveBeenCalled()
      expect(model.state).toBe(before)
    })
  })
}
