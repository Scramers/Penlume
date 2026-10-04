export interface EditorBookmark {
  anchor: number
  head: number
  scrollRatio?: number
  embedded?: { kind: 'inline-math' | 'code-meta'; sourceOffset: number; anchor: number; head: number }
  tableSelection?: { sourceOffset: number; anchor: { row: number; column: number }; head: { row: number; column: number } }
}
export interface HistorySnapshot { markdown: string; bookmark: EditorBookmark | null }
interface EditRange { from: number; removed: number; inserted: string }
function difference(before: string, after: string): EditRange {
  let from = 0, endBefore = before.length, endAfter = after.length
  while (from < endBefore && from < endAfter && before[from] === after[from]) from++
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter-- }
  return { from, removed: endBefore - from, inserted: after.slice(from, endAfter) }
}

// One timeline per document, independent of the editor used to make each change.
export class DocumentHistory {
  private past: HistorySnapshot[] = []
  private future: HistorySnapshot[] = []
  private present: HistorySnapshot
  private lastEdit: EditRange | null = null
  private lastAt = 0
  constructor(markdown: string, private readonly maximumEntries = 200, private readonly maximumBytes = 16 * 1024 * 1024) {
    this.present = { markdown, bookmark: null }
  }
  get current(): HistorySnapshot { return this.present }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }
  setBookmark(bookmark: EditorBookmark | null): void { this.present = { ...this.present, bookmark } }
  boundary(): void { this.lastEdit = null }
  record(markdown: string, bookmark: EditorBookmark | null = null, at = Date.now(), joinComposition = false): boolean {
    if (markdown === this.present.markdown) { if (bookmark) this.setBookmark(bookmark); return false }
    const edit = difference(this.present.markdown, markdown)
    const previous = this.lastEdit
    const typing = !edit.inserted.includes('\n') && edit.inserted.length <= 2 && edit.removed <= 2 && Boolean(edit.inserted.length || edit.removed)
    const contiguous = previous && (edit.from === previous.from + previous.inserted.length || (!edit.inserted && edit.from + edit.removed === previous.from))
    const join = this.future.length === 0 && ((typing && contiguous && at - this.lastAt < 650) || (joinComposition && this.lastEdit && this.past.length > 0))
    if (!join) this.past.push(this.present)
    this.present = { markdown, bookmark }
    this.future = []
    this.lastEdit = typing || joinComposition ? edit : null
    this.lastAt = at
    while (this.past.length > this.maximumEntries) this.past.shift()
    let bytes = this.past.reduce((sum, entry) => sum + entry.markdown.length * 2, 0)
    while (bytes > this.maximumBytes && this.past.length > 1) bytes -= this.past.shift()!.markdown.length * 2
    return true
  }
  undo(): HistorySnapshot | null {
    const previous = this.past.pop()
    if (!previous) return null
    this.future.push(this.present); this.present = previous; this.boundary()
    return previous
  }
  redo(): HistorySnapshot | null {
    const next = this.future.pop()
    if (!next) return null
    this.past.push(this.present); this.present = next; this.boundary()
    return next
  }
}
