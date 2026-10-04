import { EditorView as CodeMirrorView } from '@codemirror/view'
import { fromExactSelection, type SelectionFragmentResult } from './selection-fragment'

/** A fragment plus a read-only lease on the original mount/content; never a source bookmark. */
export interface SelectionCopySnapshot {
  readonly result: SelectionFragmentResult
  readonly isCurrent: () => boolean
}

export function captureEmbeddedSelection(root: HTMLElement): SelectionCopySnapshot | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null
  const code = active.closest<HTMLElement>('.cm-editor')
  if (code) {
    const view = CodeMirrorView.findFromDOM(code)
    if (!view) return Object.freeze({ result: { ok: false as const, reason: 'unsupported-selection' as const }, isCurrent: () => root.isConnected && root.contains(code) })
    const doc = view.state.doc, selection = view.state.selection
    const result: SelectionFragmentResult = selection.ranges.some((range) => range !== selection.main && !range.empty)
      ? { ok: false, reason: 'unsupported-selection' }
      : fromExactSelection(doc.sliceString(selection.main.from, selection.main.to), 'literal')
    return Object.freeze({ result, isCurrent: () => root.isConnected && root.contains(view.dom) && view.state.doc === doc })
  }
  if (active instanceof HTMLButtonElement || active instanceof HTMLSelectElement) {
    return Object.freeze({ result: { ok: false as const, reason: 'unsupported-selection' as const }, isCurrent: () => root.isConnected && root.contains(active) })
  }
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return null
  const documentField = active.matches('[data-code-meta], [data-math-source-editor], [data-html-source-editor], .caption-input, .link-input-area')
  const value = active.value, from = active.selectionStart, to = active.selectionEnd
  const result: SelectionFragmentResult = !documentField || from === null || to === null
    ? { ok: false, reason: 'unsupported-selection' }
    : fromExactSelection(value.slice(Math.min(from, to), Math.max(from, to)), 'literal')
  return Object.freeze({ result, isCurrent: () => root.isConnected && root.contains(active) && active.isConnected && active.value === value })
}
