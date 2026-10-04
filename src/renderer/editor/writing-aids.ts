import { EditorSelection, EditorState as CMState, Prec, type Extension } from '@codemirror/state'
import { EditorView as CMView, keymap } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { Preferences } from '../../shared/preferences'
import { asciiPairs, pairedDeletion, pendingLiteral, planTyping, safeTypingUrl, trailingUrl, urlMarkdown } from '../../shared/writing-aids'
import { isMarkdownLiteralPosition } from './markdown-position'

export function sourceLiteralPosition(state: CMState, from: number, to = from): boolean {
  for (const position of [from, to]) {
    for (let node = syntaxTree(state).resolveInner(position, -1); node; node = node.parent!) {
      if (/^(?:FencedCode|CodeBlock|InlineCode|CodeText|URL|Autolink|HTMLBlock|HTMLTag|ProcessingInstruction|Link)$/.test(node.name)) return true
      if (!node.parent) break
    }
  }
  const text = state.doc.toString()
  if (/^---\r?\n/.test(text)) {
    const end = text.slice(4).search(/^---\s*$/m)
    if (from < (end < 0 ? text.length + 1 : end + 7)) return true
  }
  return isMarkdownLiteralPosition(text, from) || isMarkdownLiteralPosition(text, to) || pendingLiteral(state.doc.lineAt(from).text.slice(0, from - state.doc.lineAt(from).from))
}

export function sourceTypingTransaction(view: Pick<CMView, 'state' | 'composing' | 'compositionStarted'>, from: number, to: number, input: string, preferences: Preferences) {
  if (view.composing || view.compositionStarted || view.state.readOnly || input.length !== 1 || view.state.selection.ranges.length !== 1) return null
  // Ordinary characters cannot trigger assistance; avoid flattening and parsing
  // the full source document before declining them.
  const pairing = preferences.autoPair && (Object.hasOwn(asciiPairs, input) || Object.values(asciiPairs).includes(input))
  const punctuation = preferences.smartPunctuation && /["'.-]/.test(input)
  const linking = preferences.autoLink && from === to && /\s/.test(input)
  if (!pairing && !punctuation && !linking) return null
  const state = view.state, text = state.doc.toString(), literal = sourceLiteralPosition(state, from, to)
  const plan = planTyping(text, from, to, input, preferences, literal)
  if (plan) {
    const reverse = plan.kind === 'pair' && state.selection.main.anchor > state.selection.main.head
    return state.update({ changes: plan.insert || plan.to !== plan.from ? { from: plan.from, to: plan.to, insert: plan.insert } : undefined, selection: EditorSelection.range(reverse ? plan.head : plan.anchor, reverse ? plan.anchor : plan.head), userEvent: 'input.type', scrollIntoView: true })
  }
  if (preferences.autoLink && !literal && from === to && /\s/.test(input)) {
    const line = state.doc.lineAt(from), token = trailingUrl(text.slice(line.from, from))
    if (token) {
      const start = line.from + token.from, end = line.from + token.to, replacement = urlMarkdown(token.text, token.href)
      const suffix = text.slice(end, from) + input
      return state.update({ changes: { from: start, to, insert: replacement + suffix }, selection: { anchor: start + replacement.length + suffix.length }, userEvent: 'input.type', scrollIntoView: true })
    }
  }
  return null
}

export function sourceWritingAids(preferences: Preferences): Extension {
  return [
    Prec.highest(CMView.inputHandler.of((view, from, to, input) => {
      const transaction = sourceTypingTransaction(view, from, to, input, preferences)
      if (transaction) { view.dispatch(transaction); return true }
      return false
    })),
    Prec.highest(keymap.of([
      { key: 'Backspace', run: (view) => {
        if (!preferences.autoPair || view.composing || view.compositionStarted || view.state.readOnly || view.state.selection.ranges.length !== 1) return false
        const { from, to } = view.state.selection.main, change = pairedDeletion(view.state.doc.toString(), from, to)
        if (!change) return false
        view.dispatch({ changes: change, selection: { anchor: change.from }, userEvent: 'delete.backward', scrollIntoView: true }); return true
      } },
      { key: 'Enter', run: (view) => {
        if (view.composing || view.compositionStarted || view.state.readOnly || !view.state.selection.main.empty) return false
        const { from } = view.state.selection.main, line = view.state.doc.lineAt(from)
        let openingFence = true
        for (let node = syntaxTree(view.state).resolveInner(from, -1); node; node = node.parent!) {
          if (node.name === 'FencedCode') { openingFence = node.from >= line.from; break }
          if (!node.parent) break
        }
        if (openingFence && preferences.defaultCodeLanguage && from === line.to && /^ {0,3}```[ \t]*$/.test(line.text)) {
          const end = line.from + line.text.indexOf('```') + 3, insert = preferences.defaultCodeLanguage + '\n'
          view.dispatch({ changes: { from: end, to: from, insert }, selection: { anchor: end + insert.length }, userEvent: 'input.type', scrollIntoView: true }); return true
        }
        const transaction = sourceTypingTransaction(view, from, from, '\n', preferences)
        if (!transaction) return false
        view.dispatch(transaction); return true
      } },
    ])),
    CMView.domEventHandlers({ paste: (event, view) => {
      if (!preferences.autoLink || view.composing || view.compositionStarted || view.state.readOnly || view.state.selection.ranges.length !== 1) return false
      const value = event.clipboardData?.getData('text/plain') ?? '', href = safeTypingUrl(value)
      const { from, to } = view.state.selection.main
      if (!href || sourceLiteralPosition(view.state, from, to)) return false
      const label = from === to ? value : view.state.sliceDoc(from, to)
      if (/\r?\n/.test(label)) return false
      const insert = urlMarkdown(label, href)
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.paste', scrollIntoView: true }); event.preventDefault(); return true
    } }),
  ]
}

function literalSelection(state: EditorState): boolean {
  const { $from, $to } = state.selection
  const marks = [...(state.storedMarks ?? $from.marks()), ...$to.marks(), ...($from.nodeBefore?.marks ?? [])]
  return !$from.sameParent($to) || !$from.parent.isTextblock || Boolean($from.parent.type.spec.code) || marks.some((mark) => mark.type.spec.code || /^(?:link|inlineMath|math_inline)$/.test(mark.type.name))
}

function typedLink(state: EditorState, from: number, to: number, input: string): Transaction | null {
  if (from !== to || literalSelection(state)) return null
  const mark = state.schema.marks.link, $from = state.doc.resolve(from)
  const prefix = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
  if (!mark || pendingLiteral(prefix)) return null
  const token = trailingUrl(prefix)
  if (!token) return null
  const start = from - prefix.length + token.from, end = from - prefix.length + token.to
  const tr = state.tr.insertText(input, from, to).addMark(start, end, mark.create({ href: token.href, title: null }))
  tr.removeStoredMark(mark); return tr
}

export function writingAidsTypingTransaction(state: EditorState, from: number, to: number, input: string, preferences: Preferences, composing = false): Transaction | null {
  if (composing || input.length !== 1) return null
  const $from = state.doc.resolve(from), $to = state.doc.resolve(to)
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null
  const prefix = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
  // Fence creation is an explicit user input action. Existing unlabelled blocks stay unlabelled.
  const fence = prefix.match(/^```([\w+#.-]*)$/)
  if (fence && /\s/.test(input) && !literalSelection(state) && $to.parentOffset === $to.parent.content.size && state.schema.nodes.code_block) {
    return state.tr.delete(from - prefix.length, to).setBlockType(from - prefix.length, from - prefix.length, state.schema.nodes.code_block, { language: fence[1] || preferences.defaultCodeLanguage })
  }
  const literal = literalSelection(state)
  if (preferences.autoLink && !literal && /\s/.test(input)) {
    const link = typedLink(state, from, to, input)
    if (link) return link
  }
  // Inline backticks wrap a selection semantically, rather than producing escaped Markdown text.
  const code = state.schema.marks.inlineCode
  if (preferences.autoPair && input === '`' && from !== to && code && !literal) {
    const tr = state.tr.removeMark(from, to).addMark(from, to, code.create())
    return tr.setSelection(TextSelection.create(tr.doc, from, to))
  }
  const text = $from.parent.textBetween(0, $from.parent.content.size, '', '\ufffc')
  const plan = planTyping(text, $from.parentOffset, $to.parentOffset, input, preferences, literal)
  if (!plan) return null
  const start = from - $from.parentOffset
  if (plan.kind === 'skip' && input === '`' && code && !literal) {
    const opening = prefix.lastIndexOf('`')
    if (opening >= 0 && opening < prefix.length - 1 && !prefix.slice(opening + 1).includes('`')) {
      const begin = start + opening, content = prefix.slice(opening + 1)
      const tr = state.tr.replaceWith(begin, from + 1, state.schema.text(content, [code.create()]))
      return tr.setSelection(TextSelection.create(tr.doc, begin + content.length)).removeStoredMark(code)
    }
  }
  const tr = state.tr
  if (plan.insert || plan.from !== plan.to) tr.insertText(plan.insert, start + plan.from, start + plan.to)
  const reverse = plan.kind === 'pair' && state.selection.anchor > state.selection.head
  return tr.setSelection(TextSelection.create(tr.doc, start + (reverse ? plan.head : plan.anchor), start + (reverse ? plan.anchor : plan.head)))
}

/** Native arrow movement can precede ProseMirror's selectionchange notification. */
export function writingAidsDomCaret(view: Pick<EditorView, 'state' | 'dom' | 'hasFocus' | 'posAtDOM'>): number | null {
  if (!(view.state.selection instanceof TextSelection) || !view.state.selection.empty || !view.hasFocus()) return null
  const selection = view.dom.ownerDocument.getSelection()
  if (!selection || selection.rangeCount !== 1 || !selection.isCollapsed || selection.anchorNode !== selection.focusNode || selection.anchorOffset !== selection.focusOffset) return null
  const node = selection.focusNode as (Text & { pmViewDesc?: { node?: { isText: boolean; text?: string } } }) | null
  // Accept actual ProseMirror text only. Nested CodeMirror, HTML previews and
  // atomic-node controls keep their own caret and must not edit this document.
  if (!node || node.nodeType !== 3 || !view.dom.contains(node) || !node.pmViewDesc?.node?.isText || node.pmViewDesc.node.text !== node.textContent) return null
  if (node.parentElement?.closest('.cm-editor, input, textarea, select, button, [contenteditable="false"]')) return null
  try {
    const position = view.posAtDOM(node, selection.focusOffset)
    return view.state.doc.resolve(position).parent.isTextblock ? position : null
  } catch { return null }
}

export function writingAidsBackspaceTransaction(state: EditorState, position = state.selection.from): Transaction | null {
  if (!(state.selection instanceof TextSelection) || !state.selection.empty || !Number.isInteger(position) || position < 0 || position > state.doc.content.size) return null
  const $from = state.doc.resolve(position)
  if (!$from.parent.isTextblock) return null
  const text = $from.parent.textBetween(0, $from.parent.content.size, '', '\ufffc')
  const change = pairedDeletion(text, $from.parentOffset, $from.parentOffset)
  if (!change) return null
  const start = position - $from.parentOffset
  // Set the observed caret and delete as one transaction: no separate selection
  // dispatch, artificial history boundary or document change on ordinary deletion.
  return state.tr.setSelection(TextSelection.create(state.doc, position)).delete(start + change.from, start + change.to).scrollIntoView()
}

/** Also install as a direct view prop, ahead of Milkdown's Markdown clipboard parser. */
export function handleWritingAidsPaste(view: EditorView, event: ClipboardEvent, preferences: Preferences): boolean {
  if (!preferences.autoLink || !view.editable || view.composing || literalSelection(view.state)) return false
  const value = event.clipboardData?.getData('text/plain') ?? '', href = safeTypingUrl(value), link = view.state.schema.marks.link
  if (!href || !link) return false
  const { from, to } = view.state.selection
  const tr = from === to ? view.state.tr.insertText(value, from, to) : view.state.tr
  const end = from === to ? from + value.length : to
  tr.addMark(from, end, link.create({ href, title: null })).setSelection(TextSelection.create(tr.doc, end)).removeStoredMark(link)
  view.dispatch(tr.setMeta('uiEvent', 'paste').scrollIntoView()); return true
}

export function createWritingAidsPlugin(getPreferences: () => Preferences): Plugin {
  return new Plugin({
    key: new PluginKey('ttyporaWritingAids'),
    props: {
      handleTextInput: (view, from, to, input) => {
        if (!view.editable) return false
        const tr = writingAidsTypingTransaction(view.state, from, to, input, getPreferences(), view.composing)
        if (!tr) return false
        view.dispatch(tr.setMeta('uiEvent', 'input').scrollIntoView()); return true
      },
      handleKeyDown: (view, event) => {
        if (!view.editable || view.composing || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return false
        const preferences = getPreferences(), { from, to } = view.state.selection
        if (event.key === 'Enter') {
          const fence = writingAidsTypingTransaction(view.state, from, to, '\n', preferences)
          if (fence && fence.doc.nodeAt(view.state.selection.$from.before())?.type.name === 'code_block') { view.dispatch(fence.scrollIntoView()); return true }
          if (preferences.autoLink) {
            // Mark the existing token, then let the usual paragraph/list Enter command run.
            const tr = typedLink(view.state, from, to, '')
            if (tr) view.dispatch(tr)
          }
          return false
        }
        if (event.key !== 'Backspace' || !preferences.autoPair || from !== to) return false
        const caret = writingAidsDomCaret(view)
        if (caret === null) return false
        const transaction = writingAidsBackspaceTransaction(view.state, caret)
        if (!transaction) return false
        view.dispatch(transaction); return true
      },
      handlePaste: (view, event) => handleWritingAidsPaste(view, event, getPreferences()),
    },
  })
}

export const createWritingAids = (getPreferences: () => Preferences) => $prose(() => createWritingAidsPlugin(getPreferences))

// Native basicSetup may include closeBrackets. A highest-priority handler makes
// the explicit preference authoritative, including when it has just been disabled.
export function codePairExtension(preferences: Preferences): Extension {
  return [Prec.highest(CMView.inputHandler.of((view, from, to, input) => {
    if (view.composing || view.compositionStarted || view.state.readOnly || input.length !== 1 || view.state.selection.ranges.length !== 1) return false
    const plan = planTyping(view.state.doc.toString(), from, to, input, { ...preferences, smartPunctuation: false, autoLink: false }, true)
    if (plan) { view.dispatch({ changes: plan.insert ? { from: plan.from, to: plan.to, insert: plan.insert } : undefined, selection: EditorSelection.range(plan.anchor, plan.head), userEvent: 'input.type' }); return true }
    if (Object.hasOwn(asciiPairs, input) || Object.values(asciiPairs).includes(input)) {
      view.dispatch({ changes: { from, to, insert: input }, selection: { anchor: from + input.length }, userEvent: 'input.type' }); return true
    }
    return false
  })), Prec.highest(keymap.of([{ key: 'Backspace', run: (view) => {
    if (view.composing || view.compositionStarted || view.state.readOnly || view.state.selection.ranges.length !== 1) return false
    const { from, to } = view.state.selection.main, pair = pairedDeletion(view.state.doc.toString(), from, to)
    if (!pair) return false
    const change = preferences.autoPair ? pair : { from: from - 1, to: from }
    view.dispatch({ changes: change, selection: { anchor: change.from }, userEvent: 'delete.backward' }); return true
  } }]))]
}
