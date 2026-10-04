import { Compartment, EditorState as CodeMirrorState, type Extension } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { EditorView as CodeMirror, drawSelection, keymap } from '@codemirror/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { undo, redo } from '@milkdown/kit/prose/history'
import { exitCode } from '@milkdown/kit/prose/commands'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import { readInterfaceLanguage } from '../localization'
import { translate } from '../../shared/localization'
import { renderMathPreview } from './code-math-schema'

const t = (key: string) => translate(readInterfaceLanguage(), key)

function showPreview(target: HTMLElement, diagnostic: HTMLElement, value: string, displayMode: boolean) {
  const rendered = renderMathPreview(value, displayMode)
  if (rendered.html !== null) target.innerHTML = rendered.html
  else { target.replaceChildren(); const source = document.createElement('code'); source.textContent = value; target.append(source) }
  diagnostic.textContent = rendered.error ? `${t('公式无法渲染；源码已保留，可在下方修复。')} ${rendered.error}` : ''
  diagnostic.hidden = !rendered.error
  target.dataset.mathStatus = rendered.error ? 'error' : 'ready'
}

/** A true textblock makes source selection, search and shared undo use the parent document. */
export function createDisplayMathView(extensions: Extension = []): NodeViewConstructor {
  return (initial, view, getPos) => {
  let node = initial, updating = false, disposed = false
  const dom = document.createElement('div')
  dom.className = 'ttypora-math-block'
  dom.dataset.mathBlock = 'true'
  dom.contentEditable = 'false'
  const preview = document.createElement('div')
  preview.className = 'ttypora-math-preview'
  const diagnostic = document.createElement('p')
  diagnostic.className = 'ttypora-math-diagnostic'
  diagnostic.setAttribute('role', 'status')
  const header = document.createElement('div')
  header.className = 'ttypora-math-source-label'
  const editorHost = document.createElement('div')
  editorHost.className = 'ttypora-math-source'
  const readOnly = new Compartment()
  const escape = (direction: -1 | 1, line: boolean) => {
    const selection = cm.state.selection.main
    if (!selection.empty) return false
    const range = line ? cm.state.doc.lineAt(selection.head) : selection
    if (direction < 0 ? range.from > 0 : range.to < cm.state.doc.length) return false
    const position = getPos()
    if (typeof position !== 'number' || view.isDestroyed) return false
    const target = position + (direction < 0 ? 0 : node.nodeSize)
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target), direction)).scrollIntoView())
    view.focus()
    return true
  }
  const cm = new CodeMirror({
    parent: editorHost, root: view.root, doc: node.textContent,
    extensions: [
      readOnly.of(CodeMirrorState.readOnly.of(!view.editable)),
      drawSelection(),
      CodeMirror.contentAttributes.of({ 'data-math-source-editor': 'true' }),
      CodeMirror.theme({ '&': { fontSize: '13px', backgroundColor: 'transparent', color: 'inherit' }, '.cm-content': { fontFamily: 'var(--font-mono, Consolas, monospace)', padding: '10px 0' }, '.cm-scroller': { overflow: 'auto' }, '&.cm-focused': { outline: 'none' } }),
      extensions,
      keymap.of([
        { key: 'Mod-z', run: () => undo(view.state, view.dispatch) },
        { key: 'Shift-Mod-z', run: () => redo(view.state, view.dispatch) },
        { key: 'Mod-y', run: () => redo(view.state, view.dispatch) },
        { key: 'Mod-Enter', run: () => { if (!exitCode(view.state, view.dispatch)) return false; view.focus(); return true } },
        { key: 'ArrowUp', run: () => escape(-1, true) }, { key: 'ArrowDown', run: () => escape(1, true) },
        { key: 'ArrowLeft', run: () => escape(-1, false) }, { key: 'ArrowRight', run: () => escape(1, false) },
        indentWithTab, ...defaultKeymap,
      ]),
      CodeMirrorState.changeFilter.of(() => view.editable || updating),
      CodeMirror.updateListener.of((update) => {
        if (updating || disposed || !cm.hasFocus || view.isDestroyed) return
        const position = getPos()
        if (typeof position !== 'number') return
        const transaction = view.state.tr
        let offset = position + 1
        update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          if (inserted.length) transaction.replaceWith(offset + fromA, offset + toA, view.state.schema.text(inserted.toString()))
          else transaction.delete(offset + fromA, offset + toA)
          offset += toB - fromB - (toA - fromA)
        })
        const selected = update.state.selection.main
        const anchor = position + 1 + selected.anchor, head = position + 1 + selected.head
        if (update.docChanged || view.state.selection.anchor !== anchor || view.state.selection.head !== head) {
          view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, anchor, head)))
        }
      }),
    ],
  })
  const localize = () => {
    header.textContent = t('公式源码')
    cm.contentDOM.setAttribute('aria-label', t('公式源码'))
    preview.setAttribute('aria-label', t('公式预览'))
    showPreview(preview, diagnostic, node.textContent, true)
  }
  dom.append(preview, diagnostic, header, editorHost)
  localize()
  window.addEventListener('ttypora:interface-language', localize)
  const sync = (next: ProseNode) => {
    if (next.type !== node.type) return false
    const previousValue = node.textContent
    node = next
    if (view.editable === cm.state.readOnly) cm.dispatch({ effects: readOnly.reconfigure(CodeMirrorState.readOnly.of(!view.editable)) })
    const old = cm.state.doc.toString(), value = next.textContent
    if (old !== value) {
      // A minimal patch keeps selection on unaffected characters during external history changes.
      let start = 0, oldEnd = old.length, newEnd = value.length
      while (start < oldEnd && start < newEnd && old[start] === value[start]) start++
      while (oldEnd > start && newEnd > start && old[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd-- }
      updating = true
      try { cm.dispatch({ changes: { from: start, to: oldEnd, insert: value.slice(start, newEnd) } }) } finally { updating = false }
    }
    // Local CM input already contains the new text before ProseMirror updates
    // its node view. Preview invalidation must follow the document node too.
    if (previousValue !== value) showPreview(preview, diagnostic, value, true)
    return true
  }
  return {
    dom, update: sync, ignoreMutation: () => true, stopEvent: () => true,
    setSelection: (anchor, head) => { updating = true; try { cm.dispatch({ selection: { anchor, head } }); cm.focus() } finally { updating = false } },
    selectNode: () => { dom.classList.add('selected'); cm.focus() }, deselectNode: () => dom.classList.remove('selected'),
    destroy: () => { disposed = true; window.removeEventListener('ttypora:interface-language', localize); cm.destroy() },
  }
  }
}

/** Clearing an existing formula removes its atom in the same undoable input transaction. */
export function inlineMathValueTransaction(state: EditorState, position: number, value: string, composing = false): Transaction | null {
  // IME may temporarily clear a replacement range before supplying its final
  // text. Keep the editor alive until compositionend commits that empty value.
  if (composing && value === '') return null
  const node = state.doc.nodeAt(position)
  if (node?.type.name !== 'math_inline' || node.attrs.value === value) return null
  if (value !== '') return state.tr.setNodeAttribute(position, 'value', value)
  const transaction = state.tr.delete(position, position + node.nodeSize)
  return transaction.setSelection(TextSelection.near(transaction.doc.resolve(position)))
}

/** Inline formulas keep a source editor beside their preview, including after a KaTeX error. */
export const inlineMathView: NodeViewConstructor = (initial, view, getPos) => {
  let node = initial, composing = false
  const dom = document.createElement('span')
  dom.className = 'ttypora-math-inline'
  dom.dataset.type = 'math_inline'
  dom.contentEditable = 'false'
  const preview = document.createElement('span')
  preview.className = 'ttypora-math-inline-preview'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'ttypora-math-inline-edit'
  const panel = document.createElement('span')
  panel.className = 'ttypora-math-inline-panel'
  panel.hidden = true
  const input = document.createElement('textarea')
  input.dataset.mathSourceEditor = 'true'
  input.value = String(node.attrs.value)
  input.rows = 2
  input.spellcheck = false
  input.readOnly = !view.editable
  edit.disabled = !view.editable
  const diagnostic = document.createElement('span')
  diagnostic.className = 'ttypora-math-diagnostic'
  diagnostic.setAttribute('role', 'status')
  panel.append(input, diagnostic)
  dom.append(preview, edit, panel)
  const render = () => {
    dom.dataset.value = String(node.attrs.value)
    showPreview(preview, diagnostic, String(node.attrs.value), false)
    if (preview.dataset.mathStatus === 'error') panel.hidden = false
  }
  const localize = () => { input.setAttribute('aria-label', t('行内公式源码')); edit.textContent = t('编辑公式'); edit.setAttribute('aria-expanded', String(!panel.hidden)); render() }
  const open = () => { if (!view.editable) return; panel.hidden = false; edit.setAttribute('aria-expanded', 'true'); input.focus() }
  edit.addEventListener('click', open)
  preview.addEventListener('click', open)
  const commitSource = (inComposition = composing) => {
    if (!view.editable || view.isDestroyed) return
    const position = getPos()
    if (typeof position !== 'number') return
    const transaction = inlineMathValueTransaction(view.state, position, input.value, inComposition)
    if (!transaction) return
    view.dispatch(transaction)
    if (input.value === '') view.focus()
  }
  input.addEventListener('compositionstart', () => { composing = true })
  input.addEventListener('compositionend', () => { composing = false; commitSource() })
  input.addEventListener('input', (event) => commitSource(composing || event instanceof InputEvent && event.isComposing))
  input.addEventListener('keydown', (event) => {
    if (composing || event.isComposing || event.keyCode === 229) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? redo : undo)(view.state, view.dispatch); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(view.state, view.dispatch); return }
    if (event.key === 'Escape' || event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); panel.hidden = true; edit.setAttribute('aria-expanded', 'false'); view.focus()
    }
  })
  localize()
  window.addEventListener('ttypora:interface-language', localize)
  return {
    dom, stopEvent: () => true, ignoreMutation: () => true,
    selectNode: open,
    update: (next) => { if (next.type !== node.type) return false; node = next; if (!composing && input.value !== String(next.attrs.value)) input.value = String(next.attrs.value); input.readOnly = !view.editable; edit.disabled = !view.editable; render(); return true },
    destroy: () => window.removeEventListener('ttypora:interface-language', localize),
  }
}

/** Preserve the native CodeMirror node view and add an independently editable info field. */
export function codeMetadataView(nativeFactory: () => NodeViewConstructor): NodeViewConstructor {
  return (initial, view, getPos, decorations, innerDecorations) => {
    let node = initial
    const native = nativeFactory()(node, view, getPos, decorations, innerDecorations)
    const dom = document.createElement('div')
    dom.className = 'ttypora-code-block'
    const label = document.createElement('label')
    label.className = 'ttypora-code-meta'
    const title = document.createElement('span')
    const input = document.createElement('input')
    input.type = 'text'; input.dataset.codeMeta = 'true'; input.value = String(node.attrs.meta ?? '')
    input.spellcheck = false; input.readOnly = !view.editable
    const localize = () => { title.textContent = t('代码块附加信息'); input.setAttribute('aria-label', t('代码块附加信息')); input.placeholder = t('例如 title="example.ts" {1,3-5}') }
    input.addEventListener('input', () => {
      if (!view.editable || view.isDestroyed) return
      const position = getPos()
      if (typeof position === 'number') view.dispatch(view.state.tr.setNodeAttribute(position, 'meta', input.value || null))
    })
    input.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? redo : undo)(view.state, view.dispatch) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(view.state, view.dispatch) }
      if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); view.focus() }
    })
    label.append(title, input); dom.append(native.dom, label)
    localize(); window.addEventListener('ttypora:interface-language', localize)
    return {
      dom,
      update: (next, nextDecorations, nextInnerDecorations) => {
        if (next.type !== node.type || native.update && !native.update(next, nextDecorations, nextInnerDecorations)) return false
        node = next; if (input.value !== String(next.attrs.meta ?? '')) input.value = String(next.attrs.meta ?? ''); input.readOnly = !view.editable; return true
      },
      setSelection: (anchor, head, root) => native.setSelection?.(anchor, head, root),
      selectNode: () => native.selectNode?.(), deselectNode: () => native.deselectNode?.(),
      stopEvent: (event) => label.contains(event.target as Node) || (native.stopEvent?.(event) ?? false),
      ignoreMutation: (mutation) => label.contains(mutation.target) || (native.ignoreMutation?.(mutation) ?? mutation.type !== 'selection'),
      destroy: () => { window.removeEventListener('ttypora:interface-language', localize); native.destroy?.() },
    }
  }
}
