import { describe, expect, it } from 'vitest'
import { Compartment, EditorSelection, EditorState as CMState, Transaction as CMTransaction } from '@codemirror/state'
import { history as cmHistory, undo as cmUndo, redo as cmRedo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView as CMView, keymap } from '@codemirror/view'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { history, undo, redo } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'
import { defaultPreferences, parsePreferences } from '../src/shared/preferences'
import { newCodeBlockMarkdown, pairedDeletion, pendingLiteral, planTyping, safeTypingUrl, trailingUrl } from '../src/shared/writing-aids'
import { createWritingAidsPlugin, sourceLiteralPosition, sourceTypingTransaction, sourceWritingAids, writingAidsBackspaceTransaction, writingAidsDomCaret, writingAidsTypingTransaction } from '../src/renderer/editor/writing-aids'

const smart = { ...defaultPreferences, smartPunctuation: true, autoPair: false }
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
  text: { group: 'inline' }, code_block: { group: 'block', content: 'text*', marks: '', code: true, attrs: { language: { default: '' } } },
  front_matter: { group: 'block', content: 'text*', code: true },
}, marks: { inlineCode: { code: true, inclusive: false }, link: { attrs: { href: {}, title: { default: null } }, inclusive: false } } })

function pm(text = '', node = 'paragraph', mark?: 'inlineCode' | 'link') {
  const marks = mark === 'link' ? [schema.marks.link.create({ href: 'https://example.com' })] : mark ? [schema.marks[mark].create()] : []
  let state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node(node, null, text ? [schema.text(text, marks)] : [])]), plugins: [history()] })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + text.length)))
  const dispatch = (tr: Transaction) => { state = state.apply(tr) }
  const view = { get state() { return state }, editable: true, composing: false, dispatch } as unknown as EditorView
  return { get state() { return state }, view, dispatch }
}

function cm(text = '', preferences = defaultPreferences) {
  const compartment = new Compartment()
  let state = CMState.create({ doc: text, selection: { anchor: text.length }, extensions: [markdown(), cmHistory(), compartment.of(sourceWritingAids(preferences))] })
  const view = { get state() { return state }, composing: false, compositionStarted: false, dispatch: (tr: CMTransaction | Parameters<CMState['update']>[0]) => { state = tr instanceof CMTransaction ? tr.state : state.update(tr).state } } as unknown as CMView
  return { get state() { return state }, view, reconfigure: (next: typeof preferences) => { view.dispatch({ effects: compartment.reconfigure(sourceWritingAids(next)) }) } }
}

function typeCM(model: ReturnType<typeof cm>, input: string, preferences = defaultPreferences) {
  const { from, to } = model.state.selection.main
  const tr = sourceTypingTransaction(model.view, from, to, input, preferences)
  model.view.dispatch(tr ?? model.state.update({ changes: { from, to, insert: input }, selection: { anchor: from + input.length }, userEvent: 'input.type' }))
}

function typePM(model: ReturnType<typeof pm>, input: string, preferences = defaultPreferences) {
  const { from, to } = model.state.selection
  const tr = writingAidsTypingTransaction(model.state, from, to, input, preferences)
  model.dispatch(tr ?? model.state.tr.insertText(input, from, to))
}

function domCaretView(model: ReturnType<typeof pm>, offset: number, control: string | null = null) {
  const node = { nodeType: 3, textContent: model.state.doc.firstChild!.textContent, pmViewDesc: { node: model.state.doc.firstChild!.firstChild }, parentElement: { closest: () => control ? {} : null } } as unknown as Text
  const selection = { rangeCount: 1, isCollapsed: true, anchorNode: node, focusNode: node, anchorOffset: offset, focusOffset: offset }
  const dom = { ownerDocument: { getSelection: () => selection }, contains: (value: Node) => value === node } as unknown as HTMLElement
  const view = { get state() { return model.state }, editable: true, composing: false, dom, hasFocus: () => true, posAtDOM: (_node: Node, offset: number) => offset + 1, dispatch: model.dispatch } as unknown as EditorView
  return { view, selection, node }
}

describe('persisted typing and code preferences', () => {
  it('migrates earlier preference objects with conservative defaults and validates code languages', () => {
    expect(parsePreferences({ fontSize: 20 })).toMatchObject({ fontSize: 20, smartPunctuation: false, autoPair: true, autoLink: true, codeWrap: false, codeLineNumbers: true, defaultCodeLanguage: '' })
    const value = { ...defaultPreferences, smartPunctuation: true, autoPair: false, autoLink: false, codeWrap: true, codeLineNumbers: false, defaultCodeLanguage: 'c++' }
    expect(parsePreferences(JSON.parse(JSON.stringify(value)))).toEqual(value)
    expect(parsePreferences({ defaultCodeLanguage: 'bad`\n```' }).defaultCodeLanguage).toBe('')
  })
  it('creates only new labelled fences with enough backticks to contain the selected code', () => {
    expect(newCodeBlockMarkdown('print("hello")', { defaultCodeLanguage: 'python' })).toBe('\n\n```python\nprint("hello")\n```\n\n')
    expect(newCodeBlockMarkdown('```\ncode\n```', { defaultCodeLanguage: '' })).toBe('\n\n````\n```\ncode\n```\n````\n\n')
  })
})

describe('ordinary keyboard assistance shared by the two views', () => {
  it('transforms only fresh ASCII prose input, with closing quotes and apostrophes', () => {
    for (const model of [cm('', smart), pm()]) {
      for (const character of '"Hello" -- ... don\'t') {
        if ('reconfigure' in model) typeCM(model, character, smart); else typePM(model, character, smart)
      }
      const text = 'reconfigure' in model ? model.state.doc.toString() : model.state.doc.textContent
      expect(text).toBe('“Hello” — … don’t')
    }
    expect(planTyping('中文', 2, 2, '“', smart)).toBeNull()
    expect(planTyping('中文', 2, 2, '文', smart)).toBeNull()
  })
  it('does not transform code, formula, YAML, HTML, URLs, pasted text or composed input', () => {
    for (const text of ['```js\nconst s = "x"', '    a -- b', '`a -- b`', '$a -- b$', '$$\na -- b\n$$', '---\ntitle: "a"\n---', '<div title="x">raw</div>', '[link](https://example.com)', '<https://example.com>']) {
      const pos = text.indexOf('--') >= 0 ? text.indexOf('--') + 1 : Math.max(1, text.indexOf('"') + 1)
      const model = cm(text, smart)
      expect(sourceLiteralPosition(model.state, pos), text).toBe(true)
      expect(sourceTypingTransaction(model.view, pos, pos, '-', smart), text).toBeNull()
    }
    for (const node of ['code_block', 'front_matter']) expect(writingAidsTypingTransaction(pm('-', node).state, 2, 2, '-', smart)).toBeNull()
    expect(writingAidsTypingTransaction(pm('-', 'paragraph', 'inlineCode').state, 2, 2, '-', smart)).toBeNull()
    expect(writingAidsTypingTransaction(pm('https://x.test/-').state, 16, 16, '-', smart)).toBeNull()
    expect(sourceTypingTransaction({ state: cm('-').state, composing: true, compositionStarted: true }, 1, 1, '-', smart)).toBeNull()
    expect(writingAidsTypingTransaction(pm('-').state, 2, 2, '-', smart, true)).toBeNull()
    expect(planTyping('', 0, 0, '"paste" -- ...', smart)).toBeNull()
    expect(pendingLiteral('`closed` $new')).toBe(true)
  })
  it('pairs, wraps, skips and deletes the same bracket/quote characters', () => {
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`']]) {
      const model = cm()
      typeCM(model, open)
      expect(model.state.doc.toString()).toBe(open + close)
      expect(model.state.selection.main.head).toBe(1)
      typeCM(model, close)
      expect(model.state.doc.toString()).toBe(open + close)
      expect(model.state.selection.main.head).toBe(2)
      expect(pairedDeletion(open + close, 1, 1)).toEqual({ from: 0, to: 2 })
    }
    const source = cm('选择'), visual = pm('选择')
    source.view.dispatch({ selection: EditorSelection.range(2, 0) })
    visual.dispatch(visual.state.tr.setSelection(TextSelection.create(visual.state.doc, 3, 1)))
    typeCM(source, '('); typePM(visual, '(')
    expect(source.state.doc.toString()).toBe('(选择)'); expect(visual.state.doc.textContent).toBe('(选择)')
    expect([source.state.selection.main.anchor, source.state.selection.main.head]).toEqual([3, 1])
    expect([visual.state.selection.anchor, visual.state.selection.head]).toEqual([4, 2])
    expect(planTyping('word', 4, 4, "'", defaultPreferences)).toBeNull()
  })
  it('deletes at the actual DOM caret when a native arrow has not updated the PM selection', () => {
    const visual = pm('()'), { view } = domCaretView(visual, 1), plugin = createWritingAidsPlugin(() => defaultPreferences)
    expect(visual.state.selection.$from.parentOffset).toBe(2)
    expect(writingAidsDomCaret(view)).toBe(2)
    expect(plugin.props.handleKeyDown?.call(plugin, view, { key: 'Backspace', keyCode: 8 } as KeyboardEvent)).toBe(true)
    expect(visual.state.doc.textContent).toBe(''); expect(visual.state.selection.from).toBe(1)
    expect(undo(visual.state, visual.dispatch)).toBe(true); expect(visual.state.doc.textContent).toBe('()')
    expect(redo(visual.state, visual.dispatch)).toBe(true); expect(visual.state.doc.textContent).toBe('')
  })
  it('does not reinterpret selected text, foreign or atomic controls, stale DOM text or composition as a pair caret', () => {
    const visual = pm('()'), plugin = createWritingAidsPlugin(() => defaultPreferences)
    for (const control of ['.cm-editor', 'input', 'textarea', 'button', '[contenteditable="false"]']) {
      const { view } = domCaretView(visual, 1, control)
      expect(writingAidsDomCaret(view), control).toBeNull()
      expect(plugin.props.handleKeyDown?.call(plugin, view, { key: 'Backspace', keyCode: 8 } as KeyboardEvent), control).toBe(false)
    }
    const { view, selection, node } = domCaretView(visual, 1)
    selection.isCollapsed = false; expect(writingAidsDomCaret(view)).toBeNull(); selection.isCollapsed = true
    view.hasFocus = () => false; expect(writingAidsDomCaret(view)).toBeNull(); view.hasFocus = () => true
    view.posAtDOM = () => { throw new Error('foreign DOM') }; expect(writingAidsDomCaret(view)).toBeNull(); view.posAtDOM = (_node, offset) => offset + 1
    node.textContent = '(stale)'; expect(writingAidsDomCaret(view)).toBeNull(); node.textContent = '()'
    expect(plugin.props.handleKeyDown?.call(plugin, view, { key: 'Backspace', keyCode: 229 } as KeyboardEvent)).toBe(false)
    expect(plugin.props.handleKeyDown?.call(plugin, view, { key: 'Backspace', keyCode: 8, isComposing: true } as KeyboardEvent)).toBe(false)
    const disabled = createWritingAidsPlugin(() => ({ ...defaultPreferences, autoPair: false }))
    expect(disabled.props.handleKeyDown?.call(disabled, view, { key: 'Backspace', keyCode: 8 } as KeyboardEvent)).toBe(false)
    visual.dispatch(visual.state.tr.setSelection(TextSelection.create(visual.state.doc, 1, 3)))
    expect(writingAidsDomCaret(view)).toBeNull(); expect(writingAidsBackspaceTransaction(visual.state, 2)).toBeNull()
    expect(visual.state.doc.textContent).toBe('()')
  })
  it('keeps PM positions correct after an inline atom and does not reinterpret node selections', () => {
    const atomSchema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' }, text: { group: 'inline' }, inline_atom: { group: 'inline', inline: true, atom: true } } })
    const doc = atomSchema.node('doc', null, [atomSchema.node('paragraph', null, [atomSchema.node('inline_atom'), atomSchema.text('()')])])
    let state = EditorState.create({ schema: atomSchema, doc, selection: TextSelection.create(doc, 4), plugins: [history()] })
    const transaction = writingAidsBackspaceTransaction(state, 3)
    expect(transaction).not.toBeNull(); state = state.apply(transaction!)
    expect(state.doc.firstChild!.childCount).toBe(1); expect(state.doc.firstChild!.firstChild!.type.name).toBe('inline_atom')
    expect(state.doc.textContent).toBe(''); expect(state.selection.from).toBe(2)
    const selected = EditorState.create({ schema: atomSchema, doc, selection: NodeSelection.create(doc, 1) })
    expect(writingAidsBackspaceTransaction(selected, 3)).toBeNull()
    expect(writingAidsBackspaceTransaction(EditorState.create({ schema: atomSchema, doc, selection: TextSelection.create(doc, 4) }))).toBeNull()
  })
  it('closes paired inline backticks semantically without leaving escaped markers', () => {
    const visual = pm()
    typePM(visual, '`'); for (const char of 'abc') typePM(visual, char); typePM(visual, '`')
    expect(visual.state.doc.textContent).toBe('abc')
    expect(visual.state.doc.firstChild?.firstChild?.marks[0].type.name).toBe('inlineCode')
    expect(visual.state.storedMarks?.some((mark) => mark.type.name === 'inlineCode') ?? false).toBe(false)
    expect(undo(visual.state, visual.dispatch)).toBe(true)
    expect(visual.state.doc.textContent).toBe('')
    expect(redo(visual.state, visual.dispatch)).toBe(true); expect(visual.state.doc.textContent).toBe('abc')
  })
  it('keeps history and document state when preferences are reconfigured and affect the next key', () => {
    const model = cm()
    typeCM(model, '(')
    const before = model.state.doc, selection = model.state.selection
    model.reconfigure({ ...defaultPreferences, autoPair: false })
    expect(model.state.doc).toBe(before); expect(model.state.selection.eq(selection)).toBe(true)
    typeCM(model, '[', { ...defaultPreferences, autoPair: false })
    expect(model.state.doc.toString()).toBe('([)')
    expect(cmUndo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe('')
    expect(cmRedo(model.view)).toBe(true); expect(model.state.doc.toString()).toBe('([)')
    let preferences = defaultPreferences
    const plugin = createWritingAidsPlugin(() => preferences), visual = pm()
    const run = (value: string) => plugin.props.handleTextInput?.call(plugin, visual.view, visual.state.selection.from, visual.state.selection.to, value, () => visual.state.tr)
    expect(run('(')).toBe(true); expect(visual.state.doc.textContent).toBe('()')
    preferences = { ...preferences, autoPair: false }
    expect(run('[')).toBe(false); expect(visual.state.doc.textContent).toBe('()')
  })
  it('keeps original unlabelled code and applies the default only to a newly typed fence', () => {
    const preferences = { ...defaultPreferences, defaultCodeLanguage: 'typescript' }, old = pm('existing', 'code_block')
    const plugin = createWritingAidsPlugin(() => preferences)
    expect(plugin.props.handleTextInput?.call(plugin, old.view, 9, 9, ' ', () => old.state.tr)).toBe(false)
    expect(old.state.doc.firstChild?.attrs.language).toBe('')
    const fresh = pm('```'), tr = writingAidsTypingTransaction(fresh.state, 4, 4, ' ', preferences)!
    fresh.dispatch(tr)
    expect(fresh.state.doc.firstChild?.type.name).toBe('code_block'); expect(fresh.state.doc.firstChild?.attrs.language).toBe('typescript')
    const explicit = pm('```python')
    explicit.dispatch(writingAidsTypingTransaction(explicit.state, 10, 10, '\n', preferences)!)
    expect(explicit.state.doc.firstChild?.attrs.language).toBe('python')
    expect(undo(fresh.state, fresh.dispatch)).toBe(true); expect(fresh.state.doc.textContent).toBe('```')
    const source = cm('```', preferences)
    const enter = source.state.facet(keymap).flat().find((binding) => binding.key === 'Enter')!
    expect(enter.run?.(source.view)).toBe(true); expect(source.state.doc.toString()).toBe('```typescript\n')
    const closing = cm('```js\nconst x = 1\n```', preferences)
    const closingEnter = closing.state.facet(keymap).flat().find((binding) => binding.key === 'Enter')!
    expect(closingEnter.run?.(closing.view)).toBe(false)
    expect(closing.state.doc.toString()).toBe('```js\nconst x = 1\n```')
  })
})

describe('safe fresh URL creation', () => {
  it('recognizes safe complete URLs and keeps balanced parentheses while excluding script/prose', () => {
    expect(trailingUrl('See https://example.com/a_(b).')).toMatchObject({ text: 'https://example.com/a_(b)', from: 4 })
    expect(trailingUrl('(https://example.com)')).toBeNull()
    expect(safeTypingUrl('www.example.com/x')).toBe('https://www.example.com/x')
    for (const value of ['javascript:alert(1)', 'file:///C:/secret', 'https://', 'https://example.com/"x', 'https://example.com\nnew', 'my prose']) expect(safeTypingUrl(value)).toBeNull()
  })
  it('creates a typed link in both views only when enabled and supports undo/redo as one input change', () => {
    const source = cm('https://example.com'), visual = pm('https://example.com')
    typeCM(source, ' '); typePM(visual, ' ')
    expect(source.state.doc.toString()).toBe('[https://example.com](<https://example.com/>) ')
    expect(visual.state.doc.textContent).toBe('https://example.com ')
    expect(visual.state.doc.firstChild?.firstChild?.marks[0].attrs.href).toBe('https://example.com/')
    expect(visual.state.doc.firstChild?.lastChild?.marks).toEqual([])
    expect(undo(visual.state, visual.dispatch)).toBe(true); expect(visual.state.doc.textContent).toBe('https://example.com')
    expect(redo(visual.state, visual.dispatch)).toBe(true)
    expect(cmUndo(source.view)).toBe(true); expect(source.state.doc.toString()).toBe('https://example.com')
    const off = { ...defaultPreferences, autoLink: false }
    expect(sourceTypingTransaction(cm('https://example.com', off).view, 19, 19, ' ', off)).toBeNull()
    expect(writingAidsTypingTransaction(pm('https://example.com').state, 20, 20, ' ', off)).toBeNull()
  })
  it('pastes a URL over selected text without replacing the label and refuses composition and literals', () => {
    const visual = pm('中文标签'), plugin = createWritingAidsPlugin(() => defaultPreferences)
    visual.dispatch(visual.state.tr.setSelection(TextSelection.create(visual.state.doc, 1, 5)))
    const event = { clipboardData: { getData: () => 'https://example.com/path' } } as unknown as ClipboardEvent
    expect(plugin.props.handlePaste?.call(plugin, visual.view, event, undefined as never)).toBe(true)
    expect(visual.state.doc.textContent).toBe('中文标签')
    expect(visual.state.doc.firstChild?.firstChild?.marks[0].attrs.href).toBe('https://example.com/path')
    expect(undo(visual.state, visual.dispatch)).toBe(true); expect(visual.state.doc.firstChild?.firstChild?.marks).toEqual([])
    expect(plugin.props.handlePaste?.call(plugin, { ...visual.view, composing: true } as EditorView, event, undefined as never)).toBe(false)
    expect(plugin.props.handlePaste?.call(plugin, pm('code', 'code_block').view, event, undefined as never)).toBe(false)
    const disabled = createWritingAidsPlugin(() => ({ ...defaultPreferences, autoLink: false }))
    expect(disabled.props.handlePaste?.call(disabled, visual.view, event, undefined as never)).toBe(false)
  })
})
