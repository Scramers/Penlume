import { describe, expect, it } from 'vitest'
import { Schema, Slice } from '@milkdown/kit/prose/model'
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { history, redo, undo } from '@milkdown/kit/prose/history'
import { EditorView } from '@milkdown/kit/prose/view'
import { defaultPreferences, type Preferences } from '../src/shared/preferences'
import { createWritingAidsPlugin, handleWritingAidsPaste } from '../src/renderer/editor/writing-aids'

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} }, marks: { link: { attrs: { href: {}, title: { default: null } }, inclusive: false } } })

function pasteView(text: string, selected: boolean, direct = true) {
  let preferences: Preferences = defaultPreferences, nativeCalls = 0
  const nativeClipboard = new Plugin({ props: { handlePaste: (view, event) => {
    nativeCalls++
    const { from, to } = view.state.selection
    view.dispatch(view.state.tr.insertText(event.clipboardData!.getData('text/plain'), from, to))
    return true
  } } })
  const doc = schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])])
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, selected ? 1 : text.length + 1, text.length + 1), plugins: [history(), nativeClipboard, createWritingAidsPlugin(() => preferences)] })
  const dispatch = (transaction: Parameters<EditorState['apply']>[0]) => { state = state.apply(transaction) }
  const view = {
    get state() { return state }, editable: true, composing: false, dispatch,
    // Use ProseMirror's real prop resolution with an earlier clipboard plugin.
    // No DOM or renderer selection is synthesized by this test.
    _props: direct ? { handlePaste: (view: EditorView, event: ClipboardEvent) => handleWritingAidsPaste(view, event, preferences) } : {},
    directPlugins: [], someProp: EditorView.prototype.someProp,
  } as unknown as EditorView
  return { view, dispatch, get state() { return state }, get nativeCalls() { return nativeCalls }, setPreferences: (value: Preferences) => { preferences = value } }
}
const clipboard = (text: string) => ({ clipboardData: { getData: (type: string) => type === 'text/plain' ? text : '' } }) as unknown as ClipboardEvent
const paste = (model: ReturnType<typeof pasteView>, text: string) => model.view.someProp('handlePaste', (handler) => handler(model.view, clipboard(text), Slice.empty))

describe('URL assistance before the native Markdown clipboard plugin', () => {
  it('reproduces an earlier clipboard plugin consuming the selected label without a direct prop', () => {
    const model = pasteView('keep-label', true, false)
    expect(paste(model, 'https://example.com/selected')).toBe(true)
    expect(model.state.doc.textContent).toBe('https://example.com/selected')
    expect(model.nativeCalls).toBe(1)
  })
  it('preserves a selected label and marks it before the earlier plugin can replace it, with undo and redo', () => {
    const model = pasteView('keep-label', true)
    expect(paste(model, 'https://example.com/selected')).toBe(true)
    expect(model.nativeCalls).toBe(0); expect(model.state.doc.textContent).toBe('keep-label')
    expect(model.state.doc.firstChild!.firstChild!.marks[0].attrs.href).toBe('https://example.com/selected')
    expect(model.state.selection.empty).toBe(true); expect(model.state.selection.from).toBe(11)
    expect(undo(model.state, model.dispatch)).toBe(true); expect(model.state.doc.textContent).toBe('keep-label'); expect(model.state.doc.firstChild!.firstChild!.marks).toEqual([])
    expect(redo(model.state, model.dispatch)).toBe(true); expect(model.state.doc.firstChild!.firstChild!.marks[0].attrs.href).toBe('https://example.com/selected')
  })
  it('inserts a URL label at a collapsed caret and saves its link as one history change', () => {
    const model = pasteView('Prefix ', false), value = 'https://example.com/new'
    expect(paste(model, value)).toBe(true); expect(model.nativeCalls).toBe(0)
    expect(model.state.doc.textContent).toBe('Prefix ' + value)
    expect(model.state.doc.firstChild!.lastChild!.text).toBe(value)
    expect(model.state.doc.firstChild!.lastChild!.marks[0].attrs.href).toBe(value)
    expect(undo(model.state, model.dispatch)).toBe(true); expect(model.state.doc.textContent).toBe('Prefix ')
    expect(redo(model.state, model.dispatch)).toBe(true); expect(model.state.doc.textContent).toBe('Prefix ' + value)
  })
  it('lets the native clipboard path handle disabled assistance and ordinary Markdown', () => {
    const disabled = pasteView('keep-label', true)
    disabled.setPreferences({ ...defaultPreferences, autoLink: false })
    expect(paste(disabled, 'https://example.com/plain')).toBe(true); expect(disabled.nativeCalls).toBe(1)
    expect(disabled.state.doc.textContent).toBe('https://example.com/plain')
    const markdown = pasteView('replace', true)
    expect(paste(markdown, '**ordinary Markdown**')).toBe(true); expect(markdown.nativeCalls).toBe(1)
    expect(markdown.state.doc.textContent).toBe('**ordinary Markdown**')
    const composing = pasteView('unchanged', true)
    expect(handleWritingAidsPaste({ ...composing.view, composing: true } as EditorView, clipboard('https://example.com/ime'), defaultPreferences)).toBe(false)
    expect(composing.state.doc.textContent).toBe('unchanged')
  })
})
