export interface EditorAdapter {
  refreshResources?(): void
  tableAction?(action: import('./table-commands').TableAction): void
  setPreferences?(preferences: import('../../shared/preferences').Preferences): void
  getBookmark(): import('../../shared/document-history').EditorBookmark
  setDropPosition(x: number, y: number): void
  restoreBookmark(bookmark: import('../../shared/document-history').EditorBookmark): void
  replaceMarkdown(markdown: string, bookmark?: import('../../shared/document-history').EditorBookmark | null): void
  mount(): Promise<void>
  getMarkdown(): string
  getSelectionText(): string
  captureSelection(): import('./selection-snapshot').SelectionCopySnapshot | null
  focus(): void
  centerSelection(): void
  revealLocation(location: EditorLocation): void
  setSearch(query: EditorSearchQuery): EditorSearchSummary
  findNext(): EditorSearchSummary
  findPrevious(): EditorSearchSummary
  replaceNext(): EditorSearchSummary
  replaceAll(): EditorSearchSummary
  insertImage(image: EditorImage): void
  insertMarkdown(markdown: string): void
  format(action: import('../../shared/formatting').FormatAction): void
  destroy(): Promise<void>
}

export interface EditorLocation {
  headingIndex: number
  line: number
  column?: number
}

export interface EditorSearchQuery {
  search: string
  replace: string
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

export interface EditorSearchSummary {
  count: number
  current: number
  valid: boolean
}

export interface EditorImage {
  src: string
  alt: string
}

export type EditorChangeListener = (markdown: string) => void
