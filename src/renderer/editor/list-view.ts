import type { NodeViewConstructor } from '@milkdown/kit/prose/view'

/** Keep the installed list controls, but restore the live selection when their
 * delayed content-DOM attachment callback runs. The native view dispatches a
 * selection-only transaction for this attachment; checkbox edits still pass
 * through unchanged. A newer bookmark or user selection must take precedence.
 */
export function nativeListSelectionView(constructor: () => NodeViewConstructor): NodeViewConstructor {
  return (node, view, getPos, decorations, innerDecorations) => {
    const nativeView = new Proxy(view, {
      get(target, property) {
        if (property === 'dispatch') return (transaction: Parameters<typeof view.dispatch>[0]) => {
          if (!transaction.docChanged && transaction.selectionSet && transaction.isGeneric && !transaction.storedMarksSet) {
            if (transaction.before !== target.state.doc) return
            if (!transaction.selection.eq(target.state.selection)) {
              transaction.setSelection(target.state.selection)
                .setStoredMarks(target.state.storedMarks).setMeta('addToHistory', false)
            }
          }
          target.dispatch(transaction)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return constructor()(node, nativeView, getPos, decorations, innerDecorations)
  }
}
