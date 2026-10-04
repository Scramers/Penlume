// v0.10 staging baseline: src/renderer/editor/SourceEditor.tsx
// SHA256: 44D50AF6BEBA839D8AE4FB048745AFA6A3239435571D5D7C26161D231C58F3C0
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  SearchQuery as CodeMirrorSearchQuery,
  findNext as findNextCodeMirror,
  findPrevious as findPreviousCodeMirror,
  highlightSelectionMatches,
  replaceAll as replaceAllCodeMirror,
  replaceNext as replaceNextCodeMirror,
  search as searchExtension,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import type { Preferences } from '../../shared/preferences'
import { defaultPreferences } from '../../shared/preferences'
import { useLocalization } from '../localization'
import { activeHeadingIndexAtPosition } from '../active-heading'
import { formatMarkdown } from '../../shared/formatting'
import { completeEmoji } from '../../shared/emoji-shortcodes'
import { isMarkdownLiteralPosition } from './markdown-position'
import { sourceWritingAids } from './writing-aids'
import { restoreSourceBookmark, sourceBookmarkField, sourceEditorBookmark } from './source-bookmark'
import { newCodeBlockMarkdown } from '../../shared/writing-aids'
import { fromExactSelection } from './selection-fragment'
import {
  crosshairCursor,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { MarkdownEditorHandle } from './MarkdownEditor'
import type {
  EditorImage,
  EditorSearchQuery,
  EditorSearchSummary,
} from './editor-adapter'

interface SourceEditorProps {
  preferences?: Preferences
  documentKey: string
  initialMarkdown: string
  onChange: (markdown: string) => void
  onError?: (reason: unknown) => void
  onReady?: () => void
  /** Heading starts in document order, using one-based source line numbers. */
  headingLines?: readonly number[]
  onActiveHeadingChange?: (index: number | null) => void
}

export function emojiCompletionSource(context: CompletionContext) {
  for (let node = syntaxTree(context.state).resolveInner(context.pos, -1); node; node = node.parent!) {
    if (/^(?:FencedCode|CodeBlock|InlineCode|CodeText|URL|Autolink|HTMLBlock|HTMLTag|ProcessingInstruction)$/.test(node.name)) return null
    if (!node.parent) break
  }
  const match = context.matchBefore(/(?:^|[^\w/\\]):[\w+-]{1,40}/)
  if (!match) return null
  const colon = match.text.lastIndexOf(':'), query = match.text.slice(colon + 1)
  if (isMarkdownLiteralPosition(context.state.doc.toString(), match.from + colon)) return null
  const entries = completeEmoji(query, 50)
  // Recompute on each prefix and retain the shared exact/prefix/tag ranking. A broad
  // validFor would freeze the first 50 matches and hide longer names while typing.
  return entries.length ? { from: match.from + colon, filter: false, options: entries.map((entry) => ({ label: `:${entry.name}:`, displayLabel: `${entry.emoji} :${entry.name}:`, detail: entry.description, type: 'text', apply: `:${entry.name}:` })) } : null
}

const sourceTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'var(--surface)',
    fontSize: '15px',
  },
  '.cm-content': {
    maxWidth: '920px',
    margin: '0 auto',
    padding: '44px 56px 120px',
    caretColor: 'var(--accent)',
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
    lineHeight: '1.72',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': {
    color: 'var(--muted)',
    backgroundColor: 'var(--surface)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--accent-soft) 55%, transparent)',
  },
  '&.cm-focused': { outline: 'none' },
})

function summarizeSearch(
  view: EditorView,
  query: CodeMirrorSearchQuery,
): EditorSearchSummary {
  if (!query.valid || !query.search) {
    return { count: 0, current: 0, valid: query.valid }
  }

  const matches: Array<{ from: number; to: number }> = []
  const cursor = query.getCursor(view.state)
  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    matches.push(result.value)
  }
  const selection = view.state.selection.main
  const current = matches.findIndex(
    (match) => match.from === selection.from && match.to === selection.to,
  )
  return {
    count: matches.length,
    current: current >= 0 ? current + 1 : 0,
    valid: true,
  }
}

function imageMarkdown(image: EditorImage): string {
  const alt = image.alt.replace(/[[\]\\]/g, '\\$&')
  return `![${alt}](${image.src})`
}

export const SourceEditor = forwardRef<MarkdownEditorHandle, SourceEditorProps>(
  function SourceEditor(
    { documentKey, initialMarkdown, onChange, onError, onReady, headingLines, onActiveHeadingChange, preferences = defaultPreferences },
    forwardedRef,
  ) {
    const { t, locale } = useLocalization()
    const rootRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const viewDocumentKeyRef = useRef<string | null>(null)
    const activeHeadingPropsRef = useRef({ documentKey, headingLines, onActiveHeadingChange })
    activeHeadingPropsRef.current = { documentKey, headingLines, onActiveHeadingChange }
    const activeHeadingNotificationRef = useRef<{ view: EditorView; index: number | null } | null>(null)
    const notifyActiveHeading = (view: EditorView, mountedDocumentKey: string) => {
      const current = activeHeadingPropsRef.current
      // A render can switch ownership before the old view's effect is cleaned up.
      if (viewRef.current !== view || viewDocumentKeyRef.current !== mountedDocumentKey || current.documentKey !== mountedDocumentKey) return
      if (!current.onActiveHeadingChange) { activeHeadingNotificationRef.current = null; return }
      const line = view.state.doc.lineAt(view.state.selection.main.head).number
      const index = current.headingLines ? activeHeadingIndexAtPosition(current.headingLines, line) : null
      const previous = activeHeadingNotificationRef.current
      // An inline callback may change identity after this notification sets App state.
      if (previous?.view === view && previous.index === index) return
      activeHeadingNotificationRef.current = { view, index }
      current.onActiveHeadingChange(index)
    }
    const settingsCompartment = useRef(new Compartment())
    const configuration = () => [EditorView.contentAttributes.of({ 'aria-label': t('Markdown 源码编辑器') }), preferences.sourceWrap ? EditorView.lineWrapping : [], preferences.sourceLineNumbers ? lineNumbers() : [], EditorState.tabSize.of(preferences.tabSize), indentUnit.of(' '.repeat(preferences.tabSize)), sourceWritingAids(preferences), preferences.markdownExtensions.emoji && preferences.markdownExtensions.emojiCompletion ? markdownLanguage.data.of({ autocomplete: emojiCompletionSource }) : []]
    const searchQueryRef = useRef(new CodeMirrorSearchQuery({ search: '' }))
    const onChangeRef = useRef({ documentKey, onChange })
    if (onChangeRef.current.documentKey === documentKey) onChangeRef.current.onChange = onChange
    else onChangeRef.current = { documentKey, onChange }

    useImperativeHandle(
      forwardedRef,
      () => ({
        setDropPosition: (x, y) => {
          const view = viewRef.current
          const position = view?.posAtCoords({ x, y })
          if (!view || position == null) return
          view.dispatch({ selection: { anchor: position } })
          view.focus()
        },
        getBookmark: () => {
          const view = viewRef.current
          const scroller = view?.scrollDOM
          return view ? sourceEditorBookmark(view.state, scroller ? scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight) : 0) : { anchor: 0, head: 0 }
        },
        restoreBookmark: (bookmark) => {
          const view = viewRef.current
          if (!view) return
          const clamp = (position: number) => Math.max(0, Math.min(view.state.doc.length, position))
          const anchor = clamp(bookmark.anchor), head = clamp(bookmark.head)
          view.dispatch({ selection: { anchor, head }, effects: [EditorView.scrollIntoView(head, { y: 'center' }), restoreSourceBookmark.of({ ...bookmark, anchor, head })] })
          view.focus()
        },
        replaceMarkdown: (markdown, bookmark) => {
          const view = viewRef.current
          if (!view) return
          const clamp = (position: number) => Math.max(0, Math.min(markdown.length, position))
          const anchor = clamp(bookmark?.anchor ?? 0), head = clamp(bookmark?.head ?? 0)
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown }, selection: { anchor, head }, effects: restoreSourceBookmark.of(bookmark ? { ...bookmark, anchor, head } : null), annotations: Transaction.addToHistory.of(false) })
          view.focus()
        },
        getMarkdown: () => viewRef.current?.state.doc.toString() ?? initialMarkdown,
        getSelectionText: () => {
          const view = viewRef.current
          if (!view) return ''
          const selection = view.state.selection.main
          return view.state.doc.sliceString(selection.from, selection.to)
        },
        captureSelection: () => {
          const view = viewRef.current
          if (!view || viewDocumentKeyRef.current !== documentKey || !view.dom.contains(document.activeElement)) return null
          const doc = view.state.doc, selection = view.state.selection
          const result = selection.ranges.some((range) => range !== selection.main && !range.empty)
            ? { ok: false as const, reason: 'unsupported-selection' as const }
            : fromExactSelection(doc.sliceString(selection.main.from, selection.main.to), 'source')
          return Object.freeze({ result, isCurrent: () => viewRef.current === view && viewDocumentKeyRef.current === documentKey && onChangeRef.current.documentKey === documentKey && view.dom.isConnected && view.state.doc === doc })
        },
        focus: () => viewRef.current?.focus(),
        insertMarkdown: (markdown) => {
          const view = viewRef.current
          if (!view) return
          const { from, to } = view.state.selection.main
          view.dispatch({ changes: { from, to, insert: markdown }, selection: { anchor: from + markdown.length }, userEvent: 'input' })
          view.focus()
        },
        format: (action) => {
          const view = viewRef.current
          if (!view) return
          const selection = view.state.selection.main
          if (action === 'frontMatter' && view.state.doc.toString().startsWith('---\n')) return
          const from = action === 'frontMatter' ? 0 : selection.from
          const to = action === 'frontMatter' ? 0 : selection.to
          const selected = view.state.doc.sliceString(from, to)
          const text = action === 'code' ? newCodeBlockMarkdown(selected, preferences) : formatMarkdown(action, selected)
          view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
          view.focus()
        },
        centerSelection: () => {
          const view = viewRef.current
          if (!view) return
          const position = view.state.selection.main.head
          view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) })
        },
        revealLocation: ({ line, column = 1 }) => {
          const view = viewRef.current
          if (!view) return
          const lineNumber = Math.min(Math.max(line, 1), view.state.doc.lines)
          const targetLine = view.state.doc.line(lineNumber)
          const position = Math.min(targetLine.to, targetLine.from + Math.max(0, column - 1))
          view.dispatch({
            selection: { anchor: position },
            effects: EditorView.scrollIntoView(position, { y: 'center' }),
          })
          view.focus()
        },
        setSearch: (query: EditorSearchQuery) => {
          const view = viewRef.current
          if (!view) return { count: 0, current: 0, valid: true }
          const codeMirrorQuery = new CodeMirrorSearchQuery({
            search: query.search,
            replace: query.replace,
            caseSensitive: query.caseSensitive,
            wholeWord: query.wholeWord,
            regexp: query.regexp,
          })
          searchQueryRef.current = codeMirrorQuery
          view.dispatch({ effects: setSearchQuery.of(codeMirrorQuery) })
          return summarizeSearch(view, codeMirrorQuery)
        },
        findNext: () => {
          const view = viewRef.current
          if (!view) return { count: 0, current: 0, valid: true }
          findNextCodeMirror(view)
          return summarizeSearch(view, searchQueryRef.current)
        },
        findPrevious: () => {
          const view = viewRef.current
          if (!view) return { count: 0, current: 0, valid: true }
          findPreviousCodeMirror(view)
          return summarizeSearch(view, searchQueryRef.current)
        },
        replaceNext: () => {
          const view = viewRef.current
          if (!view) return { count: 0, current: 0, valid: true }
          const before = view.state.doc
          replaceNextCodeMirror(view)
          if (view.state.doc.eq(before)) replaceNextCodeMirror(view)
          return summarizeSearch(view, searchQueryRef.current)
        },
        replaceAll: () => {
          const view = viewRef.current
          if (!view) return { count: 0, current: 0, valid: true }
          replaceAllCodeMirror(view)
          return summarizeSearch(view, searchQueryRef.current)
        },
        insertImage: (image) => {
          const view = viewRef.current
          if (!view) return
          const selection = view.state.selection.main
          const markdown = imageMarkdown(image)
          view.dispatch({
            changes: { from: selection.from, to: selection.to, insert: markdown },
            selection: { anchor: selection.from + markdown.length },
          })
          view.focus()
        },
      }),
      [initialMarkdown, preferences.defaultCodeLanguage],
    )

    useEffect(() => {
      const root = rootRef.current
      if (!root) return
      let mountedView: EditorView | null = null
      try {
        const mountedChange = onChangeRef.current
        const view = new EditorView({
          parent: root,
          state: EditorState.create({
            doc: initialMarkdown,
            extensions: [
              sourceBookmarkField,
              settingsCompartment.current.of(configuration()),
              highlightActiveLineGutter(),
              history(),
              foldGutter(),
              drawSelection(),
              indentOnInput(),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              bracketMatching(),
              autocompletion(),
              rectangularSelection(),
              crosshairCursor(),
              highlightActiveLine(),
              highlightSelectionMatches(),
              searchExtension({ top: true }),
              markdown(),
              sourceTheme,
              keymap.of([
                ...defaultKeymap,
                ...searchKeymap,
                ...historyKeymap,
                indentWithTab,
              ]),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) mountedChange.onChange(update.state.doc.toString())
                if (update.docChanged || update.selectionSet) notifyActiveHeading(update.view, documentKey)
              }),
            ],
          }),
        })
        mountedView = view
        viewRef.current = view
        viewDocumentKeyRef.current = documentKey
        onReady?.()
        // onReady may synchronously restore the caret; report that final location.
        notifyActiveHeading(view, documentKey)
        window.requestAnimationFrame(() => { if (viewRef.current === view) view.focus() })
      } catch (reason) {
        onError?.(reason)
      }

      return () => {
        mountedView?.destroy()
        if (viewRef.current === mountedView) {
          viewRef.current = null
          viewDocumentKeyRef.current = null
          activeHeadingNotificationRef.current = null
        }
      }
    }, [documentKey])

    // App's heading snapshot can arrive after a docChanged notification. Reconcile
    // the current caret without parsing Markdown or recreating the CodeMirror view.
    useEffect(() => {
      const view = viewRef.current, mountedDocumentKey = viewDocumentKeyRef.current
      if (view && mountedDocumentKey !== null) notifyActiveHeading(view, mountedDocumentKey)
    }, [documentKey, headingLines, onActiveHeadingChange])

    useEffect(() => { viewRef.current?.dispatch({ effects: settingsCompartment.current.reconfigure(configuration()) }) }, [locale, preferences.sourceWrap, preferences.sourceLineNumbers, preferences.tabSize, preferences.smartPunctuation, preferences.autoPair, preferences.autoLink, preferences.defaultCodeLanguage, preferences.markdownExtensions.emoji, preferences.markdownExtensions.emojiCompletion])

    return <div className="source-editor" ref={rootRef} />
  },
)
