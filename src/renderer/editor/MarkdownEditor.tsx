import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { CrepeEditorAdapter } from './crepe-adapter'
import { defaultPreferences, type Preferences } from '../../shared/preferences'
import type { TableAction, TableContext } from './table-commands'
import type { TableClipboardReason } from './table-clipboard'
import type {
  EditorAdapter,
  EditorImage,
  EditorLocation,
  EditorSearchQuery,
  EditorSearchSummary,
} from './editor-adapter'

export interface MarkdownEditorHandle {
  refreshResources?: () => void
  tableAction?: (action: TableAction) => void
  getBookmark: () => import('../../shared/document-history').EditorBookmark
  setDropPosition: (x: number, y: number) => void
  restoreBookmark: (bookmark: import('../../shared/document-history').EditorBookmark) => void
  replaceMarkdown: (markdown: string, bookmark?: import('../../shared/document-history').EditorBookmark | null) => void
  getMarkdown: () => string
  getSelectionText: () => string
  captureSelection: () => import('./selection-snapshot').SelectionCopySnapshot | null
  focus: () => void
  centerSelection: () => void
  revealLocation: (location: EditorLocation) => void
  setSearch: (query: EditorSearchQuery) => EditorSearchSummary
  findNext: () => EditorSearchSummary
  findPrevious: () => EditorSearchSummary
  replaceNext: () => EditorSearchSummary
  replaceAll: () => EditorSearchSummary
  insertImage: (image: EditorImage) => void
  insertMarkdown: (markdown: string) => void
  format: (action: import('../../shared/formatting').FormatAction) => void
}

interface MarkdownEditorProps {
  resourceRevision?: number
  onClipboardTransaction?: () => void | (() => void)
  onClipboardRejected?: (reason: TableClipboardReason) => void
  onTableContextChange?: (context: TableContext | null) => void
  onActiveHeadingChange?: (index: number | null) => void
  preferences?: Preferences
  documentKey: string
  /** Callback identity can change independently of the document's saved bookmark. */
  callbackOwnerKey?: string
  initialMarkdown: string
  onChange: (markdown: string) => void
  onError?: (reason: unknown) => void
  onReady?: () => void
  onLoading?: () => void
  onUploadImage: (file: File) => Promise<string>
  onResolveImageUrl: (source: string) => Promise<string> | string
  onResolveMediaUrl: (source: string) => Promise<string> | string
}

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function MarkdownEditor(
  {
    resourceRevision = 0,
    onClipboardTransaction,
    onClipboardRejected,
    preferences = defaultPreferences,
    onTableContextChange,
    onActiveHeadingChange,
    documentKey,
    callbackOwnerKey = documentKey,
    initialMarkdown,
    onChange,
    onError,
    onReady,
    onLoading,
    onUploadImage,
    onResolveImageUrl,
    onResolveMediaUrl,
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<EditorAdapter | null>(null)
  const adapterOwnerRef = useRef<object | null>(null)
  const callbacksRef = useRef({ documentKey, callbackOwnerKey, onChange, onTableContextChange, onActiveHeadingChange, onClipboardTransaction, onClipboardRejected, onError, onReady, onLoading })
  // Invalidate a closing editor's callbacks during render, even when only its
  // extension options changed. Keep documentKey stable for bookmark restoration.
  const callbacks = { documentKey, callbackOwnerKey, onChange, onTableContextChange, onActiveHeadingChange, onClipboardTransaction, onClipboardRejected, onError, onReady, onLoading }
  if (callbacksRef.current.documentKey === documentKey && callbacksRef.current.callbackOwnerKey === callbackOwnerKey) Object.assign(callbacksRef.current, callbacks)
  else callbacksRef.current = callbacks
  const latestMarkdownRef = useRef({ documentKey, markdown: initialMarkdown })
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  const remountRef = useRef<{ documentKey: string; markdown: string; bookmark: import('../../shared/document-history').EditorBookmark } | null>(null)
  const teardownRef = useRef<Promise<void>>(Promise.resolve())
  const extensionKey = JSON.stringify(preferences.markdownExtensions)

  useImperativeHandle(
    forwardedRef,
    () => ({
      refreshResources: () => adapterRef.current?.refreshResources?.(),
      tableAction: (action) => adapterRef.current?.tableAction?.(action),
      getBookmark: () => adapterRef.current?.getBookmark() ?? { anchor: 0, head: 0 },
      setDropPosition: (x, y) => adapterRef.current?.setDropPosition(x, y),
      restoreBookmark: (bookmark) => adapterRef.current?.restoreBookmark(bookmark),
      replaceMarkdown: (markdown, bookmark) => adapterRef.current?.replaceMarkdown(markdown, bookmark),
      getMarkdown: () =>
        adapterRef.current?.getMarkdown() ?? (latestMarkdownRef.current.documentKey === documentKey ? latestMarkdownRef.current.markdown : initialMarkdown),
      getSelectionText: () => adapterRef.current?.getSelectionText() ?? '',
      captureSelection: () => {
        const adapter = adapterRef.current, owner = callbacksRef.current
        if (!adapter || adapterOwnerRef.current !== owner) return null
        const snapshot = adapter.captureSelection()
        return snapshot ? Object.freeze({ result: snapshot.result, isCurrent: () => adapterRef.current === adapter && callbacksRef.current === owner && snapshot.isCurrent() }) : null
      },
      focus: () => adapterRef.current?.focus(),
      centerSelection: () => adapterRef.current?.centerSelection(),
      revealLocation: (location) => adapterRef.current?.revealLocation(location),
      setSearch: (query) =>
        adapterRef.current?.setSearch(query) ?? { count: 0, current: 0, valid: true },
      findNext: () =>
        adapterRef.current?.findNext() ?? { count: 0, current: 0, valid: true },
      findPrevious: () =>
        adapterRef.current?.findPrevious() ?? { count: 0, current: 0, valid: true },
      replaceNext: () =>
        adapterRef.current?.replaceNext() ?? { count: 0, current: 0, valid: true },
      replaceAll: () =>
        adapterRef.current?.replaceAll() ?? { count: 0, current: 0, valid: true },
      insertImage: (image) => adapterRef.current?.insertImage(image),
      insertMarkdown: (markdown) => adapterRef.current?.insertMarkdown(markdown),
      format: (action) => adapterRef.current?.format(action),
    }),
    [initialMarkdown, documentKey],
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    let disposed = false
    const mountCallbacks = callbacksRef.current
    const currentMount = () => !disposed && callbacksRef.current === mountCallbacks
    const remembered = remountRef.current?.documentKey === documentKey ? remountRef.current : null
    const adapter = new CrepeEditorAdapter(
      root,
      remembered?.markdown ?? initialMarkdown,
      (markdown) => { if (currentMount()) { latestMarkdownRef.current = { documentKey, markdown }; mountCallbacks.onChange(markdown) } },
      onUploadImage,
      onResolveImageUrl,
      preferences.markdownExtensions,
      onResolveMediaUrl,
      (context) => { if (currentMount()) mountCallbacks.onTableContextChange?.(context) },
      preferencesRef.current,
      () => currentMount() ? mountCallbacks.onClipboardTransaction?.() : undefined,
      (reason) => { if (currentMount()) mountCallbacks.onClipboardRejected?.(reason) },
      (index) => { if (currentMount()) mountCallbacks.onActiveHeadingChange?.(index) },
    )
    adapterRef.current = adapter
    adapterOwnerRef.current = mountCallbacks
    let mounted = false

    const mountPromise = teardownRef.current.then(() => adapter.mount())
    void mountPromise
      .then(() => {
        if (!disposed) {
          mounted = true
        }
        if (currentMount()) {
          adapter.setPreferences(preferencesRef.current)
          if (remembered) adapter.restoreBookmark(remembered.bookmark)
          mountCallbacks.onReady?.()
        }
      })
      .catch((reason: unknown) => {
        if (currentMount()) mountCallbacks.onError?.(reason)
      })

    return () => {
      disposed = true
      if (mounted) {
        const markdown = adapter.getMarkdown()
        remountRef.current = { documentKey, markdown, bookmark: adapter.getBookmark() }
        if (markdown !== latestMarkdownRef.current.markdown && latestMarkdownRef.current.documentKey === documentKey) mountCallbacks.onChange(markdown)
        latestMarkdownRef.current = { documentKey, markdown }
      }
      mountCallbacks.onLoading?.()
      if (adapterRef.current === adapter) adapterRef.current = null
      if (adapterOwnerRef.current === mountCallbacks) adapterOwnerRef.current = null
      teardownRef.current = mountPromise.then(() => adapter.destroy()).catch(() => undefined)
    }
  }, [documentKey, callbackOwnerKey, onResolveImageUrl, onResolveMediaUrl, onUploadImage, extensionKey])

  useEffect(() => { adapterRef.current?.setPreferences?.(preferences) }, [preferences])

  useEffect(() => { adapterRef.current?.refreshResources?.() }, [resourceRevision])

  return <div className="markdown-editor" ref={rootRef} />
})
