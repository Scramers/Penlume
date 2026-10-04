import type { Slice } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import { CellSelection, isInTable } from '@milkdown/kit/prose/tables'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeTableClipboardSlice, tableGridFromSlice, tablePasteTransaction, tableSelectionTsv, TABLE_CLIPBOARD_LIMITS, type TableClipboardLimits, type TableClipboardReason } from './table-clipboard'

export type TableClipboardOperation = 'paste' | 'cut'
export interface TableClipboardProtocolOptions {
  limits?: TableClipboardLimits
  /** Close application history before dispatch and return its after-dispatch cleanup. */
  historyBoundary?: (view: EditorView, operation: TableClipboardOperation) => void | (() => void)
  onError?: (error: unknown) => void
  onRejected?: (reason: TableClipboardReason) => void
  /** Inspect the serializer's result before clipboard writes or a cut deletion. */
  serializationRejection?: (view: EditorView) => TableClipboardReason | undefined
}
interface PendingPaste { slice: Slice; view: EditorView; state: EditorState; isPlainText: boolean; rejection?: TableClipboardReason }

/**
 * One factory per editor. Register transformPasted as the FINAL Milkdown paste
 * rule (after removing its native tablePasteRule), handlePaste before Milkdown's
 * clipboard plugin, and copy/cut as view handleDOMEvents. HTML is never reparsed.
 * The final returned Slice identity carries plain-text intent to handlePaste.
 */
export function createTableClipboardProtocol(options: TableClipboardProtocolOptions = {}) {
  const limits = options.limits ?? TABLE_CLIPBOARD_LIMITS
  let pending: PendingPaste | undefined
  const reportError = (error: unknown) => { try { options.onError?.(error) } catch { /* Reporting must not make a rejected clipboard event destructive. */ } }
  const consume = (event: Event, reason?: TableClipboardReason) => {
    event.preventDefault()
    if (reason) { try { options.onRejected?.(reason) } catch (error) { reportError(error) } }
    return true
  }
  const dispatch = (view: EditorView, tr: Transaction, operation: TableClipboardOperation) => {
    if (!tr.docChanged) { view.dispatch(tr); return }
    let cleanup: void | (() => void) = undefined
    try {
      cleanup = options.historyBoundary?.(view, operation)
      view.dispatch(closeHistory(tr))
    } finally {
      try { view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false)) }
      finally { cleanup?.() }
    }
  }
  const transformPasted = (slice: Slice, view: EditorView, isPlainText: boolean): Slice => {
    // Plain TSV is parsed from the event's original text, regardless of any HTML
    // flavors or earlier clipboardTextParser/paste-rule transformations.
    const normalized = isPlainText ? { ok: true as const, value: slice } : normalizeTableClipboardSlice(slice, view.state.schema, { insideTable: isInTable(view.state), isPlainText, limits })
    const result = normalized.ok ? normalized.value : slice
    pending = { slice: result, view, state: view.state, isPlainText, rejection: !normalized.ok && normalized.reason !== 'not-grid' ? normalized.reason : undefined }
    return result
  }
  const handlePaste = (view: EditorView, event: ClipboardEvent, slice: Slice): boolean => {
    const intent = pending
    pending = undefined
    if (!view.editable) return false
    if (!intent || intent.slice !== slice || intent.view !== view || intent.state !== view.state) {
      // A later transform must not silently lose this protocol's intent and send
      // table data into the native handler that cannot satisfy the strict schema.
      const grid = tableGridFromSlice(slice, limits)
      return view.state.selection instanceof CellSelection || grid.ok || grid.reason !== 'not-grid' ? consume(event, 'unsupported-shape') : false
    }
    if (intent.rejection) return consume(event, intent.rejection)
    if (!isInTable(view.state)) return false
    if (intent.isPlainText && !event.clipboardData) return consume(event, 'unsupported-shape')
    try {
      const result = tablePasteTransaction(view.state, intent.isPlainText ? { isPlainText: true, text: event.clipboardData!.getData('text/plain') } : { isPlainText: false, slice }, limits)
      if (!result.ok) return result.reason === 'not-grid' || result.reason === 'not-table' ? false : consume(event, result.reason)
      event.preventDefault()
      dispatch(view, result.value, 'paste')
      return true
    } catch (error) { reportError(error); return consume(event) }
  }
  const copyOrCut = (view: EditorView, event: ClipboardEvent, cut: boolean): boolean => {
    pending = undefined
    if (!(view.state.selection instanceof CellSelection) || cut && !view.editable) return false
    const text = tableSelectionTsv(view.state, limits)
    if (!text.ok) return consume(event, text.reason)
    if (!event.clipboardData) return consume(event, 'unsupported-shape')
    // Prepare both the native serialization and a valid cut transaction before
    // writing the clipboard. A failed write never deletes document content.
    const deletion = cut ? tablePasteTransaction(view.state, { isPlainText: true, text: '' }, limits) : null
    if (deletion && !deletion.ok) return consume(event, deletion.reason)
    event.preventDefault()
    try {
      const serialized = view.serializeForClipboard(view.state.selection.content())
      const rejection = options.serializationRejection?.(view)
      if (rejection) return consume(event, rejection)
      event.clipboardData.clearData()
      event.clipboardData.setData('text/html', serialized.dom.innerHTML)
      event.clipboardData.setData('text/plain', text.value)
      if (deletion?.ok) dispatch(view, deletion.value.setMeta('uiEvent', 'cut').setMeta('paste', false), 'cut')
    } catch (error) { reportError(error) }
    return true
  }
  return {
    transformPasted, handlePaste,
    handleDOMEvents: {
      copy: (view: EditorView, event: Event) => copyOrCut(view, event as ClipboardEvent, false),
      cut: (view: EditorView, event: Event) => copyOrCut(view, event as ClipboardEvent, true),
    },
    reset: () => { pending = undefined },
  }
}
