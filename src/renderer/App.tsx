import { localizedDocumentName } from '../shared/localization'
import { APP_NAME, APP_TAGLINE } from '../shared/branding'
import { documentTypographyCss } from '../shared/document-typography'
import type { CSSProperties } from 'react'
import { LayoutPanel } from './components/LayoutPanel'
import { ResizeHandle } from './components/ResizeHandle'
import { useElementSize } from './use-element-size'
import { defaultWorkspaceLayout, parseWorkspaceLayout, sidebarMaximum, SIDEBAR_MIN, SIDEBAR_OVERLAY_BELOW, SPLIT_STACK_BELOW } from './workspace-layout'
import { clipboardBodyFragment, renderSelectionFragment } from './selection-copy-html'
import type { SelectionCopySnapshot } from './editor/selection-snapshot'
import { useLocalization, useLocalizedState, localized } from './localization'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useReducer,
  useState,
} from 'react'
import type {
  DocumentSnapshot,
  ExternalFileChange,
  RecoveryDraft,
  WorkspaceSnapshot,
  WorkspaceSearchResult,
  WorkspaceMutation,
  RecentEntry,
  ResourceDocumentSnapshot,
} from '../shared/contracts'
import { extractMarkdownHeadings, type MarkdownHeading } from '../shared/markdown-outline'
import {
  computeWritingStatistics,
  type WritingStatistics,
} from '../shared/writing-statistics'
import { Modal } from './components/Modal'
import {
  SearchPanel,
  type SearchPanelMode,
} from './components/SearchPanel'
import { Sidebar, type SidebarMode } from './components/Sidebar'
import {
  WorkspacePalette,
  type WorkspacePaletteMode,
} from './components/WorkspacePalette'
import { WritingStatsPanel } from './components/WritingStatsPanel'
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from './editor/MarkdownEditor'
import { SourceEditor } from './editor/SourceEditor'
import type {
  EditorSearchQuery,
  EditorSearchSummary,
} from './editor/editor-adapter'
import { renderDocumentHtml } from './export-document'
import { renderMermaidForExport } from './mermaid-preview'
import { PreferencesPanel } from './components/PreferencesPanel'
import { FileActionsPanel } from './components/FileActionsPanel'
import { RecentPanel } from './components/RecentPanel'
import { parsePreferences } from '../shared/preferences'
import { uniqueHeadingIds } from '../shared/markdown-extensions'
import { formatLabels, type FormatAction } from '../shared/formatting'
import { draftFromDocument, fromSnapshot, isDirty, newDocument, samePath } from '../shared/document-session'
import { useDocumentSession } from './use-document-session'
import { DocumentHistory } from '../shared/document-history'
import { Icon } from './components/Icon'
import { DocumentTabs } from './components/DocumentTabs'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'
import { LivePreview } from './components/LivePreview'
import { WritingGoal, useWritingGoal } from './components/WritingGoal'
import { ConversionDialog } from './components/ConversionDialog'
import { ThemeLibrary } from './components/ThemeLibrary'
import { useThemeLibrary } from './theme-library'
import { ImageLibrary } from './components/ImageLibrary'
import type { ImageLibraryRequest, ImageLibraryMutation } from '../shared/image-library'
import type { ImageLibraryItem } from '../shared/image-library'
import { ImageUploader } from './components/ImageUploader'
import { TableTools } from './components/TableTools'
import type { TableContext } from './editor/table-commands'
import { maximumMediaBytes, mediaFormat, mediaMarkup } from '../shared/media'
import type { EditorBookmark } from '../shared/document-history'
import { createResourceSnapshotTracker, isSameResourceSnapshot, type EditorResourceSnapshot } from './resource-snapshot'
import { markdownOutlineOptions, useMarkdownOutline } from './use-markdown-outline'
import { outlineControlsReducer, type OutlineControlsStore, type OutlineDocumentControlAction } from './outline-controls'

type ThemeMode = 'system' | 'light' | 'dark'
type EditorMode = 'visual' | 'source' | 'split'
interface OutlineEditorOwner {
  documentId: string
  documentKey: string
  editorKey: string
  mode: 'visual' | 'source'
}
interface OutlineCaretActivity {
  owner: OutlineEditorOwner
  rawRevision: number
  markdown: string
  optionsKey: string
  snapshotRevision: number | null
  index: number | null
}

function suggestedMarkdownName(displayName: string): string {
  return /\.md$/i.test(displayName) ? displayName : `${displayName}.md`
}

function suggestedExportName(displayName: string, extension: 'html' | 'pdf' | 'png'): string {
  const stem = displayName.replace(/\.(?:md|markdown|txt)$/i, '') || 'document'
  return `${stem}.${extension}`
}

export function App() {
  const { t, locale } = useLocalization()
  const [preferences, setPreferences] = useState(() => { try { return parsePreferences(JSON.parse(localStorage.getItem('ttypora.preferences') ?? '{}')) } catch { return parsePreferences({}) } })
  const [showPreferences, setShowPreferences] = useState(false)
  const [showLayout, setShowLayout] = useState(false)
  const [layout, setLayout] = useState(() => { try { return parseWorkspaceLayout(JSON.parse(localStorage.getItem('ttypora.layout') ?? '{}')) } catch { return defaultWorkspaceLayout } })
  const [workspaceElement, workspaceSize] = useElementSize()
  const [panesElement, panesSize] = useElementSize()
  const sidebarOverlay = workspaceSize.width > 0 && workspaceSize.width < SIDEBAR_OVERLAY_BELOW
  const sidebarWidth = Math.min(layout.sidebarWidth, sidebarMaximum(workspaceSize.width || window.innerWidth))
  const splitStacked = panesSize.width > 0 && panesSize.width < SPLIT_STACK_BELOW
  useEffect(() => { localStorage.setItem('ttypora.layout', JSON.stringify(layout)) }, [layout])
  useEffect(() => { void window.ttypora.setInterfaceZoom(preferences.interfaceZoom / 100).catch((reason) => setError(String(reason))) }, [preferences.interfaceZoom])
  const [fileActions, setFileActions] = useState<{ path: string | null } | null>(null)
  const [recentEntries, setRecentEntries] = useState<RecentEntry[]>([])
  const [showRecent, setShowRecent] = useState(false)
  const { session, sessionRef, document, documentRef, setDocument, updateDocument, activateDocument, removeDocument } = useDocumentSession()
  const [showCommands, setShowCommands] = useState(false)
  const [showGoal, setShowGoal] = useState(false)
  const [showConversion, setShowConversion] = useState(false)
  const [showThemes, setShowThemes] = useState(false)
  const [imageDocumentId, setImageDocumentId] = useState<string | null>(null)
  const [uploaderDocument, setUploaderDocument] = useState<{ id: string; path: string; images: ImageLibraryItem[]; initialImageIds?: string[] } | null>(null)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('ttypora.theme')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [effectiveAppearance, setEffectiveAppearance] = useState<'light' | 'dark'>(() => themeMode === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : themeMode)
  const themeLibrary = useThemeLibrary()
  const effectivePreferences = useMemo(() => ({ ...preferences, customCss: themeLibrary.exportCss(effectiveAppearance, preferences.customCss) }), [preferences, themeLibrary, effectiveAppearance])
  const [editorMode, setEditorMode] = useState<EditorMode>('visual')
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => { const saved = localStorage.getItem('ttypora.sidebar'); return saved === 'outline' || saved === 'files' ? saved : 'hidden' })
  useEffect(() => { localStorage.setItem('ttypora.sidebar', sidebarMode) }, [sidebarMode])
  const [outlineControlStore, dispatchOutlineControlAction] = useReducer(outlineControlsReducer, new Map() as OutlineControlsStore)
  const outlineControlDocumentIdsKey = session.documents.map(({ id }) => id).join('\0')
  useEffect(() => { dispatchOutlineControlAction({ type: 'retain', documentIds: session.documents.map(({ id }) => id) }) }, [outlineControlDocumentIdsKey])
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [typewriterMode, setTypewriterMode] = useState(false)
  const [editorReady, setEditorReady] = useState(false)
  const [tableContext, setTableContext] = useState<TableContext | null>(null)
  const [searchPanelMode, setSearchPanelMode] = useState<SearchPanelMode>('hidden')
  const [searchPanelNonce, setSearchPanelNonce] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchReplacement, setSearchReplacement] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchWholeWord, setSearchWholeWord] = useState(false)
  const [searchRegexp, setSearchRegexp] = useState(false)
  const [searchSummary, setSearchSummary] = useState<EditorSearchSummary>({
    count: 0,
    current: 0,
    valid: true,
  })
  const [workspacePaletteMode, setWorkspacePaletteMode] = useState<WorkspacePaletteMode>('hidden')
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [workspaceSearchResult, setWorkspaceSearchResult] = useState<WorkspaceSearchResult | null>(null)
  const [workspaceSearchLoading, setWorkspaceSearchLoading] = useState(false)
  const [workspaceSearchError, setWorkspaceSearchError] = useLocalizedState(null)
  const [showWritingStats, setShowWritingStats] = useState(false)
  const [selectionStats, setSelectionStats] = useState<WritingStatistics | null>(null)
  const [message, setMessage] = useLocalizedState('准备就绪')
  const [error, setError] = useLocalizedState(null)
  useEffect(() => { void window.ttypora.setInterfaceLanguage(locale).catch((reason) => setError(String(reason))) }, [locale])
  const [recoveryDrafts, setRecoveryDrafts] = useState<RecoveryDraft[]>([])
  const [showRecovery, setShowRecovery] = useState(false)
  const conflict = document.conflict ?? null
  const setConflict = useCallback((change: ExternalFileChange | null) => updateDocument(documentRef.current.id, (current) => ({ ...current, conflict: change })), [updateDocument, documentRef])
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const mountedDocumentId = useRef<string | null>(null)
  const selectionCopyRef = useRef<{ documentId: string; path: string | null; snapshot: SelectionCopySnapshot } | null>(null)
  const selectionCopyRequest = useRef(0)
  const selectionCopyLocale = useRef(locale)
  selectionCopyLocale.current = locale
  const outlineDocumentKey = `${document.id}:${document.revision}`
  // Split view owns the same source editor and caret as source mode.
  const outlineEditorMode = editorMode === 'visual' ? 'visual' : 'source'
  const { options: outlineOptions, optionsKey: outlineOptionsKey } = markdownOutlineOptions(preferences.markdownExtensions)
  const outline = useMarkdownOutline(outlineDocumentKey, document.markdown, outlineOptions)
  const outlineEditorKey = `${outlineDocumentKey}:${outlineEditorMode}${outlineEditorMode === 'visual' ? `:${outlineOptionsKey}` : ''}`
  const outlineOwner = useMemo<OutlineEditorOwner>(() => ({
    documentId: document.id, documentKey: outlineDocumentKey,
    editorKey: outlineEditorKey, mode: outlineEditorMode,
  }), [document.id, outlineDocumentKey, outlineEditorKey, outlineEditorMode])
  const mountedOutlineOwner = useRef<OutlineEditorOwner | null>(null)
  const outlineRawIdentity = useRef<{ documentKey: string; markdown: string; optionsKey: string; revision: number } | null>(null)
  const trackOutlineRaw = useCallback((documentKey: string, markdown: string, optionsKey: string) => {
    const previous = outlineRawIdentity.current
    if (!previous || previous.documentKey !== documentKey || previous.markdown !== markdown || previous.optionsKey !== optionsKey) {
      outlineRawIdentity.current = { documentKey, markdown, optionsKey, revision: (previous?.revision ?? 0) + 1 }
    }
    return outlineRawIdentity.current!
  }, [])
  const rawOutlineRevision = trackOutlineRaw(outlineDocumentKey, document.markdown, outlineOptionsKey).revision
  const outlineContext = useRef({ owner: outlineOwner, outline, optionsKey: outlineOptionsKey })
  outlineContext.current = { owner: outlineOwner, outline, optionsKey: outlineOptionsKey }
  const handleOutlineControlAction = useCallback((action: OutlineDocumentControlAction) => {
    const context = outlineContext.current
    if (context.outline.pending || context.outline.error || action.documentId !== context.owner.documentId
      || action.tree.headings !== context.outline.headings) return
    dispatchOutlineControlAction(action)
  }, [])
  const [outlineCaret, setOutlineCaret] = useState<OutlineCaretActivity | null>(null)
  // Programmatic replacements publish a PM caret while their normal onChange is
  // suppressed. Bind that notification to the already-known replacement bytes.
  const outlineReplacement = useRef<{ documentId: string; markdown: string } | null>(null)
  const replaceEditorMarkdown = useCallback((documentId: string, markdown: string, bookmark?: EditorBookmark | null) => {
    outlineReplacement.current = { documentId, markdown }
    try { editorRef.current?.replaceMarkdown(markdown, bookmark) }
    finally { outlineReplacement.current = null }
  }, [])
  const invalidateEditor = useCallback(() => { mountedDocumentId.current = null; mountedOutlineOwner.current = null; setOutlineCaret(null); setEditorReady(false); setTableContext(null) }, [])
  const readMarkdownFor = useCallback((id: string) => mountedDocumentId.current === id ? editorRef.current?.getMarkdown() ?? sessionRef.current.documents.find((item) => item.id === id)?.markdown ?? '' : sessionRef.current.documents.find((item) => item.id === id)?.markdown ?? '', [sessionRef])
  const resourceSnapshots = useRef(createResourceSnapshotTracker())
  const readResourceSnapshot = useCallback((id: string): EditorResourceSnapshot | null => {
    const current = sessionRef.current.documents.find((item) => item.id === id)
    return current ? resourceSnapshots.current.capture(id, current.path, readMarkdownFor(id)) : null
  }, [sessionRef, readMarkdownFor])
  const resourceRevision = resourceSnapshots.current.capture(document.id, document.path, document.markdown).resourceRevision
  const resourceDocument = (snapshot: EditorResourceSnapshot): ResourceDocumentSnapshot => {
    if (!snapshot.documentPath) throw new Error(t('使用本地资源前需要先保存文档'))
    return { documentPath: snapshot.documentPath, markdown: snapshot.markdown }
  }
  const histories = useRef(new Map<string, DocumentHistory>())
  const applyingHistory = useRef(false)
  const compositionDocument = useRef<string | null>(null)
  const historyFor = useCallback((id: string, markdown: string) => {
    let history = histories.current.get(id)
    if (!history || history.current.markdown !== markdown) { history = new DocumentHistory(markdown); histories.current.set(id, history) }
    return history
  }, [])
  const recordChange = useCallback((id: string, markdown: string) => {
    if (applyingHistory.current) return
    const current = sessionRef.current.documents.find((item) => item.id === id)
    if (!current) return
    const bookmark = mountedDocumentId.current === id ? editorRef.current?.getBookmark() ?? null : null
    historyFor(id, current.markdown).record(markdown, bookmark, Date.now(), compositionDocument.current === id)
  }, [historyFor, sessionRef])
  const beginClipboardTransaction = useCallback((id: string) => {
    const current = sessionRef.current.documents.find((item) => item.id === id)
    if (!current || mountedDocumentId.current !== id) return
    const history = historyFor(id, current.markdown)
    history.setBookmark(editorRef.current?.getBookmark() ?? null)
    history.boundary()
    // Keep the same instance after the synchronous editor change updates the session.
    return () => history.boundary()
  }, [historyFor, sessionRef])
  const clipboardHistoryCleanup = useRef(new WeakMap<Event, { finish: () => void; input: HTMLElement | null }>())
  const clipboardInputEvents = useRef(new WeakMap<HTMLElement, Event>())
  const finishClipboardHistory = useCallback((event: Event, afterInput = false) => {
    const pending = clipboardHistoryCleanup.current.get(event)
    if (!pending || pending.input && !afterInput) return
    clipboardHistoryCleanup.current.delete(event)
    if (pending.input && clipboardInputEvents.current.get(pending.input) === event) clipboardInputEvents.current.delete(pending.input)
    pending.finish()
  }, [])
  const finishClipboardInput = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return
    const event = clipboardInputEvents.current.get(target)
    if (event) finishClipboardHistory(event, true)
  }, [finishClipboardHistory])
  const separateClipboardHistory = useCallback((event: Event, target: EventTarget | null) => {
    if (!(target instanceof HTMLElement) || !target.closest('.ProseMirror, .source-editor .cm-content')) return
    const finish = beginClipboardTransaction(documentRef.current.id)
    // Close after the native editor handler in the bubbling phase, before the
    // next input can arrive. A timer alone can run after that next input.
    if (finish) {
      // Native fields commit during the default action's input event, after
      // paste/cut propagation. Close these only after that model notification.
      const input = target.matches('input,textarea') ? target : null
      clipboardHistoryCleanup.current.set(event, { finish, input })
      if (input) clipboardInputEvents.current.set(input, event)
      window.setTimeout(() => finishClipboardHistory(event, true), 0)
    }
  }, [beginClipboardTransaction, documentRef, finishClipboardHistory])
  const rememberPosition = useCallback(() => {
    const current = documentRef.current
    if (mountedDocumentId.current !== current.id) return
    const markdown = readMarkdownFor(current.id)
    if (markdown === current.markdown) historyFor(current.id, markdown).setBookmark(editorRef.current?.getBookmark() ?? null)
  }, [documentRef, readMarkdownFor, historyFor])
  const restorePosition = useCallback(() => {
    const current = documentRef.current
    if (pendingLocation.current) return
    const bookmark = historyFor(current.id, current.markdown).current.bookmark
    if (bookmark) editorRef.current?.restoreBookmark(bookmark)
    return Boolean(bookmark)
  }, [documentRef, historyFor])

  const showSnapshot = useCallback((snapshot: DocumentSnapshot) => {
    const current = documentRef.current
    const markdown = readMarkdownFor(current.id)
    recordChange(current.id, markdown)
    historyFor(current.id, markdown).boundary()
    updateDocument(current.id, (item) => ({ ...item, markdown }))
    if (current.recovered || markdown !== current.savedMarkdown) void window.ttypora.updateDraft(draftFromDocument(current, markdown)).catch((reason) => setError(String(reason)))
    invalidateEditor()
    setDocument(fromSnapshot(snapshot))
    updateDocument(documentRef.current.id, (item) => ({ ...item, revision: item.revision + 1 }))
  }, [invalidateEditor, setDocument, updateDocument, documentRef, readMarkdownFor, recordChange, historyFor])
  const lastDraftWriteAt = useRef(0)
  const [sessionRestored, setSessionRestored] = useState(false)
  const pendingLocation = useRef<{ line?: number; column?: number; anchor?: string } | null>(null)

  useEffect(() => {
    localStorage.setItem('ttypora.preferences', JSON.stringify(preferences))
    const root = window.document.documentElement
    root.style.setProperty('--editor-font-size', `${preferences.fontSize}px`)
    root.style.setProperty('--editor-line-height', String(preferences.lineHeight))
    root.style.setProperty('--editor-width', `${preferences.contentWidth}px`)
    root.style.setProperty('--editor-font-family', preferences.fontFamily)
    window.document.querySelectorAll<HTMLElement>('[contenteditable]').forEach((element) => { element.spellcheck = preferences.spellcheck })
  }, [preferences, editorReady])

  useEffect(() => {
    if (document.path) localStorage.setItem('ttypora.lastDocument', document.path)
    if (workspace) localStorage.setItem('ttypora.lastWorkspace', workspace.rootPath)
  }, [document.path, workspace])

  useEffect(() => {
    if (!editorReady || mountedOutlineOwner.current !== outlineOwner || !pendingLocation.current) return
    const location = pendingLocation.current
    pendingLocation.current = null
    const frame = requestAnimationFrame(() => {
      const current = documentRef.current
      if (outlineContext.current.owner !== outlineOwner || mountedOutlineOwner.current !== outlineOwner
        || `${current.id}:${current.revision}` !== outlineOwner.documentKey) return
      if (location.line) editorRef.current?.revealLocation({ headingIndex: -1, line: location.line, column: location.column })
      if (location.anchor) {
        // An explicit user anchor navigation may parse the current raw snapshot.
        const list = extractMarkdownHeadings(current.markdown, outlineOptions)
        const ids = uniqueHeadingIds(list.map((heading) => heading.text))
        const index = ids.indexOf(location.anchor)
        if (index >= 0) editorRef.current?.revealLocation({ headingIndex: index, line: list[index].line })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [editorReady, outlineOwner, outlineOptionsKey])

  const documentName = localizedDocumentName(locale, document.displayName, document.path)
  const dirty = isDirty(document)
  const headings = outline.headings
  const readyOutlineSnapshot = outline.pending ? null : outline.snapshot
  const sourceHeadingLines = useMemo(() => readyOutlineSnapshot?.headings.map((heading) => heading.line), [readyOutlineSnapshot])
  const activeHeadingIndex = editorReady && mountedOutlineOwner.current === outlineOwner && readyOutlineSnapshot
    && outlineCaret?.owner === outlineOwner && outlineCaret.rawRevision === rawOutlineRevision
    && outlineCaret.markdown === document.markdown && outlineCaret.optionsKey === outlineOptionsKey
    && (outlineEditorMode === 'visual' || outlineCaret.snapshotRevision === readyOutlineSnapshot.revision)
    && (outlineCaret.index === null || Number.isSafeInteger(outlineCaret.index) && outlineCaret.index >= 0 && outlineCaret.index < headings.length)
    ? outlineCaret.index : null
  const onVisualActiveHeadingChange = useCallback((index: number | null) => {
    const current = documentRef.current, context = outlineContext.current
    if (context.owner !== outlineOwner || outlineOwner.mode !== 'visual' || context.optionsKey !== outlineOptionsKey
      || `${current.id}:${current.revision}` !== outlineOwner.documentKey) return
    // The frozen adapter publishes after synchronous onChange. Replacements
    // deliberately suppress onChange and use the bytes supplied by their caller.
    const markdown = outlineReplacement.current?.documentId === current.id ? outlineReplacement.current.markdown : current.markdown
    const raw = trackOutlineRaw(outlineOwner.documentKey, markdown, outlineOptionsKey)
    setOutlineCaret((previous) => previous?.owner === outlineOwner && previous.rawRevision === raw.revision && previous.index === index ? previous : {
      owner: outlineOwner, rawRevision: raw.revision, markdown, optionsKey: outlineOptionsKey, snapshotRevision: null, index,
    })
  }, [outlineOwner, outlineOptionsKey, documentRef, trackOutlineRaw])
  const onSourceActiveHeadingChange = useCallback((index: number | null) => {
    const current = documentRef.current, context = outlineContext.current
    // A source index is computed using this callback's headingLines snapshot.
    // A new worker result cannot inherit an index reported for an older list.
    if (!readyOutlineSnapshot || context.owner !== outlineOwner || outlineOwner.mode !== 'source'
      || context.outline.pending || context.outline.snapshot !== readyOutlineSnapshot
      || context.optionsKey !== outlineOptionsKey || `${current.id}:${current.revision}` !== outlineOwner.documentKey
      || current.markdown !== readyOutlineSnapshot.markdown) return
    const raw = trackOutlineRaw(outlineOwner.documentKey, current.markdown, outlineOptionsKey)
    setOutlineCaret((previous) => previous?.owner === outlineOwner && previous.rawRevision === raw.revision
      && previous.snapshotRevision === readyOutlineSnapshot.revision && previous.index === index ? previous : {
      owner: outlineOwner, rawRevision: raw.revision, markdown: current.markdown, optionsKey: outlineOptionsKey,
      snapshotRevision: readyOutlineSnapshot.revision, index,
    })
  }, [outlineOwner, outlineOptionsKey, readyOutlineSnapshot, documentRef, trackOutlineRaw])
  useEffect(() => { if (outline.error) setError(outline.error) }, [outline.error])
  const editorSearchQuery = useMemo<EditorSearchQuery>(
    () => ({
      search: searchQuery,
      replace: searchReplacement,
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
      regexp: searchRegexp,
    }),
    [
      searchCaseSensitive,
      searchQuery,
      searchRegexp,
      searchReplacement,
      searchWholeWord,
    ],
  )

  const openSearchPanel = useCallback(
    (mode: Exclude<SearchPanelMode, 'hidden'>) => {
      setWorkspacePaletteMode('hidden')
      setSearchPanelMode(mode)
      setSearchPanelNonce((current) => current + 1)
    },
    [],
  )

  const closeSearchPanel = useCallback(() => {
    setSearchPanelMode('hidden')
    setSearchSummary(
      editorRef.current?.setSearch({
        search: '',
        replace: '',
        caseSensitive: false,
        wholeWord: false,
        regexp: false,
      }) ?? { count: 0, current: 0, valid: true },
    )
    editorRef.current?.focus()
  }, [])

  const openWorkspacePalette = useCallback(
    (mode: Exclude<WorkspacePaletteMode, 'hidden'>) => {
      setSearchPanelMode('hidden')
      setWorkspaceQuery('')
      setWorkspaceSearchResult(null)
      setWorkspaceSearchError(null)
      setWorkspacePaletteMode(mode)
    },
    [],
  )

  useEffect(() => {
    if (!editorReady || searchPanelMode === 'hidden') return
    setSearchSummary(editorRef.current?.setSearch(editorSearchQuery) ?? {
      count: 0,
      current: 0,
      valid: true,
    })
  }, [editorReady, editorSearchQuery, searchPanelMode])

  useEffect(() => {
    if (workspacePaletteMode !== 'search' || !workspace || !workspaceQuery) {
      setWorkspaceSearchLoading(false)
      setWorkspaceSearchResult(null)
      setWorkspaceSearchError(null)
      return
    }

    let canceled = false
    setWorkspaceSearchLoading(true)
    setWorkspaceSearchError(null)
    const timer = window.setTimeout(() => {
      void window.ttypora.searchWorkspace({
        query: workspaceQuery,
        caseSensitive: searchCaseSensitive,
        wholeWord: searchWholeWord,
        regexp: searchRegexp,
      }).then((result) => {
        if (canceled) return
        setWorkspaceSearchResult(result)
        setWorkspaceSearchLoading(false)
      }).catch((reason) => {
        if (canceled) return
        setWorkspaceSearchResult(null)
        setWorkspaceSearchError(localized("搜索失败：{value1}", { value1: String(reason) }))
        setWorkspaceSearchLoading(false)
      })
    }, 220)

    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
  }, [
    searchCaseSensitive,
    searchRegexp,
    searchWholeWord,
    workspace,
    workspacePaletteMode,
    workspaceQuery,
  ])

  const applyTheme = useCallback((mode: ThemeMode) => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const effective = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode
    window.document.documentElement.dataset.theme = effective
    setEffectiveAppearance(effective)
  }, [])

  useEffect(() => {
    applyTheme(themeMode)
    localStorage.setItem('ttypora.theme', themeMode)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => {
      if (themeMode === 'system') applyTheme(themeMode)
    }
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [applyTheme, themeMode])

  useEffect(() => {
    window.document.title = `${dirty ? '● ' : ''}${documentName} — ${APP_NAME}`
    window.ttypora.setWindowDocumentStatus({
      dirty: session.documents.some(isDirty),
      documents: session.documents.map((item) => ({ dirty: isDirty(item), draftId: item.id, displayName: localizedDocumentName(locale, item.displayName, item.path) })),
      draftId: document.id,
      displayName: documentName,
    })
  }, [dirty, document.displayName, document.id, documentName, session.documents, locale])

  const openPathsKey = JSON.stringify(session.documents.flatMap((item) => item.path ? [item.path] : []))
  useEffect(() => {
    void window.ttypora.syncOpenDocuments(JSON.parse(openPathsKey)).catch((reason) => setError(String(reason)))
  }, [openPathsKey])

  useEffect(() => {
    void window.ttypora
      .listRecoveryDrafts()
      .then(async (drafts) => {
        setRecoveryDrafts(drafts)
        setShowRecovery(drafts.length > 0)
        const launch = await window.ttypora.takeLaunchTarget()
        if (launch) {
          if (launch.workspace) { setWorkspace(launch.workspace); setSidebarMode('files') }
          if (launch.document) { showSnapshot(launch.document) }
          return
        }
        if (!drafts.length && preferences.restoreSession) {
          let savedPaths: string[] = []
          try { savedPaths = JSON.parse(localStorage.getItem('ttypora.openDocuments') ?? '[]') } catch { /* fall back to the last file */ }
          const lastActivePath = localStorage.getItem('ttypora.lastDocument')
          const restorePaths = [localStorage.getItem('ttypora.lastWorkspace'), ...(savedPaths.length ? savedPaths : [localStorage.getItem('ttypora.lastDocument')])]
          for (const saved of restorePaths) {
            if (!saved) continue
            try {
              const result = await window.ttypora.openRecent(saved)
              if (result.workspace) { setWorkspace(result.workspace); setSidebarMode('files') }
              if (result.document) { showSnapshot(result.document) }
            } catch (reason) { setError(localized("恢复上次项目失败：{value1}", { value1: String(reason) })) }
          }
          const active = sessionRef.current.documents.find((item) => lastActivePath && samePath(item.path, lastActivePath))
          if (active && active.id !== documentRef.current.id) { invalidateEditor(); activateDocument(active.id); updateDocument(active.id, (item) => ({ ...item, revision: item.revision + 1 })) }
        }
      })
      .catch((reason) => {
        setError(localized("无法读取恢复草稿：{value1}", { value1: String(reason) }))
      }).finally(() => setSessionRestored(true))
  }, [])

  useEffect(() => {
    if (!dirty) return

    const elapsed = Date.now() - lastDraftWriteAt.current
    const delay = Math.min(1000, Math.max(0, 2000 - elapsed))
    const timer = window.setTimeout(() => {
      const current = documentRef.current
      if (!isDirty(current)) return
      const markdown = readMarkdownFor(current.id)
      void window.ttypora
        .updateDraft(draftFromDocument(current, markdown))
        .then(() => {
          lastDraftWriteAt.current = Date.now()
        })
        .catch((reason) => {
          setError(localized("恢复草稿写入失败：{value1}", { value1: String(reason) }))
        })
    }, delay)

    return () => window.clearTimeout(timer)
  }, [
    dirty,
    document.format,
    document.id,
    document.markdown,
    document.path,
    document.version,
  ])

  useEffect(() => {
    if (sessionRestored) localStorage.setItem('ttypora.openDocuments', openPathsKey)
  }, [openPathsKey, sessionRestored])

  const captureCurrent = useCallback(() => {
    const current = documentRef.current
    const markdown = readMarkdownFor(current.id)
    recordChange(current.id, markdown)
    historyFor(current.id, markdown).boundary()
    updateDocument(current.id, (item) => ({ ...item, markdown }))
    return { ...current, markdown }
  }, [updateDocument, documentRef, recordChange, historyFor, readMarkdownFor])
  const flushDrafts = useCallback(async () => {
    captureCurrent()
    for (const item of sessionRef.current.documents) {
      if (isDirty(item)) await window.ttypora.updateDraft(draftFromDocument(item))
      else await window.ttypora.clearDraft(item.id)
    }
  }, [captureCurrent, sessionRef])
  const switchDocument = useCallback(async (id: string) => {
    if (id === documentRef.current.id) return
    const current = captureCurrent()
    const persisted = isDirty(current) ? window.ttypora.updateDraft(draftFromDocument(current)) : Promise.resolve()
    invalidateEditor()
    activateDocument(id)
    await persisted
  }, [captureCurrent, activateDocument, documentRef])

  const commitSavedSnapshot = useCallback(
    async (snapshot: DocumentSnapshot, savedMarkdown: string, draftId: string) => {
      const item = sessionRef.current.documents.find((document) => document.id === draftId)
      if (!item) return
      const latestMarkdown = documentRef.current.id === draftId ? readMarkdownFor(item.id) : item.markdown
      updateDocument(draftId, (current) => ({ ...current, markdown: latestMarkdown, path: snapshot.path, displayName: snapshot.displayName, format: snapshot.format, version: snapshot.version, savedMarkdown, recovered: false, conflict: null }))
      const updated = sessionRef.current.documents.find((document) => document.id === draftId)!
      if (isDirty(updated)) await window.ttypora.updateDraft(draftFromDocument(updated))
      else await window.ttypora.clearDraft(draftId)
      setMessage(localized("已保存：{value1}", { value1: snapshot.displayName }))
      setError(null)
    },
    [],
  )

  const saveAsCurrent = useCallback(async (id = documentRef.current.id): Promise<boolean> => {
    const current = sessionRef.current.documents.find((item) => item.id === id)
    if (!current) return false
    const markdown = documentRef.current.id === id ? readMarkdownFor(current.id) : current.markdown

    try {
      const result = await window.ttypora.saveDocumentAs({
        markdown,
        format: current.format,
        suggestedName: suggestedMarkdownName(current.displayName),
        excludedPaths: sessionRef.current.documents.filter((item) => item.id !== id).flatMap((item) => item.path ? [item.path] : []),
      })
      if (!result) return false
      if (result.status === 'error') {
        setError(result.message)
        return false
      }
      if (result.status === 'conflict') {
        updateDocument(current.id, (item) => ({ ...item, conflict: {
          path: current.path ?? '',
          kind: result.snapshot ? 'changed' : 'deleted',
          snapshot: result.snapshot,
        } }))
        return false
      }
      await commitSavedSnapshot(result.snapshot, markdown, current.id)
      return !isDirty(sessionRef.current.documents.find((item) => item.id === current.id) ?? current)
    } catch (reason) {
      setError(localized("另存为失败：{value1}", { value1: String(reason) }))
      return false
    }
  }, [commitSavedSnapshot])

  const saveCurrent = useCallback(
    async (force = false, id = documentRef.current.id): Promise<boolean> => {
      const current = sessionRef.current.documents.find((item) => item.id === id)
      if (!current) return false
      const markdown = documentRef.current.id === id ? readMarkdownFor(current.id) : current.markdown

      if (!current.path) return saveAsCurrent(id)
      if (!force && !current.recovered && markdown === current.savedMarkdown) {
        setMessage('文档没有需要保存的修改')
        return true
      }

      setMessage('正在保存…')
      try {
        const result = await window.ttypora.saveDocument({
          path: current.path,
          markdown,
          format: current.format,
          expectedVersion: current.version,
          force,
        })

        if (result.status === 'conflict') {
          updateDocument(current.id, (item) => ({ ...item, conflict: {
            path: current.path!,
            kind: result.snapshot ? 'changed' : 'deleted',
            snapshot: result.snapshot,
          } }))
          setMessage('检测到文件冲突')
          return false
        }
        if (result.status === 'error') {
          setError(result.message)
          setMessage('保存失败')
          return false
        }

        await commitSavedSnapshot(result.snapshot, markdown, current.id)
        const latestMarkdown =
          documentRef.current.id === id ? readMarkdownFor(current.id) : sessionRef.current.documents.find((item) => item.id === id)?.markdown
        return latestMarkdown === markdown
      } catch (reason) {
        setError(localized("保存失败：{value1}", { value1: String(reason) }))
        setMessage('保存失败')
        return false
      }
    },
    [commitSavedSnapshot, saveAsCurrent],
  )

  const ensureImageDocumentPath = useCallback(async (id = documentRef.current.id): Promise<string | null> => {
    const target = sessionRef.current.documents.find((item) => item.id === id)
    if (!target) throw new Error(t('文档已关闭，请重新打开后插入资源。'))
    if (target.path) return target.path
    setMessage('使用本地资源前需要先保存文档')
    const saved = await saveAsCurrent(target.id)
    return saved ? sessionRef.current.documents.find((item) => item.id === target.id)?.path ?? null : null
  }, [saveAsCurrent, documentRef, sessionRef])

  const uploadLocalImage = useCallback(async (file: File): Promise<string> => {
    const targetId = document.id
    const documentPath = await ensureImageDocumentPath(targetId)
    if (!documentPath) {
      const reason = new Error(t("已取消保存，未插入图片。"))
      setError(reason.message)
      throw reason
    }
    try {
      const snapshot = readResourceSnapshot(targetId)
      if (!snapshot || snapshot.documentPath !== documentPath) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
      const asset = await window.ttypora.saveImageAsset(resourceDocument(snapshot), {
        fileName: file.name || 'image.png',
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })
      if (documentRef.current.id !== targetId || !isSameResourceSnapshot(snapshot, readResourceSnapshot(targetId)) || readMarkdownFor(targetId) !== snapshot.markdown) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
      setMessage(localized("已复制图片：{value1}", { value1: asset.markdownUrl }))
      return asset.markdownUrl
    } catch (reason) {
      setError(localized("保存图片失败：{value1}", { value1: String(reason) }))
      throw reason
    }
  }, [document.id, ensureImageDocumentPath, readResourceSnapshot, readMarkdownFor, documentRef])

  const resolveLocalImageUrl = useCallback((source: string): Promise<string> | string => {
    if (/^(https?:|data:|blob:)/i.test(source)) return source
    const snapshot = readResourceSnapshot(document.id)
    if (!snapshot) throw new Error(t('文档已关闭，请重新打开后插入资源。'))
    return window.ttypora.resolveImageUrl(resourceDocument(snapshot), source).then((url) => {
      if (!isSameResourceSnapshot(snapshot, readResourceSnapshot(snapshot.documentId))) throw new Error(t('资源路径已变化，请重试。'))
      return url
    })
  }, [document.id, readResourceSnapshot])

  const resolveLocalMediaUrl = useCallback((source: string): Promise<string> | string => {
    const snapshot = readResourceSnapshot(document.id)
    if (!snapshot?.documentPath) {
      if (/^(?:https?:|data:(?:audio|video)\/)/i.test(source)) return source
      throw new Error(t('请先保存文档后再引用本地音视频。'))
    }
    return window.ttypora.resolveMediaUrl(resourceDocument(snapshot), source).then((url) => {
      if (!isSameResourceSnapshot(snapshot, readResourceSnapshot(snapshot.documentId))) throw new Error(t('资源路径已变化，请重试。'))
      return url
    })
  }, [document.id, readResourceSnapshot])

  const applyDocumentRewrite = useCallback((id: string, expected: string, markdown: string) => {
    const current = sessionRef.current.documents.find((item) => item.id === id)
    if (!current || readMarkdownFor(id) !== expected) throw new Error(t('文档在操作期间发生变化，请重新检查后应用。'))
    if (markdown === expected) return
    const bookmark = mountedDocumentId.current === id ? editorRef.current?.getBookmark() : undefined
    historyFor(id, current.markdown).boundary()
    recordChange(id, markdown)
    applyingHistory.current = true
    try {
      if (mountedDocumentId.current === id) replaceEditorMarkdown(id, markdown, bookmark)
      updateDocument(id, (item) => ({ ...item, markdown, revision: item.revision + (mountedDocumentId.current === id ? 0 : 1) }))
    } finally { applyingHistory.current = false }
    historyFor(id, markdown).boundary()
    void window.ttypora.updateDraft(draftFromDocument({ ...current, markdown })).catch((reason) => setError(String(reason)))
  }, [sessionRef, readMarkdownFor, historyFor, recordChange, updateDocument, replaceEditorMarkdown])

  const insertResources = useCallback((id: string, before: string, bookmark: EditorBookmark, markdown: string) => {
    const current = sessionRef.current.documents.find((item) => item.id === id)
    if (!current || readMarkdownFor(id) !== before) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
    if (mountedDocumentId.current === id && editorRef.current) {
      historyFor(id, current.markdown).boundary()
      editorRef.current.restoreBookmark(bookmark)
      editorRef.current.insertMarkdown(markdown)
      historyFor(id, readMarkdownFor(id)).boundary()
      void window.ttypora.updateDraft(draftFromDocument(current, readMarkdownFor(id))).catch((reason) => setError(String(reason)))
    } else {
      const from = Math.min(before.length, Math.max(0, Math.min(bookmark.anchor, bookmark.head)))
      const to = Math.min(before.length, Math.max(from, Math.max(bookmark.anchor, bookmark.head)))
      applyDocumentRewrite(id, before, before.slice(0, from) + markdown + before.slice(to))
    }
  }, [sessionRef, readMarkdownFor, historyFor, applyDocumentRewrite])

  const handleInsertMedia = useCallback(async () => {
    const target = captureCurrent(), bookmark = editorRef.current?.getBookmark() ?? { anchor: target.markdown.length, head: target.markdown.length }
    const documentPath = await ensureImageDocumentPath(target.id)
    if (!documentPath) return
    try {
      const snapshot = readResourceSnapshot(target.id)
      if (!snapshot || snapshot.documentPath !== documentPath || snapshot.markdown !== target.markdown) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
      const asset = await window.ttypora.chooseMediaAsset(resourceDocument(snapshot))
      if (!asset) return
      if (!isSameResourceSnapshot(snapshot, readResourceSnapshot(target.id))) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
      const name = asset.path.split(/[\\/]/).pop() ?? 'media'
      insertResources(target.id, target.markdown, bookmark, mediaMarkup(asset.markdownUrl, asset.kind, name))
      setMessage(localized('已插入音视频：{name}', { name })); setError(null)
    } catch (reason) { setError(localized('插入音视频失败：{reason}', { reason: String(reason) })) }
  }, [captureCurrent, ensureImageDocumentPath, insertResources, readResourceSnapshot])

  const receiveMediaFiles = useCallback(async (files: File[], point?: { x: number; y: number }) => {
    if (point) editorRef.current?.setDropPosition(point.x, point.y)
    const target = captureCurrent(), bookmark = editorRef.current?.getBookmark() ?? { anchor: target.markdown.length, head: target.markdown.length }
    const documentPath = await ensureImageDocumentPath(target.id)
    if (!documentPath) return
    const markup: string[] = []
    try {
      const snapshot = readResourceSnapshot(target.id)
      if (!snapshot || snapshot.documentPath !== documentPath || snapshot.markdown !== target.markdown) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
      for (const file of files) {
        const media = mediaFormat(file.name, file.type)
        const image = /^image\//i.test(file.type) || /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name)
        if (!media && !image) continue
        if (!file.size || file.size > (media ? maximumMediaBytes : 25 * 1024 * 1024)) throw new Error(t('所选资源为空或超过大小限制。'))
        const request = { fileName: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }
        if (media) {
          const asset = await window.ttypora.saveMediaAsset(resourceDocument(snapshot), request)
          markup.push(mediaMarkup(asset.markdownUrl, asset.kind, file.name))
        } else {
          const asset = await window.ttypora.saveImageAsset(resourceDocument(snapshot), request)
          markup.push(`\n\n![${file.name.replace(/[\[\]\\]/g, '\\$&').replace(/[\r\n]/g, ' ')}](${asset.markdownUrl})\n\n`)
        }
      }
      if (!isSameResourceSnapshot(snapshot, readResourceSnapshot(target.id))) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
      if (markup.length) insertResources(target.id, target.markdown, bookmark, markup.join(''))
      setMessage(localized('已插入 {count} 个本地资源', { count: markup.length })); setError(null)
    } catch (reason) { setError(localized('插入资源失败，已复制的文件仍保留：{reason}', { reason: String(reason) })) }
  }, [captureCurrent, ensureImageDocumentPath, insertResources, readResourceSnapshot])

  const handleInsertImage = useCallback(async () => {
    const target = captureCurrent(), bookmark = editorRef.current?.getBookmark() ?? { anchor: target.markdown.length, head: target.markdown.length }
    const documentPath = await ensureImageDocumentPath(target.id)
    if (!documentPath) return
    try {
      const snapshot = readResourceSnapshot(target.id)
      if (!snapshot || snapshot.documentPath !== documentPath || snapshot.markdown !== target.markdown) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
      const asset = await window.ttypora.chooseImageAsset(resourceDocument(snapshot))
      if (!asset) return
      if (!isSameResourceSnapshot(snapshot, readResourceSnapshot(target.id))) throw new Error(t('插入期间文档发生变化，资源副本已保留，请重新插入。'))
      const fileName = asset.path.split(/[\\/]/).pop() ?? 'image'
      insertResources(target.id, target.markdown, bookmark, `\n\n![${fileName.replace(/[\[\]\\]/g, '\\$&').replace(/[\r\n]/g, ' ')}](${asset.markdownUrl})\n\n`)
      setMessage(localized("已插入图片：{value1}", { value1: fileName }))
      setError(null)
    } catch (reason) {
      setError(localized("插入图片失败：{value1}", { value1: String(reason) }))
    }
  }, [captureCurrent, ensureImageDocumentPath, readResourceSnapshot, insertResources])

  const handleExport = useCallback(async (format: 'html' | 'pdf' | 'png' | 'unstyled-html') => {
    const current = documentRef.current
    const markdown = readMarkdownFor(current.id)
    setMessage(localized("正在生成 {value1}…", { value1: format.toUpperCase() }))
    try {
      const html = await renderMermaidForExport(
        await renderDocumentHtml(markdown, current.displayName, { unstyled: format === 'unstyled-html', toc: effectivePreferences.exportToc, metadata: effectivePreferences.exportMetadata, customCss: effectivePreferences.customCss, preferences: effectivePreferences }),
      )
      const request = {
        html,
        markdown,
        sourcePath: current.path,
        suggestedName: suggestedExportName(current.displayName, format === 'unstyled-html' ? 'html' : format),
        pdf: preferences.pdf,
      }
      const result = format === 'html' || format === 'unstyled-html'
        ? await window.ttypora.exportHtml(request)
        : format === 'png' ? await window.ttypora.exportPng(request) : await window.ttypora.exportPdf(request)
      if (!result) {
        setMessage('已取消导出')
        return
      }
      setMessage(result.warnings?.length ? localized('已导出：{path}；{count} 处资源以引用说明保留', { path: result.path, count: result.warnings.length }) : localized("已导出：{value1}", { value1: result.path }))
      setError(null)
    } catch (reason) {
      setError(localized("导出失败：{value1}", { value1: String(reason) }))
      setMessage('导出失败')
    }
  }, [effectivePreferences])

  const openImageLibrary = useCallback(async () => {
    const id = documentRef.current.id
    const filePath = await ensureImageDocumentPath()
    if (!filePath) return
    captureCurrent()
    setImageDocumentId(id)
  }, [documentRef, ensureImageDocumentPath, captureCurrent])
  const imageRequest = useCallback((): ImageLibraryRequest => {
    const current = sessionRef.current.documents.find((item) => item.id === imageDocumentId)
    if (!current?.path) throw new Error(t("文档已关闭，请重新打开图片管理。"))
    const markdown = readMarkdownFor(current.id)
    return { documentPath: current.path, markdown, relatedDocuments: sessionRef.current.documents.filter((item) => item.path && item.id !== current.id).map((item) => ({ path: item.path!, markdown: readMarkdownFor(item.id) })) }
  }, [imageDocumentId, sessionRef, readMarkdownFor])
  const mutateDocumentImages = useCallback(async (mutation: ImageLibraryMutation) => {
    const request = imageRequest(), id = imageDocumentId!
    const snapshot = readResourceSnapshot(id)
    if (!snapshot || snapshot.documentPath !== request.documentPath || snapshot.markdown !== request.markdown) throw new Error(t("文档在操作期间发生变化，资源副本已保留；请刷新后重试。"))
    const result = await window.ttypora.mutateImages({ ...request, mutation })
    const current = sessionRef.current.documents.find((item) => item.id === id)
    if (!current || !isSameResourceSnapshot(snapshot, readResourceSnapshot(id)) || readMarkdownFor(id) !== request.markdown) throw new Error(t("文档在操作期间发生变化，资源副本已保留；请刷新后重试。"))
    if (result.markdown !== request.markdown) {
      const bookmark = mountedDocumentId.current === id ? editorRef.current?.getBookmark() : undefined
      historyFor(id, current.markdown).boundary()
      recordChange(id, result.markdown)
      applyingHistory.current = true
      try {
        if (mountedDocumentId.current === id) replaceEditorMarkdown(id, result.markdown, bookmark)
        updateDocument(id, (item) => ({ ...item, markdown: result.markdown, revision: item.revision + (mountedDocumentId.current === id ? 0 : 1) }))
      } finally { applyingHistory.current = false }
      historyFor(id, result.markdown).boundary()
      void window.ttypora.updateDraft(draftFromDocument({ ...current, markdown: result.markdown })).catch((reason) => setError(String(reason)))
    }
    setMessage(result.notice)
    return result
  }, [imageRequest, imageDocumentId, sessionRef, readMarkdownFor, historyFor, recordChange, updateDocument, readResourceSnapshot, replaceEditorMarkdown])

  const openImageUploader = useCallback(async (initialImageIds?: string[]) => {
    const target = captureCurrent()
    const documentPath = await ensureImageDocumentPath(target.id)
    if (!documentPath) return
    const snapshot = readResourceSnapshot(target.id)
    if (!snapshot || snapshot.documentPath !== documentPath) throw new Error(t('文档已关闭或保存位置改变，请重新打开图片上传。'))
    const images = await window.ttypora.listImageUploadCandidates(resourceDocument(snapshot))
    const current = sessionRef.current.documents.find((item) => item.id === target.id)
    if (!current || !isSameResourceSnapshot(snapshot, readResourceSnapshot(target.id)) || readMarkdownFor(target.id) !== snapshot.markdown) throw new Error(t('文档在操作期间发生变化，请重新检查后应用。'))
    setImageDocumentId(null)
    setUploaderDocument({ id: target.id, path: documentPath, images, initialImageIds })
  }, [captureCurrent, ensureImageDocumentPath, readMarkdownFor, sessionRef, readResourceSnapshot])
  const uploaderRequest = useCallback(() => {
    const current = sessionRef.current.documents.find((item) => item.id === uploaderDocument?.id)
    if (!current?.path || current.path !== uploaderDocument?.path) throw new Error(t('文档已关闭或保存位置改变，请重新打开图片上传。'))
    return { documentPath: current.path, markdown: readMarkdownFor(current.id) }
  }, [uploaderDocument, sessionRef, readMarkdownFor])
  const applyUploadedImages = useCallback(async (taskId: string, selectedItemIds: string[], allowChangedOriginals: string[]) => {
    const request = uploaderRequest()
    const id = uploaderDocument!.id, snapshot = readResourceSnapshot(id)
    if (!snapshot || snapshot.documentPath !== request.documentPath || snapshot.markdown !== request.markdown) throw new Error(t('文档在操作期间发生变化，请重新检查后应用。'))
    const result = await window.ttypora.applyImageUploads({ ...request, taskId, selectedItemIds, allowChangedOriginals })
    if (!isSameResourceSnapshot(snapshot, readResourceSnapshot(id))) throw new Error(t('文档在操作期间发生变化，请重新检查后应用。'))
    applyDocumentRewrite(id, request.markdown, result.markdown)
    setMessage(localized('已应用 {count} 张图片的上传结果，本地原件保留', { count: result.appliedImages }))
    return result
  }, [uploaderRequest, uploaderDocument, applyDocumentRewrite, readResourceSnapshot])

  const saveAll = useCallback(async () => {
    captureCurrent()
    for (const item of [...sessionRef.current.documents]) {
      if (isDirty(item) && !(await saveCurrent(false, item.id))) { await switchDocument(item.id); return false }
    }
    setMessage('所有文档已保存')
    return true
  }, [captureCurrent, saveCurrent, sessionRef, switchDocument])
  const closeDocument = useCallback(async (id = documentRef.current.id) => {
    captureCurrent()
    const item = sessionRef.current.documents.find((entry) => entry.id === id)
    if (!item) return
    if (isDirty(item)) {
      const choice = await window.ttypora.confirmUnsaved(item.displayName)
      if (choice === 'cancel' || (choice === 'save' && !(await saveCurrent(false, id)))) return
    }
    await window.ttypora.clearDraft(id)
    if (documentRef.current.id === id) invalidateEditor()
    resourceSnapshots.current.forget(id)
    removeDocument(id)
  }, [captureCurrent, saveCurrent, removeDocument, sessionRef, documentRef])
  const preserveCurrentDraft = useCallback(async (): Promise<boolean> => {
    const current = captureCurrent()
    if (isDirty(current)) await window.ttypora.updateDraft(draftFromDocument(current))
    return true
  }, [captureCurrent])

  const handleNew = useCallback(async () => {
    const persisted = preserveCurrentDraft()
    invalidateEditor()
    setDocument(newDocument())
    setMessage('新建文档')
    setError(null)
    try { await persisted } catch (reason) { setError(localized("草稿保存失败：{value1}", { value1: String(reason) })) }
  }, [preserveCurrentDraft])

  const handleOpen = useCallback(async () => {
    if (!(await preserveCurrentDraft())) return
    try {
      const snapshot = await window.ttypora.openDocument()
      if (!snapshot) return
      showSnapshot(snapshot)
      setMessage(localized("已打开：{value1}", { value1: snapshot.displayName }))
      setError(null)
    } catch (reason) {
      setError(localized("打开文件失败：{value1}", { value1: String(reason) }))
    }
  }, [preserveCurrentDraft])

  const handleOpenWorkspace = useCallback(async () => {
    try {
      const snapshot = await window.ttypora.openWorkspace()
      if (!snapshot) return
      setWorkspace(snapshot)
      setSidebarMode('files')
      setMessage(localized("已打开文件夹：{value1}", { value1: snapshot.displayName }))
      setError(null)
    } catch (reason) {
      setError(localized("打开文件夹失败：{value1}", { value1: String(reason) }))
    }
  }, [])

  const refreshWorkspace = useCallback(async () => {
    try {
      const snapshot = await window.ttypora.refreshWorkspace()
      if (snapshot) setWorkspace(snapshot)
    } catch (reason) {
      setError(localized("刷新文件夹失败：{value1}", { value1: String(reason) }))
    }
  }, [])

  const openWorkspaceFile = useCallback(
    async (filePath: string, line?: number, column?: number) => {
      if (!(await preserveCurrentDraft())) return
      try {
        const snapshot = await window.ttypora.openWorkspaceDocument(filePath)
        if (line) { pendingLocation.current = { line, column }; setEditorMode('source') }
        showSnapshot(snapshot)
        setMessage(localized("已打开：{value1}", { value1: snapshot.displayName }))
        setError(null)
      } catch (reason) {
        setError(localized("打开工作区文件失败：{value1}", { value1: String(reason) }))
      }
    },
    [preserveCurrentDraft],
  )

  const manageWorkspace = async (request: WorkspaceMutation) => {
    captureCurrent()
    const affected = sessionRef.current.documents.find((item) => request.path && samePath(item.path, request.path))
    if (affected && isDirty(affected)) {
      const choice = await window.ttypora.confirmUnsaved(affected.displayName)
      if (choice === 'cancel' || (choice === 'save' && !(await saveCurrent(false, affected.id)))) throw new Error(t("已取消操作。"))
    }
    const result = await window.ttypora.mutateWorkspace(request)
    setWorkspace(result.workspace)
    if (affected) { await window.ttypora.clearDraft(affected.id); if (affected.id === documentRef.current.id) invalidateEditor(); resourceSnapshots.current.forget(affected.id); removeDocument(affected.id) }
    if (result.path && request.action !== 'create-directory') await openWorkspaceFile(result.path)
    setMessage('工作区已更新')
  }

  const openRecentPanel = useCallback(() => {
    void window.ttypora.listRecent().then((entries) => { setRecentEntries(entries); setShowRecent(true) }).catch((reason) => setError(String(reason)))
  }, [])

  const openLaunchTarget = useCallback(async () => {
    if (!(await preserveCurrentDraft())) return
    try {
      const result = await window.ttypora.takeLaunchTarget()
      if (result?.workspace) { setWorkspace(result.workspace); setSidebarMode('files') }
      if (result?.document) { showSnapshot(result.document) }
    } catch (reason) { setError(localized("打开启动文件失败：{value1}", { value1: String(reason) })) }
  }, [preserveCurrentDraft])

  const copyDocument = useCallback(async (format: 'markdown' | 'html' | 'text') => {
    try {
      const markdown = readMarkdownFor(documentRef.current.id)
      if (format === 'markdown') await window.ttypora.writeClipboard({ text: markdown })
      else {
        const html = await renderDocumentHtml(markdown, documentRef.current.displayName, { preferences: effectivePreferences, customCss: effectivePreferences.customCss })
        const parsed = new DOMParser().parseFromString(html, 'text/html')
        await window.ttypora.writeClipboard({ text: parsed.body.textContent ?? '', html: format === 'html' ? parsed.body.innerHTML : undefined })
      }
      setMessage('已复制文档')
    } catch (reason) { setError(localized("复制失败：{value1}", { value1: String(reason) })) }
  }, [effectivePreferences, documentRef, readMarkdownFor])

  const rememberCopySelection = useCallback(() => {
    const current = documentRef.current
    const snapshot = mountedDocumentId.current === current.id ? editorRef.current?.captureSelection() ?? null : null
    selectionCopyRef.current = snapshot ? { documentId: current.id, path: current.path, snapshot } : null
    return selectionCopyRef.current
  }, [documentRef])
  const openCommandPalette = useCallback(() => {
    const active = window.document.activeElement
    if (active instanceof HTMLElement && active.closest('.markdown-editor, .source-editor')) rememberCopySelection()
    // Pointer/Tab capture precedes a toolbar control taking focus. A foreign
    // input must never revive a selection from an unrelated document editor.
    else if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) selectionCopyRef.current = null
    setShowCommands(true)
  }, [rememberCopySelection])
  const copySelection = useCallback(async (format: 'markdown' | 'html' | 'text', fromPalette = false) => {
    const captured = fromPalette ? selectionCopyRef.current : rememberCopySelection()
    const request = ++selectionCopyRequest.current
    const copyLocale = selectionCopyLocale.current
    if (!captured) { setMessage('请先在文档中选择内容。'); return }
    const current = () => request === selectionCopyRequest.current && selectionCopyLocale.current === copyLocale && documentRef.current.id === captured.documentId
      && documentRef.current.path === captured.path && mountedDocumentId.current === captured.documentId && captured.snapshot.isCurrent()
    if (!current()) { setMessage('选区已失效，请重新选择。'); return }
    const fragment = captured.snapshot.result
    if (!fragment.ok) {
      setMessage({ empty: '请先在文档中选择内容。', 'unsupported-selection': '此选区暂不支持格式复制；表格矩形请使用 Ctrl+C。', 'unsupported-content': '选区包含暂不支持保真复制的内容。', 'size-limit': '选区超过剪贴板大小限制。' }[fragment.reason])
      return
    }
    try {
      // Read the complete raw resource context once, before any asynchronous
      // rendering. Do not call captureCurrent()/history.boundary() for copying.
      const resourceMarkdown = format === 'html' && fragment.value.kind !== 'literal' ? readMarkdownFor(captured.documentId) : ''
      let content: { text: string; html?: string }, warnings: string[] = []
      if (format === 'markdown') content = { text: fragment.value.markdown }
      else if (format === 'text' && fragment.value.kind !== 'source') content = { text: fragment.value.plain }
      else {
        const rendered = await renderSelectionFragment(fragment.value, effectivePreferences)
        if (!current()) return
        if (format === 'text') content = { text: rendered.text }
        else if (fragment.value.kind === 'literal') content = rendered
        else {
          const prepared = await window.ttypora.prepareSelectionClipboard({ html: rendered.html, markdown: resourceMarkdown, sourcePath: captured.path, suggestedName: 'selection' })
          if (!current()) return
          content = { text: rendered.text, html: clipboardBodyFragment(prepared.html) }; warnings = prepared.warnings
        }
      }
      if (!current()) return
      await window.ttypora.writeClipboard(content)
      if (current()) setMessage(warnings.length ? '已复制选区（部分图片为引用说明）' : '已复制选区')
    } catch (reason) { if (current()) setError(localized('复制失败：{value1}', { value1: String(reason) })) }
  }, [documentRef, rememberCopySelection, readMarkdownFor, effectivePreferences, localized])

  const openRecentItem = async (filePath: string) => {
    const entry = recentEntries.find((item) => item.path === filePath)
    if (entry?.kind === 'file' && !(await preserveCurrentDraft())) return
    try {
      const result = await window.ttypora.openRecent(filePath)
      if (result.workspace) { setWorkspace(result.workspace); setSidebarMode('files') }
      if (result.document) { showSnapshot(result.document) }
      setShowRecent(false)
    } catch (reason) { setError(localized("打开最近项目失败：{value1}", { value1: String(reason) })) }
  }

  useEffect(() => {
    if (!preferences.autoSave || !session.documents.some((item) => item.path && isDirty(item) && !item.conflict)) return
    const timer = window.setTimeout(() => {
      captureCurrent()
      void (async () => {
        for (const item of [...sessionRef.current.documents]) if (item.path && isDirty(item) && !item.conflict) await saveCurrent(false, item.id)
      })().catch((reason) => setError(String(reason)))
    }, preferences.autoSaveSeconds * 1000)
    return () => clearTimeout(timer)
  }, [preferences.autoSave, preferences.autoSaveSeconds, session.documents, saveCurrent, captureCurrent, sessionRef])

  const followLink = async (href: string) => {
    if (href.startsWith('#')) {
      const anchor = decodeURIComponent(href.slice(1))
      const element = window.document.getElementById(anchor)
      if (element) element.scrollIntoView({ block: 'center' })
      return
    }
    const current = documentRef.current
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      try { await window.ttypora.openLink(current.path, href) } catch (reason) { setError(String(reason)) }
      return
    }
    if (!current.path) { setError('请先保存文档，再打开链接。'); return }
    if (!/^https?:/i.test(href) && !(await preserveCurrentDraft())) return
    try {
      const result = await window.ttypora.openLink(current.path, href)
      if (result) { pendingLocation.current = { anchor: result.anchor }; showSnapshot(result.document) }
    } catch (reason) { setError(localized("打开链接失败：{value1}", { value1: String(reason) })) }
  }

  const toggleEditorMode = useCallback(() => {
    captureCurrent()
    invalidateEditor()
    setEditorMode((current) => (current === 'visual' ? 'source' : 'visual'))
  }, [captureCurrent, invalidateEditor])

  const toggleSplitMode = useCallback(() => {
    captureCurrent()
    if (editorMode !== 'source') invalidateEditor()
    setEditorMode((mode) => mode === 'split' ? 'visual' : 'split')
  }, [captureCurrent, editorMode, invalidateEditor])

  const toggleSidebar = useCallback(() => {
    setSidebarMode((current) => (current === 'hidden' ? 'outline' : 'hidden'))
  }, [])

  const revealHeading = useCallback((heading: MarkdownHeading, index: number) => {
    const current = documentRef.current, context = outlineContext.current
    if (!readyOutlineSnapshot || context.owner !== outlineOwner || mountedOutlineOwner.current !== outlineOwner
      || context.outline.pending || context.outline.snapshot !== readyOutlineSnapshot
      || context.optionsKey !== outlineOptionsKey || `${current.id}:${current.revision}` !== outlineOwner.documentKey
      || current.markdown !== readyOutlineSnapshot.markdown || readyOutlineSnapshot.headings[index] !== heading) return
    editorRef.current?.revealLocation({ headingIndex: index, line: heading.line })
  }, [readyOutlineSnapshot, outlineOwner, outlineOptionsKey, documentRef])

  useEffect(() => {
    return window.ttypora.onExternalFileChange((change) => {
      const current = sessionRef.current.documents.find((item) => samePath(item.path, change.path))
      if (!current) return
      const local = current.id === documentRef.current.id ? captureCurrent() : current
      if (isDirty(local) || change.kind === 'deleted' || !change.snapshot) {
        updateDocument(current.id, (item) => ({ ...item, conflict: change }))
        setMessage('检测到外部文件变化')
        return
      }
      if (current.id === documentRef.current.id) invalidateEditor()
      updateDocument(current.id, () => ({ ...fromSnapshot(change.snapshot!), id: current.id, revision: current.revision + 1 }))
      setMessage('已重新加载外部修改')
    })
  }, [captureCurrent, updateDocument, sessionRef, documentRef])

  const runHistory = useCallback((direction: 'undo' | 'redo', fromToolbar = false) => {
    const active = window.document.activeElement as HTMLElement | null
    const inEditor = active?.closest('.markdown-editor, .source-editor .cm-content')
    const nativeInput = active?.matches('input, textarea') && !active.matches('[data-html-source-editor], [data-math-source-editor], [data-code-meta]')
    if (!fromToolbar && (!inEditor || nativeInput)) { window.ttypora.performNativeEdit(direction); return }
    if (compositionDocument.current || mountedDocumentId.current !== documentRef.current.id) return
    const current = captureCurrent()
    const history = historyFor(current.id, current.markdown)
    const snapshot = direction === 'undo' ? history.undo() : history.redo()
    if (!snapshot) { setMessage(direction === 'undo' ? localized("没有可撤销的修改") : localized("没有可重做的修改")); return }
    applyingHistory.current = true
    try {
      replaceEditorMarkdown(current.id, snapshot.markdown, snapshot.bookmark)
      updateDocument(current.id, (item) => ({ ...item, markdown: snapshot.markdown }))
      if (snapshot.bookmark) editorRef.current?.restoreBookmark(snapshot.bookmark)
      else editorRef.current?.focus()
      setMessage(direction === 'undo' ? localized("已撤销") : localized("已重做"))
    } catch (reason) {
      if (direction === 'undo') history.redo(); else history.undo()
      setError(String(reason))
    } finally { applyingHistory.current = false }
  }, [captureCurrent, historyFor, updateDocument, documentRef, replaceEditorMarkdown])
  useEffect(() => {
    const listener = () => rememberPosition()
    window.document.addEventListener('selectionchange', listener)
    return () => window.document.removeEventListener('selectionchange', listener)
  }, [rememberPosition])
  useEffect(() => {
    const live = new Set(session.documents.map((item) => item.id))
    for (const id of histories.current.keys()) if (!live.has(id)) histories.current.delete(id)
  }, [session.documents])

  useEffect(() => {
    return window.ttypora.onAppCommand((command) => {
      if (command === 'layout-settings') setShowLayout(true)
      if (command === 'toggle-formatting-toolbar') setPreferences((current) => ({ ...current, showFormattingToolbar: !current.showFormattingToolbar }))
      if (command === 'reset-layout') setLayout(defaultWorkspaceLayout)
      if (command === 'font-size-up' || command === 'font-size-down' || command === 'font-size-reset') setPreferences((current) => ({ ...current, fontSize: command === 'font-size-reset' ? 17 : Math.min(32, Math.max(12, current.fontSize + (command === 'font-size-up' ? 1 : -1))) }))
      if (command === 'interface-zoom-in' || command === 'interface-zoom-out' || command === 'interface-zoom-reset') setPreferences((current) => ({ ...current, interfaceZoom: command === 'interface-zoom-reset' ? 100 : Math.min(150, Math.max(75, current.interfaceZoom + (command === 'interface-zoom-in' ? 10 : -10))) }))
      if (command === 'document-conversion') setShowConversion(true)
      if (command === 'theme-library') setShowThemes(true)
      if (command === 'image-library') void openImageLibrary().catch((reason) => setError(String(reason)))
      if (command === 'image-uploader') void openImageUploader().catch((reason) => setError(String(reason)))
      if (command === 'insert-media') void handleInsertMedia()
      if (command === 'undo-document') runHistory('undo')
      if (command === 'redo-document') runHistory('redo')
      if (command === 'command-palette') openCommandPalette()
      if (command === 'writing-goal') setShowGoal(true)
      if (command === 'toggle-split-mode') toggleSplitMode()
      if (command === 'close-document') void closeDocument().catch((reason) => setError(String(reason)))
      if (command === 'save-all') void saveAll()
      if (command === 'prepare-window-close') void flushDrafts().then(() => {
        const items = sessionRef.current.documents
        window.ttypora.setWindowDocumentStatus({ dirty: items.some(isDirty), draftId: documentRef.current.id, displayName: localizedDocumentName(locale, documentRef.current.displayName, documentRef.current.path), documents: items.map((item) => ({ dirty: isDirty(item), draftId: item.id, displayName: localizedDocumentName(locale, item.displayName, item.path) })) })
        window.ttypora.requestWindowClose()
      }).catch((reason) => { window.ttypora.requestWindowClose(true); setError(localized("退出前保存草稿失败：{value1}", { value1: String(reason) })) })
      if (command === 'request-draft-and-close') void flushDrafts().then(() => window.ttypora.confirmWindowClose()).catch((reason) => setError(String(reason)))
      if (command === 'open-launch') void openLaunchTarget()
      if (command === 'copy-markdown') void copyDocument('markdown')
      if (command === 'copy-html') void copyDocument('html')
      if (command === 'copy-text') void copyDocument('text')
      if (command === 'copy-selection-markdown') void copySelection('markdown')
      if (command === 'copy-selection-html') void copySelection('html')
      if (command === 'copy-selection-text') void copySelection('text')
      if (command.startsWith('format-')) editorRef.current?.format(command.slice(7) as FormatAction)
      if (command === 'new-document') void handleNew()
      if (command === 'open-document') void handleOpen()
      if (command === 'save-document') void saveCurrent()
      if (command === 'save-document-as') void saveAsCurrent()
      if (command === 'open-workspace') void handleOpenWorkspace()
      if (command === 'find-document') openSearchPanel('find')
      if (command === 'replace-document') openSearchPanel('replace')
      if (command === 'quick-open') openWorkspacePalette('quick-open')
      if (command === 'search-workspace') openWorkspacePalette('search')
      if (command === 'insert-image') void handleInsertImage()
      if (command === 'export-html') void handleExport('html')
      if (command === 'export-pdf') void handleExport('pdf')
      if (command === 'export-png') void handleExport('png')
      if (command === 'export-unstyled-html') void handleExport('unstyled-html')
      if (command === 'preferences') setShowPreferences(true)
      if (command === 'recent-items') openRecentPanel()
      if (command === 'toggle-sidebar') toggleSidebar()
      if (command === 'show-outline') setSidebarMode('outline')
      if (command === 'show-files') setSidebarMode('files')
      if (command === 'toggle-source-mode') toggleEditorMode()
      if (command === 'toggle-focus-mode') setFocusMode((current) => !current)
      if (command === 'toggle-typewriter-mode') {
        setTypewriterMode((current) => !current)
      }
      if (command === 'request-save-and-close') {
        void saveAll().then((saved) => {
          if (saved) window.ttypora.confirmWindowClose()
        })
      }
    })
  }, [
    locale,
    handleNew,
    handleOpen,
    handleOpenWorkspace,
    handleInsertImage,
    handleInsertMedia,
    openImageUploader,
    handleExport,
    openSearchPanel,
    openWorkspacePalette,
    saveAsCurrent,
    saveCurrent,
    toggleEditorMode,
    toggleSidebar,
    openRecentPanel,
    openLaunchTarget,
    copyDocument, copySelection, openCommandPalette, flushDrafts, closeDocument, saveAll, toggleSplitMode, sessionRef, documentRef, runHistory, openImageLibrary,
  ])

  const handleEditorChange = useCallback((id: string, markdown: string) => {
    recordChange(id, markdown)
    updateDocument(id, (current) =>
      current.markdown === markdown ? current : { ...current, markdown },
    )
    setMessage('正在编辑')
    if (typewriterMode) {
      window.requestAnimationFrame(() => editorRef.current?.centerSelection())
    }
  }, [typewriterMode, updateDocument, recordChange])

  const restoreDraft = useCallback((draftSummary: RecoveryDraft) => {
    void preserveCurrentDraft().then(() => window.ttypora
      .restoreDraft(draftSummary.id)
      ).then((draft) => {
        if (!draft) {
          setError('恢复草稿已不存在。')
          return
        }
        invalidateEditor()
        const alreadyOpen = sessionRef.current.documents.some((item) => item.id !== draft.id && draft.sourcePath && samePath(item.path, draft.sourcePath))
        setDocument({
          id: draft.id,
          path: alreadyOpen ? null : draft.sourcePath,
          displayName: alreadyOpen ? draft.displayName + '（恢复副本）' : draft.displayName,
          markdown: draft.markdown,
          savedMarkdown: draft.markdown,
          format: draft.format,
          version: alreadyOpen ? null : draft.expectedVersion,
          revision: 0,
          recovered: true,
        })
        setShowRecovery(false)
        setMessage('已恢复草稿，尚未写入原文件')
        setError(null)
      })
      .catch((reason) => {
        setError(localized("恢复草稿失败：{value1}", { value1: String(reason) }))
      })
  }, [preserveCurrentDraft, sessionRef])

  const discardRecoveryDraft = useCallback(async (draftId: string) => {
    await window.ttypora.clearDraft(draftId)
    setRecoveryDrafts((drafts) => {
      const remaining = drafts.filter((draft) => draft.id !== draftId)
      if (remaining.length === 0) setShowRecovery(false)
      return remaining
    })
  }, [])

  const saveRecoveryDraftAs = useCallback(
    async (draft: RecoveryDraft) => {
      const result = await window.ttypora.saveDocumentAs({
        markdown: draft.markdown,
        format: draft.format,
        suggestedName: suggestedMarkdownName(draft.displayName),
      })
      if (!result || result.status !== 'saved') {
        if (result?.status === 'error') setError(result.message)
        return
      }
      await discardRecoveryDraft(draft.id)
      setMessage(localized("恢复草稿已另存为：{value1}", { value1: result.snapshot.displayName }))
    },
    [discardRecoveryDraft],
  )

  const reloadConflict = useCallback(async () => {
    if (!conflict?.snapshot) return
    const currentId = documentRef.current.id
    await window.ttypora.clearDraft(currentId)
    invalidateEditor()
    updateDocument(currentId, (current) => ({ ...fromSnapshot(conflict.snapshot!), id: currentId, revision: current.revision + 1 }))
    setConflict(null)
    setMessage('已放弃本地修改并重新加载')
  }, [conflict])

  const overwriteConflict = useCallback(async () => {
    const saved = await saveCurrent(true)
    if (saved) setConflict(null)
  }, [saveCurrent])

  const saveConflictAs = useCallback(async () => {
    const saved = await saveAsCurrent()
    if (saved) setConflict(null)
  }, [saveAsCurrent])

  const cycleTheme = useCallback(() => {
    setThemeMode((current) =>
      current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system',
    )
  }, [])

  const writingStats = useMemo(
    () => computeWritingStatistics(document.markdown),
    [document.markdown],
  )
  const activeHistory = historyFor(document.id, document.markdown)
  const goal = useWritingGoal(document.path?.toLocaleLowerCase() ?? document.id, document.id)
  const setMode = (mode: EditorMode) => { if (mode !== editorMode) { captureCurrent(); if ((mode === 'visual') !== (editorMode === 'visual')) invalidateEditor(); setEditorMode(mode) } }
  const paletteCommands: PaletteCommand[] = [
    { id: 'layout', title: t('布局与尺寸'), group: t('视图'), icon: 'settings', keywords: 'resize zoom width layout', run: () => setShowLayout(true) },
    { id: 'formatting-toolbar', title: t('切换格式工具栏'), group: t('视图'), icon: 'code', run: () => setPreferences((current) => ({ ...current, showFormattingToolbar: !current.showFormattingToolbar })) },
    { id: 'reset-layout', title: t('恢复面板默认尺寸'), group: t('视图'), icon: 'split', run: () => setLayout(defaultWorkspaceLayout) },
    ...(['up', 'down', 'reset'] as const).map((direction): PaletteCommand => ({ id: 'font-size-' + direction, title: t({ up: '增大正文字号', down: '减小正文字号', reset: '恢复正文字号' }[direction]), group: t('视图'), icon: 'code', shortcut: `Ctrl Alt ${direction === 'up' ? '+' : direction === 'down' ? '-' : '0'}`, run: () => setPreferences((current) => ({ ...current, fontSize: direction === 'reset' ? 17 : Math.min(32, Math.max(12, current.fontSize + (direction === 'up' ? 1 : -1))) })) })),
    { id: 'undo', title: t("撤销"), group: t("编辑"), icon: 'undo', shortcut: 'Ctrl Z', run: () => runHistory('undo', true) },
    { id: 'redo', title: t("重做"), group: t("编辑"), icon: 'redo', shortcut: 'Ctrl Y', run: () => runHistory('redo', true) },
    { id: 'new', title: t("新建文档"), group: t("文件"), icon: 'plus', shortcut: 'Ctrl N', keywords: 'new', run: () => void handleNew() },
    { id: 'open', title: t("打开文档"), group: t("文件"), icon: 'file', shortcut: 'Ctrl O', keywords: 'open', run: () => void handleOpen() },
    { id: 'folder', title: t("打开文件夹"), group: t("文件"), icon: 'folder', run: () => void handleOpenWorkspace() },
    { id: 'save', title: t("保存文档"), group: t("文件"), icon: 'save', shortcut: 'Ctrl S', run: () => void saveCurrent() },
    { id: 'save-all', title: t("保存全部文档"), group: t("文件"), icon: 'save', shortcut: 'Ctrl Alt S', run: () => void saveAll() },
    { id: 'save-as', title: t("另存为"), group: t("文件"), icon: 'file', shortcut: 'Ctrl Shift S', run: () => void saveAsCurrent() },
    { id: 'close', title: t("关闭当前文档"), group: t("文件"), icon: 'close', shortcut: 'Ctrl W', run: () => void closeDocument().catch((reason) => setError(String(reason))) },
    { id: 'recent', title: t("最近项目"), group: t("文件"), icon: 'clock', run: openRecentPanel },
    { id: 'recovery', title: t("查看恢复草稿"), group: t("文件"), icon: 'clock', run: () => { void window.ttypora.listRecoveryDrafts().then((drafts) => { setRecoveryDrafts(drafts); setShowRecovery(true) }) } },
    { id: 'visual', title: t("所见即所得模式"), group: t("视图"), icon: 'eye', run: () => setMode('visual') },
    { id: 'source', title: t("Markdown 源码模式"), group: t("视图"), icon: 'code', shortcut: 'Ctrl /', run: () => setMode('source') },
    { id: 'split', title: t("源码与预览并排"), group: t("视图"), icon: 'split', shortcut: 'Ctrl Shift V', keywords: 'split preview', run: () => setMode('split') },
    { id: 'outline', title: t("显示文档大纲"), group: t("视图"), icon: 'outline', run: () => setSidebarMode('outline') },
    { id: 'files', title: t("显示文件侧栏"), group: t("视图"), icon: 'folder', run: () => setSidebarMode('files') },
    { id: 'focus', title: t("切换专注模式"), group: t("写作"), icon: 'eye', shortcut: 'F8', run: () => setFocusMode((current) => !current) },
    { id: 'typewriter', title: t("切换打字机模式"), group: t("写作"), icon: 'code', shortcut: 'F9', run: () => setTypewriterMode((current) => !current) },
    { id: 'goal', title: t("设定写作目标"), group: t("写作"), icon: 'target', run: () => setShowGoal(true) },
    { id: 'find', title: t("查找文档"), group: t("搜索"), icon: 'search', shortcut: 'Ctrl F', run: () => openSearchPanel('find') },
    { id: 'replace', title: t("查找与替换"), group: t("搜索"), icon: 'search', shortcut: 'Ctrl H', run: () => openSearchPanel('replace') },
    { id: 'quick-open', title: t("快速打开文件"), group: t("搜索"), icon: 'file', shortcut: 'Ctrl P', run: () => openWorkspacePalette('quick-open') },
    { id: 'search-workspace', title: t("搜索文件夹内容"), group: t("搜索"), icon: 'search', shortcut: 'Ctrl Shift F', run: () => openWorkspacePalette('search') },
    { id: 'image', title: t("插入本地图片"), group: t("编辑"), icon: 'image', run: () => void handleInsertImage() },
    { id: 'media', title: t('插入音视频'), group: t('编辑'), icon: 'file', keywords: 'audio video mp3 mp4 wav webm', run: () => void handleInsertMedia() },
    { id: 'image-uploader', title: t('上传文档图片'), group: t('编辑'), icon: 'image', keywords: 'PicGo PicList upload', run: () => void openImageUploader().catch((reason) => setError(String(reason))) },
    { id: 'image-library', title: t("管理文档图片"), group: t("编辑"), icon: 'image', keywords: t("assets resources 图片资源"), run: () => void openImageLibrary().catch((reason) => setError(String(reason))) },
    { id: 'document-conversion', title: t("文档转换 / 导入"), group: t("导出"), icon: 'export', keywords: t("pandoc word docx epub latex odt 转换 导入"), run: () => setShowConversion(true) },
    ...(['html', 'pdf', 'png', 'unstyled-html'] as const).map((format): PaletteCommand => ({ id: format, title: t("导出 ") + ({ html: 'HTML', pdf: 'PDF', png: t("PNG 图片"), 'unstyled-html': t("无样式 HTML") })[format], group: t("导出"), icon: 'export', run: () => void handleExport(format) })),
    ...(['markdown', 'html', 'text'] as const).map((format): PaletteCommand => ({ id: 'copy-' + format, title: t("复制文档为 ") + ({ markdown: 'Markdown', html: 'HTML', text: t("纯文本") })[format], group: t("编辑"), icon: 'file', run: () => void copyDocument(format) })),
    ...(['markdown', 'html', 'text'] as const).map((format): PaletteCommand => ({ id: 'copy-selection-' + format, title: t(({ markdown: '复制选区为 Markdown', html: '复制选区为 HTML', text: '复制选区为纯文本' })[format]), group: t('编辑'), icon: 'file', keywords: 'selection copy', run: () => void copySelection(format, true) })),
    ...Object.entries(formatLabels).map(([action, label]): PaletteCommand => ({ id: 'format-' + action, title: t(label), group: t("格式"), icon: 'code', run: () => editorRef.current?.format(action as FormatAction) })),
    { id: 'theme', title: t("切换明亮 / 暗色主题"), group: t("设置"), icon: 'sun', run: cycleTheme },
    { id: 'theme-library', title: t("主题库"), group: t("设置"), icon: 'sun', keywords: t("themes CSS 外观"), run: () => setShowThemes(true) },
    { id: 'preferences', title: t("偏好设置"), group: t("设置"), icon: 'settings', shortcut: 'Ctrl ,', run: () => setShowPreferences(true) },
  ]
  const themeLabel =
    themeMode === 'system' ? t("跟随系统") : themeMode === 'light' ? t("明亮") : t("暗色")

  return (
    <main
      className={`app-shell${focusMode ? ' app-shell--focus' : ''}${typewriterMode ? ' app-shell--typewriter' : ''}`}
      onKeyDownCapture={(event) => { if (event.key === 'Tab' && (event.target as HTMLElement).closest('.markdown-editor, .source-editor')) rememberCopySelection() }}
    >
      <header className="toolbar workspace-header">
        <div className="toolbar__group">
          <button className="header-icon" aria-label={t("切换侧栏")} title={t("切换侧栏")} aria-pressed={sidebarMode !== 'hidden'} onClick={toggleSidebar}><Icon name="outline" /></button>
          <button className="header-icon" aria-label={t("文件侧栏")} title={t("文件侧栏")} aria-pressed={sidebarMode === 'files'} onClick={() => setSidebarMode((mode) => mode === 'files' ? 'hidden' : 'files')}><Icon name="folder" /></button>
          <span className="workspace-brand" title={APP_TAGLINE}><strong>{APP_NAME}</strong></span>
        </div>
        <div className="document-title" title={document.path ?? t("尚未保存")}><span className={dirty ? 'dirty-dot dirty-dot--active' : 'dirty-dot'} /><span>{documentName}</span></div>
        <div className="toolbar__group toolbar__group--end">
          <div className="view-switcher" aria-label={t("编辑视图")}>
            <button aria-pressed={editorMode === 'visual'} onClick={() => setMode('visual')} title={t("所见即所得")} aria-label={t("所见即所得")}><Icon name="eye" size={15} /><span>{t("写作")}</span></button>
            <button aria-pressed={editorMode === 'source'} onClick={() => setMode('source')} title={t("切换源码模式")} aria-label={t("源码模式")}><Icon name="code" size={15} /><span>{t("源码")}</span></button>
            <button aria-pressed={editorMode === 'split'} onClick={() => setMode('split')} title={t("源码与预览并排")} aria-label={t("并排预览")}><Icon name="split" size={15} /><span>{t("并排")}</span></button>
          </div>
          <button className="command-trigger header-icon" onPointerDown={rememberCopySelection} onClick={openCommandPalette} type="button" title={t("命令面板（Ctrl+K）")} aria-label={t("命令面板")}><Icon name="search" size={17} /></button>
          <button className="header-icon" onClick={() => setShowLayout(true)} title={t('布局与尺寸')} aria-label={t('布局与尺寸')}><Icon name="settings" size={17} /></button>
          <button onClick={() => void saveCurrent()} type="button" className="header-icon save-button" title={t('保存文档')} aria-label={t('保存')}><Icon name={dirty ? 'save' : 'check'} size={17} /></button>
        </div>
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button aria-label={t("关闭错误")} onClick={() => setError(null)} type="button">
            ×
          </button>
        </div>
      ) : null}

      <div ref={workspaceElement} className={`workspace-layout${sidebarOverlay ? ' workspace-layout--overlay' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
        {sidebarOverlay && sidebarMode !== 'hidden' ? <button className="sidebar-backdrop" aria-label={t('关闭侧栏')} onClick={() => setSidebarMode('hidden')} /> : null}
        {sidebarMode !== 'hidden' ? (
          <div className="sidebar-panel">
          <Sidebar
            activePath={document.path}
            outlineDocumentId={document.id}
            outlineControlState={outlineControlStore.get(document.id)}
            onOutlineControlAction={handleOutlineControlAction}
            headings={headings}
            outlinePending={outline.pending}
            outlineError={outline.error}
            activeHeadingIndex={activeHeadingIndex}
            mode={sidebarMode}
            onClose={() => setSidebarMode('hidden')}
            onHeadingClick={revealHeading}
            onModeChange={setSidebarMode}
            onOpenFile={(filePath) => void openWorkspaceFile(filePath)}
            onOpenWorkspace={() => void handleOpenWorkspace()}
            onRefreshWorkspace={() => void refreshWorkspace()}
            onManage={(filePath) => setFileActions({ path: filePath })}
            workspace={workspace}
          />
          <ResizeHandle label={t('调整侧栏宽度')} value={sidebarWidth} min={SIDEBAR_MIN} max={sidebarMaximum(workspaceSize.width || window.innerWidth)} resetValue={240} onChange={(sidebarWidth) => setLayout((current) => ({ ...current, sidebarWidth }))} />
          </div>
        ) : null}
        <div className="workbench">
          <DocumentTabs session={session} onActivate={(id) => void switchDocument(id).catch((reason) => setError(String(reason)))} onClose={(id) => void closeDocument(id).catch((reason) => setError(String(reason)))} onNew={() => void handleNew()} />
          {preferences.showFormattingToolbar ? <div className="editor-toolbar">

            <div className="history-tools">
              <button title={t("撤销（Ctrl+Z）")} aria-label={t("撤销")} disabled={!activeHistory.canUndo} onClick={() => runHistory('undo', true)}><Icon name="undo" size={16} /></button>
              <button title={t("重做（Ctrl+Y）")} aria-label={t("重做")} disabled={!activeHistory.canRedo} onClick={() => runHistory('redo', true)}><Icon name="redo" size={16} /></button>
            </div>
            <div className="editing-tools">
              <button title={t("粗体（Ctrl+B）")} aria-label={t("粗体")} onClick={() => editorRef.current?.format('bold')}><b>B</b></button>
              <button title={t("斜体（Ctrl+I）")} aria-label={t("斜体")} onClick={() => editorRef.current?.format('italic')}><i>I</i></button>
              <select aria-label={t("插入格式")} value="" onChange={(event) => editorRef.current?.format(event.target.value as FormatAction)}><option value="" disabled>{t("格式")}</option>{Object.entries(formatLabels).map(([value, label]) => <option value={value} key={value}>{t(label)}</option>)}</select>
              <button title={t("插入图片")} aria-label={t("图片")} onClick={() => void handleInsertImage()}><Icon name="image" size={16} /></button>
            </div>
          </div> : null}
        {editorMode === 'visual' && editorReady ? <TableTools context={tableContext} onAction={(action) => editorRef.current?.tableAction?.(action)} /> : null}
        <section className="editor-surface" onCompositionStartCapture={() => { rememberPosition(); historyFor(documentRef.current.id, documentRef.current.markdown).boundary(); compositionDocument.current = documentRef.current.id }} onCompositionEndCapture={() => { window.setTimeout(() => { compositionDocument.current = null; historyFor(documentRef.current.id, documentRef.current.markdown).boundary() }, 0) }} onKeyDownCapture={(event) => {
          if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return
          const target = event.target as HTMLElement
          if (target.matches('input,textarea') && !target.matches('[data-html-source-editor], [data-math-source-editor], [data-code-meta]')) return
          if (!target.closest('.markdown-editor, .source-editor .cm-content')) return
          if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopPropagation(); runHistory(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo', true) }
        }} onClickCapture={(event) => {
          const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
          if (!anchor) return
          const href = anchor.getAttribute('href')
          if (!href) return
          event.preventDefault(); event.stopPropagation(); void followLink(href)
        }}>
          {searchPanelMode !== 'hidden' ? (
            <SearchPanel
              caseSensitive={searchCaseSensitive}
              key={`${searchPanelMode}:${searchPanelNonce}`}
              mode={searchPanelMode}
              onCaseSensitiveChange={setSearchCaseSensitive}
              onClose={closeSearchPanel}
              onFindNext={() => {
                setSearchSummary(editorRef.current?.findNext() ?? searchSummary)
              }}
              onFindPrevious={() => {
                setSearchSummary(editorRef.current?.findPrevious() ?? searchSummary)
              }}
              onQueryChange={setSearchQuery}
              onRegexpChange={setSearchRegexp}
              onReplaceAll={() => {
                setSearchSummary(editorRef.current?.replaceAll() ?? searchSummary)
              }}
              onReplaceNext={() => {
                setSearchSummary(editorRef.current?.replaceNext() ?? searchSummary)
              }}
              onReplacementChange={setSearchReplacement}
              onWholeWordChange={setSearchWholeWord}
              query={searchQuery}
              regexp={searchRegexp}
              replacement={searchReplacement}
              summary={searchSummary}
              wholeWord={searchWholeWord}
            />
          ) : null}
          {!editorReady ? <div className="editor-loading">{t("正在准备编辑器…")}</div> : null}
          <div ref={panesElement} className={`editor-panes${editorMode === 'split' ? ' editor-panes--split' : ''}${editorMode === 'split' && splitStacked ? ' editor-panes--stacked' : ''}`} style={editorMode === 'split' ? { [splitStacked ? 'gridTemplateRows' : 'gridTemplateColumns']: `minmax(0, ${layout.splitRatio}fr) 6px minmax(0, ${100 - layout.splitRatio}fr)` } : undefined}>
          <div className="primary-editor-pane" onPasteCapture={(event) => {
            separateClipboardHistory(event.nativeEvent, event.target)
            const files = [...event.clipboardData.files]
            if (!files.some((file) => mediaFormat(file.name, file.type))) return
            event.preventDefault(); event.stopPropagation(); finishClipboardHistory(event.nativeEvent, true); void receiveMediaFiles(files)
          }} onPaste={(event) => finishClipboardHistory(event.nativeEvent)} onCutCapture={(event) => separateClipboardHistory(event.nativeEvent, event.target)} onCut={(event) => finishClipboardHistory(event.nativeEvent)} onInput={(event) => finishClipboardInput(event.target)} onDragOverCapture={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) event.preventDefault() }} onDropCapture={(event) => {
            const files = [...event.dataTransfer.files]
            if (!files.some((file) => mediaFormat(file.name, file.type))) return
            event.preventDefault(); event.stopPropagation(); void receiveMediaFiles(files, { x: event.clientX, y: event.clientY })
          }}>
          {editorMode === 'split' ? <header className="pane-header"><span><Icon name="code" size={14} />{t("Markdown 源码")}</span><small>{t("可编辑")}</small></header> : null}
          {editorMode === 'visual' ? (
            <MarkdownEditor
              resourceRevision={resourceRevision}
              onClipboardTransaction={() => beginClipboardTransaction(document.id)}
              onClipboardRejected={(reason) => setError(t(reason === 'size-limit' ? '表格剪贴板内容超过支持的大小。' : reason === 'invalid-tsv' || reason === 'irregular-grid' ? '表格剪贴板文本的引号或行列结构不完整。' : '此表格剪贴板结构暂不支持，文档内容保持原样。'))}
              onTableContextChange={setTableContext}
              onActiveHeadingChange={onVisualActiveHeadingChange}
              preferences={preferences}
              onLoading={() => { if (outlineContext.current.owner === outlineOwner || mountedOutlineOwner.current === outlineOwner) invalidateEditor() }}
              documentKey={`${outlineDocumentKey}:visual`}
              callbackOwnerKey={outlineOwner.editorKey}
              initialMarkdown={document.markdown}
              onChange={(markdown) => handleEditorChange(document.id, markdown)}
              onError={(reason) => {
                if (outlineContext.current.owner !== outlineOwner) return
                setEditorReady(true)
                setError(localized("编辑器初始化失败：{value1}", { value1: String(reason) }))
              }}
              onReady={() => {
                if (outlineContext.current.owner !== outlineOwner) return
                mountedDocumentId.current = document.id
                mountedOutlineOwner.current = outlineOwner
                setEditorReady(true)
                if (!restorePosition()) editorRef.current?.focus()
              }}
              onResolveImageUrl={resolveLocalImageUrl}
              onResolveMediaUrl={resolveLocalMediaUrl}
              onUploadImage={uploadLocalImage}
              ref={editorRef}
            />
          ) : (
            <SourceEditor
              preferences={preferences}
              documentKey={outlineOwner.editorKey}
              headingLines={sourceHeadingLines}
              onActiveHeadingChange={onSourceActiveHeadingChange}
              initialMarkdown={document.markdown}
              onChange={(markdown) => handleEditorChange(document.id, markdown)}
              onError={(reason) => {
                if (outlineContext.current.owner !== outlineOwner) return
                setEditorReady(true)
                setError(localized("源码编辑器初始化失败：{value1}", { value1: String(reason) }))
              }}
              onReady={() => { if (outlineContext.current.owner !== outlineOwner) return; mountedDocumentId.current = document.id; mountedOutlineOwner.current = outlineOwner; setEditorReady(true); restorePosition() }}
              ref={editorRef}
            />
          )}
          </div>
          {editorMode === 'split' ? <ResizeHandle label={t('调整源码与预览比例')} orientation={splitStacked ? 'horizontal' : 'vertical'} value={layout.splitRatio} min={25} max={75} resetValue={50} step={1} pixelsPerUnit={Math.max(1, (splitStacked ? panesSize.height : panesSize.width) - 6) / 100} onChange={(splitRatio) => setLayout((current) => ({ ...current, splitRatio }))} /> : null}
          {editorMode === 'split' ? <LivePreview markdown={document.markdown} title={document.displayName} sourcePath={document.path} preferences={effectivePreferences} onLink={(href) => void followLink(href)} /> : null}
          </div>
        </section>
        </div>
      </div>

      <footer className="statusbar">
        <span className="statusbar__path" title={document.path ?? t("未保存文档")}>
          {document.path ?? t("未保存文档")}
        </span>
        <div className="statusbar__modes">
          <button
            className={focusMode ? 'statusbar__button statusbar__button--active' : 'statusbar__button'}
            onClick={() => setFocusMode((current) => !current)}
            title={t("专注模式（F8）")}
            type="button"
          >
            {t("专注")}
          </button>
          <button
            className={typewriterMode ? 'statusbar__button statusbar__button--active' : 'statusbar__button'}
            onClick={() => setTypewriterMode((current) => !current)}
            title={t("打字机模式（F9）")}
            type="button"
          >
            {t("打字机")}
          </button>
          <span>{editorMode === 'visual' ? t("所见即所得") : t("Markdown 源码")}</span>
        </div>
        <span className="statusbar__message" role="status">{message}</span>
        {goal.target ? <button className={`goal-status${goal.target && writingStats.charactersWithoutSpaces >= goal.target ? ' goal-status--complete' : ''}`} title={t("写作目标")} onClick={() => setShowGoal(true)}><Icon name="target" size={14} /><span>{goal.target ? `${writingStats.charactersWithoutSpaces.toLocaleString(locale)} / ${goal.target.toLocaleString(locale)}` : t("设定目标")}</span>{goal.target ? <span className="goal-mini-track"><span style={{ width: `${Math.min(100, writingStats.charactersWithoutSpaces / goal.target * 100)}%` }} /></span> : null}</button> : null}
        <button
          className="statusbar__button"
          onClick={() => {
            const selection = editorRef.current?.getSelectionText() ?? ''
            setSelectionStats(selection ? computeWritingStatistics(selection) : null)
            setShowWritingStats((current) => !current)
          }}
          title={t("查看字数、段落和阅读时间")}
          type="button"
        >
          {t('{words} 词 · {characters} 字符', { words: writingStats.words.toLocaleString(locale), characters: writingStats.charactersWithoutSpaces.toLocaleString(locale) })}
        </button>
        <button className="statusbar__button dimensions-trigger" onClick={() => setShowLayout(true)} title={t('布局与尺寸')}>{preferences.fontSize}px · {preferences.interfaceZoom}%</button>
      </footer>

      {showCommands ? <CommandPalette commands={paletteCommands} onClose={() => setShowCommands(false)} /> : null}
      {showGoal ? <WritingGoal target={goal.target} words={writingStats.charactersWithoutSpaces} onChange={goal.setTarget} onClose={() => setShowGoal(false)} /> : null}

      {showWritingStats ? (
        <WritingStatsPanel
          documentStats={writingStats}
          onClose={() => setShowWritingStats(false)}
          selectionStats={selectionStats}
        />
      ) : null}

      {workspacePaletteMode !== 'hidden' ? (
        <WorkspacePalette
          caseSensitive={searchCaseSensitive}
          mode={workspacePaletteMode}
          onCaseSensitiveChange={setSearchCaseSensitive}
          onClose={() => setWorkspacePaletteMode('hidden')}
          onOpenFile={(filePath, line, column) => {
            setWorkspacePaletteMode('hidden')
            void openWorkspaceFile(filePath, line, column)
          }}
          onOpenWorkspace={() => void handleOpenWorkspace()}
          onQueryChange={setWorkspaceQuery}
          onRegexpChange={setSearchRegexp}
          onWholeWordChange={setSearchWholeWord}
          query={workspaceQuery}
          regexp={searchRegexp}
          searchError={workspaceSearchError}
          searchLoading={workspaceSearchLoading}
          searchResult={workspaceSearchResult}
          wholeWord={searchWholeWord}
          workspace={workspace}
        />
      ) : null}

      <style>{documentTypographyCss('.markdown-editor .milkdown .ProseMirror')}</style>
      <style>{themeLibrary.editorCss(effectiveAppearance, preferences.customCss)}</style>
      {showConversion ? <ConversionDialog documentName={documentName} getRequest={() => { const current = captureCurrent(); return { markdown: current.markdown, sourcePath: current.path, suggestedName: current.displayName, extensions: preferences.markdownExtensions, excludedPaths: sessionRef.current.documents.flatMap((item) => item.path ? [item.path] : []) } }} onImported={showSnapshot} onClose={() => setShowConversion(false)} /> : null}
      {showThemes ? <ThemeLibrary library={themeLibrary} appearance={effectiveAppearance} onClose={() => setShowThemes(false)} /> : null}
      {imageDocumentId && session.documents.some((item) => item.id === imageDocumentId) ? <ImageLibrary key={imageDocumentId} documentName={localizedDocumentName(locale, session.documents.find((item) => item.id === imageDocumentId)!.displayName, session.documents.find((item) => item.id === imageDocumentId)!.path)} onRefresh={() => window.ttypora.listImages(imageRequest())} onMutate={mutateDocumentImages} onUpload={(ids) => void openImageUploader(ids).catch((reason) => setError(String(reason)))} onClose={() => setImageDocumentId(null)} /> : null}
      {uploaderDocument && session.documents.some((item) => item.id === uploaderDocument.id) ? <ImageUploader
        key={uploaderDocument.id} documentName={localizedDocumentName(locale, session.documents.find((item) => item.id === uploaderDocument.id)!.displayName, uploaderDocument.path)} documentPath={uploaderDocument.path}
        images={uploaderDocument.images} initialImageIds={uploaderDocument.initialImageIds}
        onReadSettings={window.ttypora.imageUploaderSettings} onChooseExecutable={window.ttypora.chooseImageUploaderExecutable} onResetExecutable={window.ttypora.resetImageUploaderExecutable} onSaveSettings={window.ttypora.configureImageUploader}
        onUpload={(images) => window.ttypora.uploadImages({ ...uploaderRequest(), images })} onCancel={window.ttypora.cancelImageUploads} onGetTask={window.ttypora.imageUploadTask} onProgress={window.ttypora.onImageUploadProgress}
        onApply={applyUploadedImages} onClose={() => setUploaderDocument(null)}
      /> : null}
      {showLayout ? <LayoutPanel value={preferences} onChange={setPreferences} onResetLayout={() => setLayout(defaultWorkspaceLayout)} onClose={() => setShowLayout(false)} /> : null}
      {showPreferences ? <PreferencesPanel value={preferences} onChange={setPreferences} onClose={() => setShowPreferences(false)} /> : null}
      {fileActions && workspace ? <FileActionsPanel filePath={fileActions.path} rootPath={workspace.rootPath} onRun={manageWorkspace} onClose={() => setFileActions(null)} /> : null}
      {showRecent ? <RecentPanel entries={recentEntries} onOpen={(filePath) => void openRecentItem(filePath)} onPin={(filePath) => { void window.ttypora.pinRecent(filePath).then(setRecentEntries).catch((reason) => setError(String(reason))) }} onClear={() => { void window.ttypora.clearRecent().then(setRecentEntries).catch((reason) => setError(String(reason))) }} onClose={() => setShowRecent(false)} /> : null}
      {showRecovery ? (
        <Modal
          onClose={() => setShowRecovery(false)}
          title={t("发现恢复草稿")}
        >
          <p className="modal__intro">
            {t("这些内容来自上次未完成的编辑。草稿不会自动覆盖原文件。")}
          </p>
          <div className="draft-list">
            {recoveryDrafts.map((draft) => (
              <article className="draft-card" key={draft.id}>
                <div>
                  <strong>{localizedDocumentName(locale, draft.displayName, draft.sourcePath)}</strong>
                  <small>{new Date(draft.updatedAt).toLocaleString(locale)}</small>
                  <small>{draft.sourcePath ?? t("未命名文档")}</small>
                </div>
                <div className="draft-card__actions">
                  <button onClick={() => restoreDraft(draft)} type="button">
                    {t("恢复")}
                  </button>
                  <button onClick={() => void saveRecoveryDraftAs(draft)} type="button">
                    {t("另存为")}
                  </button>
                  <button
                    className="button--danger"
                    onClick={() => void discardRecoveryDraft(draft.id)}
                    type="button"
                  >
                    {t("丢弃")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </Modal>
      ) : null}

      {conflict ? (
        <Modal title={t("文件发生外部变化")}>
          <p>
            {conflict.kind === 'deleted'
              ? t("磁盘上的原文件已被删除。")
              : t("磁盘上的文件已被其他程序修改。")}
          </p>
          <p>{t("为避免覆盖其他修改，请选择处理方式。")}</p>
          <div className="modal-actions">
            {conflict.snapshot ? (
              <button onClick={() => void reloadConflict()} type="button">
                {t("放弃本地修改并重新加载")}
              </button>
            ) : null}
            <button className="button--primary" onClick={() => void saveConflictAs()} type="button">
              {t("另存为")}
            </button>
            <button className="button--danger" onClick={() => void overwriteConflict()} type="button">
              {t("覆盖外部版本")}
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  )
}
