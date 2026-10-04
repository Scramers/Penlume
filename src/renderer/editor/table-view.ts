import type { NodeView, NodeViewConstructor } from '@milkdown/kit/prose/view'

/** Only editable table data goes to ProseMirror's normal caret/CellSelection handlers. */
export function isTableContentMouseEvent(nodeView: NodeView, event: Event): boolean {
  if (event.type !== 'mousedown' && event.type !== 'pointerdown') return false
  if ((event as MouseEvent).button !== 0 || !nodeView.contentDOM) return false
  const target = event.target as Node | null
  if (!target || typeof target.nodeType !== 'number' || !nodeView.contentDOM.contains(target)) return false
  const element = target.nodeType === 1 ? target as Element : target.parentElement
  if (!element || typeof element.closest !== 'function') return false
  const cell = element.closest('th, td')
  if (!cell || !nodeView.contentDOM.contains(cell)) return false
  // Atomic inline editors and resize/tool widgets retain their own event handling.
  if (element.closest('button, input, textarea, select, [contenteditable="false"], [data-display-type="tool"], .handle, .column-resize-handle')) return false
  return true
}

/**
 * Crepe's table view intercepts cell pointer/mousedown and schedules a paragraph
 * NodeSelection, preventing tableEditing from making a rectangular CellSelection.
 * Its update also rejects equal nodes when only selection decorations changed,
 * which makes ProseMirror replace the whole Vue table and detach the caret target.
 * Keep that existing view for equal document nodes; genuine document changes still
 * use the bound native update. Mounting, contentDOM, control events and destroy
 * remain owned by the native view.
 */
export function nativeTableSelectionView(constructor: () => NodeViewConstructor): NodeViewConstructor {
  return (...args) => {
    const current = constructor()(...args)
    const stopEvent = current.stopEvent?.bind(current)
    current.stopEvent = (event) => isTableContentMouseEvent(current, event) ? false : stopEvent?.(event) ?? false
    const update = current.update?.bind(current)
    if (update) {
      let node = args[0]
      current.update = (next, decorations, innerDecorations) => {
        if (next.eq(node)) { node = next; return true }
        const accepted = update(next, decorations, innerDecorations)
        if (accepted) node = next
        return accepted
      }
    }
    return current
  }
}
