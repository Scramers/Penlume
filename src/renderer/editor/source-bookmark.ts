import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import type { EditorBookmark } from '../../shared/document-history'

/** A rectangular table selection cannot be represented by one source text range. */
export const restoreSourceBookmark = StateEffect.define<EditorBookmark | null>()
export const sourceBookmarkField = StateField.define<EditorBookmark | null>({
  create: () => null,
  update: (bookmark, transaction) => {
    if (transaction.docChanged || transaction.selection) bookmark = null
    for (const effect of transaction.effects) if (effect.is(restoreSourceBookmark)) bookmark = effect.value?.tableSelection ? effect.value : null
    return bookmark
  },
})

export function sourceEditorBookmark(state: EditorState, scrollRatio = 0): EditorBookmark {
  const { anchor, head } = state.selection.main
  const carried = state.field(sourceBookmarkField, false)
  return { anchor, head, scrollRatio, ...(carried?.anchor === anchor && carried.head === head ? { tableSelection: carried.tableSelection } : {}) }
}
