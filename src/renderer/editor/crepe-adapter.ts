import { Crepe } from '@milkdown/crepe'
import { imageBlockConfig, imageBlockSchema, imageBlockView } from '@milkdown/kit/component/image-block'
import { inlineImageConfig, inlineImageView } from '@milkdown/kit/component/image-inline'
import { codeBlockConfig } from '@milkdown/kit/component/code-block'
import { tableBlockView } from '@milkdown/kit/component/table-block'
import { listItemBlockView } from '@milkdown/kit/component/list-item-block'
import { imageSchema, listItemSchema, remarkLineBreak } from '@milkdown/kit/preset/commonmark'
import { shallowReactive } from 'vue'
import { editorViewCtx, editorViewOptionsCtx } from '@milkdown/kit/core'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import { Plugin, TextSelection, type Command, type EditorState } from '@milkdown/kit/prose/state'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Decoration, DecorationSet, type EditorView, type NodeViewConstructor } from '@milkdown/kit/prose/view'
import { $prose, $inputRule, $pasteRule, $view, insert } from '@milkdown/kit/utils'
import { insertTableInputRule, remarkGFMPlugin, strikethroughInputRule, strikethroughSchema, tableSchema, tablePasteRule } from '@milkdown/kit/preset/gfm'
import { markRule } from '@milkdown/kit/prose'
import { toggleMark, setBlockType, wrapIn } from '@milkdown/kit/prose/commands'
import { parserCtx, serializerCtx } from '@milkdown/kit/core'
import { formatMarkdown, type FormatAction } from '../../shared/formatting'
import {
  SearchQuery,
  findNext as findNextMatch,
  findPrev as findPreviousMatch,
  replaceAll as replaceAllMatches,
  replaceNext as replaceNextMatch,
  search,
  setSearchState,
} from 'prosemirror-search'
import type {
  EditorAdapter,
  EditorChangeListener,
  EditorImage,
  EditorLocation,
  EditorSearchQuery,
  EditorSearchSummary,
} from './editor-adapter'
import { renderMermaidPreview } from '../mermaid-preview'
import { createMarkdownExtensions } from './markdown-extensions'
import { defaultMarkdownExtensions, defaultPreferences, type MarkdownExtensionOptions, type Preferences } from '../../shared/preferences'
import { markdownTextBlocks, nearestTextOffset, type MarkdownTextBlock } from './markdown-position'
import type { EditorBookmark } from '../../shared/document-history'
import { translate } from '../../shared/localization'
import { readInterfaceLanguage } from '../localization'
import { blockImageCompatibilityRemark, configureBlockImageCompatibility } from './image-compatibility'
import { blockImageRatio, blockImageResizeWidth } from '../../shared/block-image-markdown'
import { configureCodeMathCompatibility, createCodeMathCompatibility } from './code-math-compatibility'
import { configureNativeTableCommands, configureTableCompatibility, createTableInputRule, getTableContext, tableActionCommand, tableTabCommand, type TableAction, type TableContext } from './table-commands'
import { createWritingAids, handleWritingAidsPaste } from './writing-aids'
import { createCodePreferences } from './code-preferences'
import { newCodeBlockMarkdown } from '../../shared/writing-aids'
import { createNativeEditorControls } from './native-editor-controls'
import { CellSelection, selectedRect, TableMap } from '@milkdown/kit/prose/tables'
import { codeMetadataFieldBookmark, inferCodeMathField, inlineMathFieldBookmark } from './code-math-position'
import { nativeTableSelectionView } from './table-view'
import { nativeListSelectionView } from './list-view'
import { createTableClipboardProtocol } from './table-clipboard-protocol'
import type { TableClipboardReason } from './table-clipboard'
import { configureTableMarkdownCompatibility, tableLineBreakCompatibility } from './table-markdown-compatibility'
import { configureTableHardbreakCompatibility, tableHardbreakCompatibility, insertTableHardbreakCommand } from './table-hardbreak-compatibility'
import { configureTableClipboardContent, createTableClipboardSerializer, type TableClipboardContentSerializer } from './table-clipboard-content'
import { activeHeadingIndexAtPosition } from '../active-heading'
import { createImageLinkInput } from './image-link-input'
import { createMarkdownSerializationCache } from './markdown-serialization-cache'
import { fromExactSelection, serializeRichSelection } from './selection-fragment'
import { captureEmbeddedSelection, type SelectionCopySnapshot } from './selection-snapshot'

export class CrepeEditorAdapter implements EditorAdapter {
  private readonly crepe: Crepe
  private readonly codePreferences: ReturnType<typeof createCodePreferences>
  private readonly nativeControls: ReturnType<typeof createNativeEditorControls>
  private readonly tableClipboard: ReturnType<typeof createTableClipboardProtocol>
  private clipboardContentSerializer: TableClipboardContentSerializer | null = null
  private created = false
  private lastMarkdown: string
  private originalMarkdown: string
  private normalizedAtMount = ''
  private readonly markdownSerialization = createMarkdownSerializationCache()
  private replacing = false
  private mappedMarkdown = ''
  private mappedBlocks: MarkdownTextBlock[] = []
  private headingDocument: ProseNode | null = null
  private headingPositions: number[] = []
  private publishedHeadingIndex: number | null | undefined
  private focusedElement: HTMLElement | null = null
  private readonly rememberFocus = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return
    this.focusedElement = event.target
    if (this.created) this.withEditorView((view) => this.publishActiveHeading(view))
  }
  private searchQuery = new SearchQuery({ search: '' })
  private readonly imageLocaleUpdates = new Set<() => void>()
  private readonly imageResourceUpdates = new Set<() => void>()
  private readonly imageDraftChecks = new Set<(source: string) => boolean>()
  private imageResourceGeneration = 0
  private imageResourcesDisposed = false
  private readonly htmlResourceUpdates = new Set<() => void>()
  private previewToggle: ((mode: boolean) => string) | null = null
  private readonly t = (key: string) => translate(readInterfaceLanguage(), key)
  private readonly refreshLocale = () => {
    if (!this.created) return
    this.crepe.editor.action((ctx) => {
      this.nativeControls.refresh(ctx)
      // Crepe's main bundle owns this slice; its separate feature entry point
      // creates a different slice identity. Resolve the injected context by name.
      ctx.update<{ text: string; mode: 'doc' | 'block' }, string>('placeholderConfigCtx', (value) => { value.text = this.t('开始写作…'); return value })
      ctx.update(imageBlockConfig.key, (value) => Object.assign(value, { uploadButton: this.t('选择图片'), confirmButton: this.t('确认'), uploadPlaceholderText: this.t('或粘贴图片链接'), captionPlaceholderText: this.t('图片说明') }))
      ctx.update(inlineImageConfig.key, (value) => Object.assign(value, { uploadButton: this.t('选择图片'), confirmButton: this.t('确认'), uploadPlaceholderText: this.t('或粘贴图片链接') }))
      ctx.update(codeBlockConfig.key, (value) => Object.assign(value, { searchPlaceholder: this.t('搜索代码语言'), copyText: this.t('复制代码'), noResultText: this.t('未找到语言'), previewLabel: this.t('图表预览'), previewLoading: this.t('正在渲染…'), previewToggleButton: (mode: boolean) => this.previewToggle?.(mode) ?? this.t(mode ? '编辑源码' : '隐藏源码') }))
      this.imageLocaleUpdates.forEach((update) => update())
      const view = ctx.get(editorViewCtx)
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta('addToHistory', false))
    })
  }

  constructor(
    private readonly root: HTMLElement,
    initialMarkdown: string,
    onChange: EditorChangeListener,
    onUploadImage: (file: File) => Promise<string>,
    onResolveImageUrl: (source: string) => Promise<string> | string,
    private readonly extensionOptions: MarkdownExtensionOptions = defaultMarkdownExtensions,
    onResolveMediaUrl: (source: string) => Promise<string> | string = () => { throw new Error('媒体路径没有得到授权。') },
    onTableContextChange: (context: TableContext | null) => void = () => {},
    private preferences: Preferences = defaultPreferences,
    onClipboardTransaction: () => void | (() => void) = () => {},
    onClipboardRejected: (reason: TableClipboardReason) => void = () => {},
    private readonly onActiveHeadingChange: (index: number | null) => void = () => {},
  ) {
    this.lastMarkdown = initialMarkdown
    this.originalMarkdown = initialMarkdown
    this.codePreferences = createCodePreferences(() => this.preferences)
    this.nativeControls = createNativeEditorControls(this.t, () => this.preferences)
    this.tableClipboard = createTableClipboardProtocol({ historyBoundary: () => onClipboardTransaction(), onRejected: onClipboardRejected, onError: () => onClipboardRejected('unsupported-shape'), serializationRejection: () => {
      const status = this.clipboardContentSerializer?.contentStatus
      return status && !status.ok ? status.reason === 'size-limit' ? 'size-limit' : 'unsupported-shape' : undefined
    } })
    this.crepe = new Crepe({
      root: this.root,
      defaultValue: initialMarkdown,
      features: {
        [Crepe.Feature.Table]: true,
        [Crepe.Feature.Latex]: false,
        [Crepe.Feature.ImageBlock]: true,
        [Crepe.Feature.TopBar]: false,
        [Crepe.Feature.AI]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Toolbar]: this.nativeControls.toolbar,
        [Crepe.Feature.BlockEdit]: this.nativeControls.blockEdit,
        [Crepe.Feature.Placeholder]: {
          text: this.t('开始写作…'),
          mode: 'block',
        },
        [Crepe.Feature.ImageBlock]: {
          onUpload: onUploadImage,
          proxyDomURL: (source) => {
            if (!source) return ''
            const generation = this.imageResourceGeneration
            const resolved = onResolveImageUrl(source)
            if (typeof resolved === 'string') return resolved
            return resolved.then(async (url) => {
              // Vue binds the model caption when its URL changes. Let the native
              // debounce/blur commit first so that render cannot overwrite a
              // pending field value and invalidate Chromium's input undo range.
              while (!this.imageResourcesDisposed && generation === this.imageResourceGeneration && [...this.imageDraftChecks].some((pending) => pending(source))) {
                await new Promise<void>((resolve) => window.setTimeout(resolve, 25))
              }
              if (this.imageResourcesDisposed || generation !== this.imageResourceGeneration) throw new Error(this.t('资源路径已变化，请重试。'))
              return url
            })
          },
          blockUploadButton: this.t('选择图片'),
          inlineUploadButton: this.t('选择图片'),
          blockConfirmButton: this.t('确认'),
          inlineConfirmButton: this.t('确认'),
          blockUploadPlaceholderText: this.t('或粘贴图片链接'),
          inlineUploadPlaceholderText: this.t('或粘贴图片链接'),
          blockCaptionPlaceholderText: this.t('图片说明'),
        },
        [Crepe.Feature.CodeMirror]: {
          extensions: [this.codePreferences.extension],
          renderPreview: (language, content, applyPreview) => {
            if (language.trim().toLowerCase() !== 'mermaid') return null
            renderMermaidPreview(content, applyPreview)
          },
          searchPlaceholder: this.t('搜索代码语言'),
          copyText: this.t('复制代码'),
          noResultText: this.t('未找到语言'),
          previewLabel: this.t('图表预览'),
          previewLoading: this.t('正在渲染…'),
          previewToggleText: (previewOnlyMode) =>
            this.t(previewOnlyMode ? '编辑源码' : '隐藏源码'),
        },
      },
    })
    this.crepe.editor.config((ctx) => {
      configureBlockImageCompatibility(ctx)
      configureCodeMathCompatibility(ctx)
      configureTableCompatibility(ctx)
      configureTableMarkdownCompatibility(ctx)
      configureTableHardbreakCompatibility(ctx)
      configureTableClipboardContent(ctx)
      this.nativeControls.configure(ctx)
      // Components capture their configuration at creation. Keep the same shallow
      // reactive object so labels update while CodeMirror objects remain untouched.
      ctx.update(imageBlockConfig.key, (value) => shallowReactive(value))
      ctx.update(inlineImageConfig.key, (value) => shallowReactive(value))
      ctx.update(codeBlockConfig.key, (value) => { this.previewToggle = value.previewToggleButton; return shallowReactive(value) })
      ctx.update(remarkGFMPlugin.options.key, (options) => ({ ...options, singleTilde: false }))
      ctx.update(editorViewOptionsCtx, (options) => ({ ...options, handleKeyDown: (view, event) => {
        if (event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && view.editable && insertTableHardbreakCommand(view.state, view.dispatch, view)) return true
        if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && view.editable && tableTabCommand(event.shiftKey ? -1 : 1)(view.state, view.dispatch, view)) return true
        return options.handleKeyDown?.(view, event) ?? false
      }, handlePaste: (view, event, slice) => {
        if (this.tableClipboard.handlePaste(view, event, slice)) return true
        // The native clipboard plugin parses Markdown and replaces selected text.
        // Intercept only enabled URL assistance before that plugin consumes it.
        if (handleWritingAidsPaste(view, event, this.preferences)) return true
        return options.handlePaste?.(view, event, slice) ?? false
      }, handleDOMEvents: {
        ...options.handleDOMEvents,
        copy: (view, event) => this.tableClipboard.handleDOMEvents.copy(view, event) || (options.handleDOMEvents?.copy?.(view, event) ?? false),
        cut: (view, event) => this.tableClipboard.handleDOMEvents.cut(view, event) || (options.handleDOMEvents?.cut?.(view, event) ?? false),
      }, dispatchTransaction: function (this: EditorView, transaction) {
        // Table node views can queue selection updates. Ignore them once this view has closed.
        if (!this.isDestroyed) this.updateState(this.state.apply(transaction))
      } }))
    })
    this.root.addEventListener('focusin', this.rememberFocus)
    window.addEventListener('ttypora:interface-language', this.refreshLocale)
    // ImageInput destructures primitive props in the upstream component. Refresh
    // only those atomic node views; their document nodes and outer DOM stay intact.
    this.crepe.editor.use($view(imageBlockSchema.node, (ctx) => this.localizedImageView(() => imageBlockView.view, onResolveImageUrl, onUploadImage, (proxy, create) => {
      const config = ctx.get(imageBlockConfig.key)
      ctx.set(imageBlockConfig.key, { ...config, proxyDomURL: proxy })
      try { return create() } finally { ctx.set(imageBlockConfig.key, config) }
    })))
    this.crepe.editor.use($view(imageSchema.node, (ctx) => this.localizedImageView(() => inlineImageView.view, onResolveImageUrl, onUploadImage, (proxy, create) => {
      const config = ctx.get(inlineImageConfig.key)
      ctx.set(inlineImageConfig.key, { ...config, proxyDomURL: proxy })
      try { return create() } finally { ctx.set(inlineImageConfig.key, config) }
    })))
    this.crepe.editor.use($view(tableSchema.node, () => nativeTableSelectionView(() => tableBlockView.view)))
    this.crepe.editor.use($view(listItemSchema.node, () => nativeListSelectionView(() => listItemBlockView.view)))
    this.crepe.editor.use($prose(() => search()))
    this.crepe.editor.remove(insertTableInputRule)
    this.crepe.editor.remove(tablePasteRule)
    this.crepe.editor.remove(remarkLineBreak.plugin)
    this.crepe.editor.use(tableLineBreakCompatibility)
    this.crepe.editor.use(tableHardbreakCompatibility)
    this.crepe.editor.use($pasteRule(() => ({ priority: 0, run: (slice, view, isPlainText) => this.tableClipboard.transformPasted(slice, view, isPlainText) })))
    this.crepe.editor.use($inputRule(createTableInputRule))
    this.crepe.editor.remove(strikethroughInputRule)
    this.crepe.editor.use($inputRule((ctx) => markRule(/(?<![~\\])~~([^~\n]+)~~$/, strikethroughSchema.type(ctx))))
    this.crepe.editor.use(blockImageCompatibilityRemark)
    this.crepe.editor.use(createCodeMathCompatibility(this.codePreferences.extension))
    this.crepe.editor.use(createWritingAids(() => this.preferences))
    this.crepe.editor.use(createMarkdownExtensions(extensionOptions, onResolveImageUrl, onResolveMediaUrl, (refresh) => {
      this.htmlResourceUpdates.add(refresh)
      return () => { this.htmlResourceUpdates.delete(refresh) }
    }))
    this.crepe.editor.use($prose(() => new Plugin({ view: (view) => {
      let last = ''
      const update = (current: EditorView) => {
        const context = getTableContext(current.state), key = JSON.stringify(context)
        if (key !== last) { last = key; onTableContextChange(context) }
      }
      update(view)
      return { update, destroy: () => onTableContextChange(null) }
    } })))
    this.crepe.editor.use($prose(() => new Plugin({ props: { decorations: (state) => {
      const position = state.selection.$head
      if (!position.depth) return DecorationSet.empty
      return DecorationSet.create(state.doc, [Decoration.node(position.before(1), position.after(1), { class: 'ttypora-focus-block' })])
    } } })))
    const notify = () => {
      if (!this.created || this.replacing) return
      const markdown = this.getMarkdown()
      if (markdown === this.lastMarkdown) return
      this.lastMarkdown = markdown
      onChange(markdown)
    }
    // A synchronous transaction notification captures typing, formatting and embedded editors.
    this.crepe.editor.use($prose(() => new Plugin({ view: () => ({ update: (view, previous) => { if (!view.state.doc.eq(previous.doc)) notify() } }) })))
    // Publish after the document-change listener has supplied the new Markdown
    // snapshot. Selection-only updates read cached PM positions, never Markdown.
    this.crepe.editor.use($prose(() => new Plugin({ view: () => ({ update: (view) => this.publishActiveHeading(view) }) })))

    // The synchronous PluginView above already observes every document update,
    // including transactions excluded from native history. A markdownUpdated
    // subscription would make Milkdown serialize the document again after 200ms.
  }

  async mount(): Promise<void> {
    this.markdownSerialization.clear()
    await this.crepe.create()
    this.crepe.editor.action(configureNativeTableCommands)
    this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      this.clipboardContentSerializer = createTableClipboardSerializer(view.state.schema, view.someProp('clipboardSerializer'))
      view.setProps({ clipboardSerializer: this.clipboardContentSerializer })
    })
    this.normalizedAtMount = this.serializedMarkdown()
    this.lastMarkdown = this.originalMarkdown
    this.created = true
    this.refreshLocale()
    this.withEditorView((view) => this.publishActiveHeading(view))
  }

  getMarkdown(): string {
    if (!this.created) return this.originalMarkdown
    const markdown = this.serializedMarkdown()
    return markdown === this.normalizedAtMount ? this.originalMarkdown : markdown
  }

  private serializedMarkdown(): string {
    return this.withEditorView((view) => this.markdownSerialization.read(view.state.doc, () => this.crepe.getMarkdown()))
  }

  refreshResources(): void {
    if (!this.created) return
    this.imageResourceGeneration++
    // Rebind the native image view in place. Recreating its Vue app would leave
    // an old caption debounce alive and could introduce a second history edit.
    this.imageResourceUpdates.forEach((refresh) => refresh())
    this.htmlResourceUpdates.forEach((refresh) => refresh())
  }

  private positionBlocks() {
    const markdown = this.getMarkdown()
    if (markdown !== this.mappedMarkdown || !this.mappedBlocks.length) {
      this.mappedMarkdown = markdown
      this.mappedBlocks = markdownTextBlocks(markdown, this.extensionOptions)
    }
    return this.mappedBlocks
  }

  private textBlocks(view: EditorView) {
    const blocks: { position: number; size: number; text: string; source: MarkdownTextBlock | undefined; html: boolean }[] = []
    const source = this.positionBlocks()
    let cursor = 0
    view.state.doc.descendants((node, position) => {
      const html = node.type.name === 'html_block'
      if (!node.isTextblock && !html) return
      const text = html ? String(node.attrs.value) : node.textBetween(0, node.content.size, '', '\ufffc')
      let index = source.findIndex((item, index) => index >= cursor && item.text === text)
      if (index < 0) index = cursor
      blocks.push({ position: position + (html ? 0 : 1), size: node.content.size, text, source: source[index], html })
      cursor = index + 1
      return false
    })
    return blocks
  }

  getBookmark(): EditorBookmark {
    if (!this.created) return { anchor: 0, head: 0 }
    return this.withEditorView((view) => {
      const blocks = this.textBlocks(view)
      const map = (position: number, end: boolean) => {
        const block = blocks.find((block) => position >= block.position && position <= block.position + block.size)
        if (!block?.source) return Math.min(this.getMarkdown().length, position)
        const offsets = end ? block.source.endOffsets : block.source.offsets
        return offsets[Math.min(position - block.position, offsets.length - 1)] ?? block.source.from
      }
      const scroller = this.root.querySelector('.milkdown') as HTMLElement | null
      let anchor = view.state.selection.anchor, head = view.state.selection.head
      if (view.state.selection instanceof CellSelection) {
        const selection = view.state.selection, rect = selectedRect(view.state)
        const first = blocks.find((block) => block.position >= rect.tableStart && block.position < rect.tableStart + rect.table.nodeSize)
        if (first?.source) {
          const address = (position: number) => { const cell = rect.map.findCell(position - rect.tableStart); return { row: cell.top, column: cell.left } }
          return { anchor: map(selection.$anchorCell.pos + 2, false), head: map(selection.$headCell.pos + 2, true), tableSelection: { sourceOffset: first.source.from, anchor: address(selection.$anchorCell.pos), head: address(selection.$headCell.pos) } }
        }
      }
      const active = this.root.contains(document.activeElement) ? document.activeElement : this.focusedElement
      if (active instanceof HTMLInputElement && active.hasAttribute('data-code-meta') && this.root.contains(active)) {
        const block = blocks.find((block) => !block.html && block.source?.type === 'code' && view.nodeDOM(block.position - 1)?.contains(active))
        if (block?.source) {
          const from = active.selectionStart ?? 0, to = active.selectionEnd ?? from
          const anchor = active.selectionDirection === 'backward' ? to : from, head = active.selectionDirection === 'backward' ? from : to
          const bookmark = codeMetadataFieldBookmark(this.getMarkdown(), block.source.from, anchor, head)
          if (bookmark) return bookmark
        }
      }
      if (active instanceof HTMLTextAreaElement && active.hasAttribute('data-math-source-editor') && this.root.contains(active)) {
        let position: number | undefined
        view.state.doc.descendants((node, offset) => { if (node.type.name === 'math_inline' && view.nodeDOM(offset)?.contains(active)) { position = offset; return false } })
        if (position !== undefined) {
          const sourceOffset = map(position, false), from = active.selectionStart, to = active.selectionEnd
          const anchor = active.selectionDirection === 'backward' ? to : from, head = active.selectionDirection === 'backward' ? from : to
          const bookmark = inlineMathFieldBookmark(this.getMarkdown(), sourceOffset, anchor, head)
          if (bookmark) return bookmark
        }
      }
      if (active instanceof HTMLTextAreaElement && active.dataset.htmlSourceEditor === 'true' && this.root.contains(active)) {
        const block = blocks.find((block) => block.html && view.nodeDOM(block.position)?.contains(active))
        if (block?.source) {
          const from = block.source.from + active.selectionStart, to = block.source.from + active.selectionEnd
          return { anchor: active.selectionDirection === 'backward' ? to : from, head: active.selectionDirection === 'backward' ? from : to }
        }
      }
      const embedded = active instanceof HTMLElement && active.closest<HTMLElement>('.cm-editor')
      const cm = embedded ? CodeMirrorView.findFromDOM(embedded) : null
      const code = cm && blocks.find((block) => !block.html && view.nodeDOM(block.position - 1)?.contains(cm.dom))
      if (code && cm) { anchor = code.position + cm.state.selection.main.anchor; head = code.position + cm.state.selection.main.head }
      const selection = window.getSelection()
      if (!cm && selection?.anchorNode && selection.focusNode && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) {
        try { anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset); head = view.posAtDOM(selection.focusNode, selection.focusOffset) } catch { /* use the model selection for atomic node views */ }
      }
      return { anchor: map(anchor, anchor > head), head: map(head, head > anchor), scrollRatio: scroller ? scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight) : 0 }
    })
  }

  restoreBookmark(bookmark: EditorBookmark): void {
    if (!this.created) return
    this.withEditorView((view) => {
      const blocks = this.textBlocks(view)
      if (bookmark.tableSelection) {
        const selection = bookmark.tableSelection
        const first = blocks.find((block) => block.source?.from === selection.sourceOffset)
        if (first) {
          const $position = view.state.doc.resolve(first.position)
          for (let depth = $position.depth; depth > 0; depth--) {
            const node = $position.node(depth)
            if (node.type.name !== 'table') continue
            const map = TableMap.get(node), start = $position.start(depth)
            const cell = (address: { row: number; column: number }) => start + map.map[Math.min(map.height - 1, Math.max(0, address.row)) * map.width + Math.min(map.width - 1, Math.max(0, address.column))]
            if (map.width && map.height) { view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cell(selection.anchor), cell(selection.head)))); view.focus(); return }
          }
        }
      }
      const embedded = bookmark.embedded ?? inferCodeMathField(this.getMarkdown(), this.positionBlocks(), bookmark)
      if (embedded) {
        let input: HTMLInputElement | HTMLTextAreaElement | null = null
        if (embedded.kind === 'code-meta') {
          const block = blocks.find((block) => block.source?.type === 'code' && block.source.from === embedded.sourceOffset)
          const dom = block && view.nodeDOM(block.position - 1)
          if (dom instanceof HTMLElement) input = dom.querySelector('[data-code-meta]')
        } else {
          const block = blocks.find((block) => block.source && embedded.sourceOffset >= block.source.from && embedded.sourceOffset <= block.source.to)
          if (block?.source) {
            const position = block.position + nearestTextOffset(block.source.offsets, embedded.sourceOffset)
            const dom = view.nodeDOM(position)
            if (dom instanceof HTMLElement) {
              input = dom.querySelector('[data-math-source-editor]')
              const panel = dom.querySelector<HTMLElement>('.ttypora-math-inline-panel')
              if (panel) panel.hidden = false
              dom.querySelector('.ttypora-math-inline-edit')?.setAttribute('aria-expanded', 'true')
            }
          }
        }
        if (input) {
          const anchor = Math.min(input.value.length, embedded.anchor), head = Math.min(input.value.length, embedded.head)
          input.focus(); input.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? 'backward' : 'forward'); return
        }
      }
      const html = blocks.find((block) => block.html && block.source && Math.min(bookmark.anchor, bookmark.head) >= block.source.from && Math.max(bookmark.anchor, bookmark.head) <= block.source.to)
      if (html?.source) {
        const dom = view.nodeDOM(html.position)
        const input = dom instanceof HTMLElement ? dom.querySelector('textarea') : null
        if (input) { const details = input.closest('details'); if (details) details.open = true; input.focus(); input.setSelectionRange(Math.min(bookmark.anchor, bookmark.head) - html.source.from, Math.max(bookmark.anchor, bookmark.head) - html.source.from, bookmark.anchor > bookmark.head ? 'backward' : 'forward'); return }
      }
      const map = (offset: number, end: boolean) => {
        const editable = blocks.filter((block) => !block.html)
        if (!editable.length) return 0
        const block = editable.find((block) => block.source && offset >= block.source.from && offset <= block.source.to)
          ?? [...editable].sort((a, b) => Math.abs((a.source?.from ?? 0) - offset) - Math.abs((b.source?.from ?? 0) - offset))[0]
        return block.position + Math.min(block.size, block.source ? nearestTextOffset(end ? block.source.endOffsets : block.source.offsets, offset) : 0)
      }
      const anchor = Math.min(view.state.doc.content.size, map(bookmark.anchor, bookmark.anchor > bookmark.head)), head = Math.min(view.state.doc.content.size, map(bookmark.head, bookmark.head > bookmark.anchor))
      view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head))).scrollIntoView())
      view.focus()
      const code = blocks.find((block) => !block.html && anchor >= block.position && head >= block.position && anchor <= block.position + block.size && head <= block.position + block.size && ['code', 'math'].includes(block.source?.type ?? ''))
      const codeDOM = code && view.nodeDOM(code.position - 1)
      const cmElement = codeDOM instanceof HTMLElement ? codeDOM.querySelector<HTMLElement>('.cm-editor') : null
      const cm = cmElement && CodeMirrorView.findFromDOM(cmElement)
      if (cm && code) { cm.dispatch({ selection: { anchor: anchor - code.position, head: head - code.position } }); cm.focus() }
    })
  }

  replaceMarkdown(markdown: string, bookmark?: EditorBookmark | null): void {
    if (!this.created) return
    this.crepe.editor.action((ctx) => {
      const parsed = ctx.get(parserCtx)(markdown)
      if (!parsed) throw new Error('Markdown 解析失败，当前内容已保留。')
      const view = ctx.get(editorViewCtx)
      this.replacing = true
      this.markdownSerialization.clear()
      try {
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content).setMeta('addToHistory', false))
        this.originalMarkdown = markdown
        this.normalizedAtMount = this.serializedMarkdown()
        this.lastMarkdown = markdown
        this.mappedMarkdown = ''
        if (bookmark) this.restoreBookmark(bookmark)
      } finally { this.replacing = false }
    })
  }

  setDropPosition(x: number, y: number): void {
    this.withEditorView((view) => { const found = view.posAtCoords({ left: x, top: y }); if (found) { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(found.pos)))); view.focus() } })
  }

  insertMarkdown(markdown: string): void {
    const active = this.root.contains(document.activeElement) ? document.activeElement : this.focusedElement
    if (active instanceof HTMLTextAreaElement && active.dataset.htmlSourceEditor === 'true') {
      active.setRangeText(markdown, active.selectionStart, active.selectionEnd, 'end')
      active.dispatchEvent(new Event('input', { bubbles: true }))
      active.focus()
      return
    }
    this.withEditorView((view) => { this.syncDomSelection(view); this.crepe.editor.action(insert(markdown, true)); view.focus() })
  }

  format(action: FormatAction): void {
    this.withEditorView((view) => {
      this.syncDomSelection(view)
      if (['highlight', 'superscript', 'subscript', 'underline'].includes(action) && !this.extensionOptions[action as keyof MarkdownExtensionOptions]) return
      const mark = { bold: 'strong', italic: 'emphasis', strike: 'strike_through', inlineCode: 'inlineCode', highlight: 'highlight', superscript: 'superscript', subscript: 'subscript', underline: 'underline' }[action as string]
      if (mark && view.state.schema.marks[mark]) { toggleMark(view.state.schema.marks[mark])(view.state, view.dispatch, view); view.focus(); return }
      if (action.startsWith('heading') || action === 'paragraph') {
        const type = view.state.schema.nodes[action === 'paragraph' ? 'paragraph' : 'heading']
        setBlockType(type, action === 'paragraph' ? undefined : { level: Number(action.slice(-1)) })(view.state, view.dispatch, view); view.focus(); return
      }
      if (action === 'quote') { wrapIn(view.state.schema.nodes.blockquote)(view.state, view.dispatch, view); view.focus(); return }
      if (action === 'frontMatter') {
        if (view.state.doc.firstChild?.type.name === 'front_matter') return
        this.crepe.editor.action((ctx) => { const parsed = ctx.get(parserCtx)(formatMarkdown(action, '')); if (parsed?.firstChild) view.dispatch(view.state.tr.insert(0, parsed.firstChild)) })
      } else this.crepe.editor.action(insert(action === 'code' ? newCodeBlockMarkdown(this.getSelectionText(), this.preferences) : formatMarkdown(action, this.getSelectionText()), true))
      view.focus()
    })
  }

  tableAction(action: TableAction): void {
    if (!this.created) return
    this.withEditorView((view) => { tableActionCommand(action)(view.state, view.dispatch, view); view.focus() })
  }

  setPreferences(preferences: Preferences): void {
    this.preferences = preferences
    this.codePreferences.update()
  }

  getSelectionText(): string {
    return this.withEditorView((view) => {
      this.syncDomSelection(view)
      const { from, to } = view.state.selection
      return view.state.doc.textBetween(from, to, '\n')
    })
  }

  captureSelection(): SelectionCopySnapshot | null {
    if (!this.created || !this.root.contains(document.activeElement)) return null
    return this.withEditorView((view) => {
      const doc = view.state.doc
      const current = () => this.created && this.root.isConnected && this.withEditorView((currentView) => currentView === view && currentView.state.doc === doc)
      const embedded = captureEmbeddedSelection(this.root)
      if (embedded) return Object.freeze({ result: embedded.result, isCurrent: () => current() && embedded.isCurrent() })
      if (view.state.selection instanceof CellSelection) return Object.freeze({ result: { ok: false as const, reason: 'unsupported-selection' as const }, isCurrent: current })
      let selection = view.state.selection
      // Capture a late native DOM text selection without dispatching any transaction.
      const dom = window.getSelection()
      if (selection instanceof TextSelection && dom?.anchorNode && dom.focusNode && view.dom.contains(dom.anchorNode) && view.dom.contains(dom.focusNode)) {
        try { selection = TextSelection.create(doc, view.posAtDOM(dom.anchorNode, dom.anchorOffset), view.posAtDOM(dom.focusNode, dom.focusOffset)) }
        catch { return Object.freeze({ result: { ok: false as const, reason: 'unsupported-selection' as const }, isCurrent: current }) }
      }
      if (selection instanceof TextSelection && selection.$from.parent.type.name === 'front_matter' && selection.$from.sameParent(selection.$to)) {
        return Object.freeze({ result: fromExactSelection(doc.textBetween(selection.from, selection.to, '\n'), 'literal'), isCurrent: current })
      }
      const serialize = this.crepe.editor.action((ctx) => ctx.get(serializerCtx))
      return Object.freeze({ result: serializeRichSelection(selection.content(), view.state.schema, serialize), isCurrent: current })
    })
  }

  private syncDomSelection(view: EditorView): void {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !selection.focusNode || !view.dom.contains(selection.anchorNode) || !view.dom.contains(selection.focusNode)) return
    const element = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement
    if (element?.closest('.cm-editor')) return
    try {
      const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset), head = view.posAtDOM(selection.focusNode, selection.focusOffset)
      if (anchor !== view.state.selection.anchor || head !== view.state.selection.head) view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head))))
    } catch { /* Atomic node views keep their model selection. */ }
  }

  focus(): void {
    const editorRoot = this.root.querySelector('.ProseMirror')
    if (editorRoot instanceof HTMLElement) editorRoot.focus()
  }

  centerSelection(): void {
    const selection = window.getSelection()
    const node = selection?.anchorNode
    const element = node instanceof Element ? node : node?.parentElement
    const block = element?.closest('p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, table')
    if (block instanceof HTMLElement && this.root.contains(block)) {
      block.scrollIntoView({ block: 'center' })
    }
  }

  revealLocation(location: EditorLocation): void {
    if (!this.created || !Number.isSafeInteger(location.headingIndex) || location.headingIndex < 0) return
    this.withEditorView((view) => {
      this.cacheHeadingPositions(view.state.doc)
      const position = this.headingPositions[location.headingIndex]
      if (position === undefined || view.isDestroyed) return
      const heading = view.state.doc.nodeAt(position)
      if (heading?.type.name !== 'heading') return
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position + 1)).setMeta('addToHistory', false).scrollIntoView())
      view.focus()
      const dom = view.nodeDOM(position)
      if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
      this.publishActiveHeading(view)
    })
  }

  /** PM node starts preserve duplicate and nested heading identity by order. */
  private cacheHeadingPositions(document: ProseNode): boolean {
    if (this.headingDocument === document) return false
    const positions: number[] = []
    document.descendants((node, position) => {
      if (node.type.name === 'heading') positions.push(position)
    })
    this.headingDocument = document
    this.headingPositions = positions
    return true
  }

  private publishActiveHeading(view: EditorView): void {
    if (!this.created || view.isDestroyed) return
    const snapshotChanged = this.cacheHeadingPositions(view.state.doc)
    let caret = view.state.selection.head
    const active = view.dom.ownerDocument.activeElement
    if (active instanceof HTMLElement && view.dom.contains(active)) {
      const embedded = active.closest<HTMLElement>('[data-type="math_inline"], .ttypora-code-block, .ttypora-math-block, .html-block, .ttypora-localized-image-view, .front-matter, .milkdown-table-block')
      if (embedded && view.dom.contains(embedded)) {
        // Node views can keep an input/CM focus without changing PM selection.
        // Their containing node starts identify the same section independently
        // of input text, iframe previews, HTML tags or a previous PM caret.
        try { caret = view.posAtDOM(embedded, 0, -1) } catch { /* use the live PM selection if the node view has just detached */ }
      }
    }
    const index = activeHeadingIndexAtPosition(this.headingPositions, caret)
    if (!snapshotChanged && index === this.publishedHeadingIndex) return
    this.publishedHeadingIndex = index
    this.onActiveHeadingChange(index)
  }

  setSearch(query: EditorSearchQuery): EditorSearchSummary {
    this.searchQuery = new SearchQuery(query)
    return this.withEditorView((view) => {
      view.dispatch(setSearchState(view.state.tr, this.searchQuery))
      return this.getSearchSummary(view.state)
    })
  }

  findNext(): EditorSearchSummary {
    return this.runSearchCommand(findNextMatch)
  }

  findPrevious(): EditorSearchSummary {
    return this.runSearchCommand(findPreviousMatch)
  }

  replaceNext(): EditorSearchSummary {
    return this.withEditorView((view) => {
      const before = view.state.doc
      replaceNextMatch(view.state, view.dispatch, view)
      if (view.state.doc.eq(before)) {
        replaceNextMatch(view.state, view.dispatch, view)
      }
      return this.getSearchSummary(view.state)
    })
  }

  replaceAll(): EditorSearchSummary {
    return this.runSearchCommand(replaceAllMatches)
  }

  insertImage(image: EditorImage): void {
    this.withEditorView((view) => {
      const nodeType = view.state.schema.nodes['image-block'] ?? view.state.schema.nodes.image
      if (!nodeType) return
      const node = nodeType.name === 'image-block'
        ? nodeType.createAndFill({ src: image.src, alt: image.alt, caption: '', ratio: 1 })
        : nodeType.createAndFill({ src: image.src, alt: image.alt, title: '' })
      if (!node) return
      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
      view.focus()
    })
  }

  private runSearchCommand(command: Command): EditorSearchSummary {
    return this.withEditorView((view) => {
      command(view.state, view.dispatch, view)
      return this.getSearchSummary(view.state)
    })
  }

  private localizedImageView(
    factory: () => NodeViewConstructor,
    resolveUrl: (source: string) => Promise<string> | string,
    uploadFile: (file: File) => Promise<string>,
    withProxy: (proxy: (source: string) => Promise<string> | string, create: () => ReturnType<NodeViewConstructor>) => ReturnType<NodeViewConstructor>,
  ): NodeViewConstructor {
    return (initial, view, getPos, initialDecorations, initialInnerDecorations) => {
      let node = initial, decorations = initialDecorations, innerDecorations = initialInnerDecorations
      let selected = false, disposed = false
      let instanceGeneration = 0
      let nativeBinding: { generation: number; resources: number; source: string; url: string } | null = null
      const create = () => {
        const generation = ++instanceGeneration
        nativeBinding = null
        let request = 0
        const proxy = (source: string): Promise<string> | string => {
          const sequence = ++request, resources = this.imageResourceGeneration
          if (!source) { nativeBinding = null; return '' }
          const assertCurrent = () => {
            if (disposed || view.isDestroyed || generation !== instanceGeneration || sequence !== request || this.imageResourcesDisposed || resources !== this.imageResourceGeneration) throw new Error(this.t('资源路径已变化，请重试。'))
            let position: number | undefined
            try { position = getPos() } catch { position = undefined }
            const currentNode = position === undefined ? null : view.state.doc.nodeAt(position)
            if (currentNode?.type !== node.type || currentNode.attrs.src !== source) throw new Error(this.t('资源路径已变化，请重试。'))
          }
          const display = async (url: string) => {
            assertCurrent()
            while ([...this.imageDraftChecks].some((pending) => pending(source))) {
              await new Promise<void>((resolve) => window.setTimeout(resolve, 25))
              assertCurrent()
            }
            nativeBinding = url ? { generation, resources, source, url } : null
            return url
          }
          let resolved: Promise<string> | string
          try { resolved = resolveUrl(source) } catch { resolved = Promise.reject(new Error('Image resolution failed')) }
          // Let wrapper.update install its new node before checking caption
          // drafts, including App's synchronous HTTP/data/blob resolver path.
          if (typeof resolved === 'string') return Promise.resolve(resolved).then(display)
          // A current failed reference must clear the previous image. Superseded
          // requests reject before assigning a URL to the native Vue view.
          return resolved.then(display, () => display(''))
        }
        // Upstream initializes the DOM src before its asynchronous proxy resolves.
        // A view-only clone keeps the document's original URL intact while the
        // native update obtains an authorized URL before displaying the image.
        const blank = node.type.create({ ...node.attrs, src: '' }, node.content, node.marks)
        const position = () => disposed || view.isDestroyed || generation !== instanceGeneration ? undefined : getPos()
        const native = withProxy(proxy, () => factory()(blank, view, position, decorations, innerDecorations))
        native.update?.(node, decorations, innerDecorations)
        return native
      }
      let current = create()
      const dom: HTMLElement = document.createElement(node.isInline ? 'span' : 'div')
      dom.className = 'ttypora-localized-image-view'
      const nativeSlot = document.createElement(node.isInline ? 'span' : 'div')
      nativeSlot.className = 'ttypora-authorized-image-host'
      let attachedSource: string | null = null
      const currentPosition = () => {
        if (disposed || view.isDestroyed || this.imageResourcesDisposed) return undefined
        try {
          const position = getPos()
          return position !== undefined && view.state.doc.nodeAt(position)?.type === node.type ? position : undefined
        } catch { return undefined }
      }
      const linkInput = createImageLinkInput({
        document: view.dom.ownerDocument, inline: node.isInline, source: String(node.attrs.src ?? ''), resolveUrl, uploadFile,
        resourceGeneration: () => this.imageResourceGeneration,
        isCurrent: () => currentPosition() !== undefined,
        isReadonly: () => !view.editable,
        currentSource: () => String(node.attrs.src ?? ''),
        confirm: (source) => {
          const position = currentPosition()
          if (position === undefined || !view.editable) return
          const currentNode = view.state.doc.nodeAt(position)
          if (currentNode?.attrs.src !== source) view.dispatch(view.state.tr.setNodeAttribute(position, 'src', source))
          // A failed or restored same-source reference must be retryable without
          // creating an unchanged document transaction or an undo entry.
          else current.update?.(node, decorations, innerDecorations)
          updatePresentation()
        },
        onDraftChange: () => updatePresentation(),
        t: this.t,
      })
      // No editable upstream ImageInput is connected. It always starts with a
      // blank source and never receives our raw input value or input events.
      // Detached alone would not prevent requests from an img with a raw src.
      dom.append(nativeSlot, linkInput.dom)
      const updatePresentation = () => {
        if (disposed || view.isDestroyed) return
        const viewer = current.dom instanceof Element ? current.dom.querySelector<HTMLImageElement>('img[data-type="image-block"], img.image-inline') : null
        const source = String(node.attrs.src ?? '')
        const authorized = !!viewer?.getAttribute('src') && nativeBinding?.generation === instanceGeneration && nativeBinding.resources === this.imageResourceGeneration && nativeBinding.source === source && viewer.getAttribute('src') === nativeBinding.url
        // Keep an already displayed same-source viewer connected during resource
        // rebinding. Its caption input and Chromium undo history must survive.
        const displayed = !!viewer?.getAttribute('src') && current.dom.parentNode === nativeSlot && attachedSource === source
        const showViewer = (authorized || displayed) && linkInput.input.value === source
        linkInput.setVisible(!showViewer)
        nativeSlot.style.display = showViewer ? '' : 'none'
        if (showViewer) {
          if (current.dom.parentNode !== nativeSlot) {
            nativeSlot.replaceChildren(current.dom)
            // It may have decoded while a different unconfirmed draft kept the
            // native viewer detached. Invoke its public DOM load listener after
            // attachment so native sizing runs with a real host width.
            if (viewer && node.type.name === 'image-block' && viewer.complete && viewer.naturalWidth > 0 && !viewer.dataset.origin) viewer.dispatchEvent(new Event('load'))
          }
          attachedSource = source
        } else {
          if (current.dom.parentNode === nativeSlot) nativeSlot.removeChild(current.dom)
          attachedSource = null
        }
      }
      // This observes native's transition into its public viewer, not a raw-src
      // request followed by a corrective write. The entire Vue host moves.
      const presentationObserver = new MutationObserver(updatePresentation)
      const observePresentation = () => {
        presentationObserver.disconnect()
        presentationObserver.observe(current.dom, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
        updatePresentation()
      }
      observePresentation()
      const resizeWindow = view.dom.ownerDocument.defaultView
      let localeRefreshTimer: number | undefined
      const cancelLocaleRefresh = () => {
        if (localeRefreshTimer !== undefined) resizeWindow?.clearTimeout(localeRefreshTimer)
        localeRefreshTimer = undefined
      }
      let loadSizingTimer: number | undefined
      const cancelLoadSizing = () => {
        if (loadSizingTimer !== undefined) resizeWindow?.clearTimeout(loadSizingTimer)
        loadSizingTimer = undefined
      }
      let activeResize: { image: HTMLImageElement; pointerId: number; width: number; ratio: number } | null = null
      const applyPixelSizing = () => {
        if (disposed || activeResize || node.type.name !== 'image-block' || !(current.dom instanceof Element)) return
        const width = blockImageResizeWidth(node.attrs.resizeWidth)
        if (width === null) return
        const ratio = blockImageRatio(node.attrs.ratio)
        current.dom.querySelectorAll<HTMLImageElement>('img[data-type="image-block"]').forEach((image) => {
          if (!image.naturalWidth || !image.naturalHeight) return
          const height = width * image.naturalHeight / image.naturalWidth
          image.style.width = 'auto'
          image.style.height = `${height}px`
          image.dataset.height = String(height)
          image.dataset.origin = String(height / ratio)
        })
      }
      const syncImageAttributes = () => {
        if (disposed || node.type.name !== 'image-block' || !(current.dom instanceof Element)) return
        current.dom.querySelectorAll<HTMLImageElement>('img[data-type="image-block"]').forEach((image) => {
          const alt = String(node.attrs.alt ?? ''), title = String(node.attrs.caption ?? '')
          // The native viewer uses caption as alt. Keep those separate without
          // changing the document or interfering with Vue's editable caption.
          if (image.alt !== alt) image.alt = alt
          if (image.title !== title) image.title = title
        })
        applyPixelSizing()
      }
      const attributesObserver = new MutationObserver(syncImageAttributes)
      attributesObserver.observe(dom, { subtree: true, childList: true, attributes: true, attributeFilter: ['alt', 'title'] })
      syncImageAttributes()
      const stopResizeTracking = () => {
        activeResize = null
        resizeWindow?.removeEventListener('pointerup', finishResize, true)
        resizeWindow?.removeEventListener('pointercancel', cancelResize, true)
      }
      const cancelResize = () => { stopResizeTracking(); applyPixelSizing() }
      const finishResize = (event: PointerEvent) => {
        const active = activeResize
        if (!active || event.pointerId !== active.pointerId) return
        stopResizeTracking()
        if (disposed || view.isDestroyed || !current.dom.contains(active.image)) return
        const position = getPos(), currentNode = position === undefined ? null : view.state.doc.nodeAt(position)
        if (position === undefined || currentNode?.type !== node.type) return
        const height = Number(active.image.dataset.height), origin = Number(active.image.dataset.origin)
        const ratio = Number.parseFloat((height / origin).toFixed(2))
        const actualWidth = active.image.getBoundingClientRect().width
        // Merely clicking a resize handle must not convert ordinary Markdown.
        if (Math.abs(actualWidth - active.width) < .5 && ratio === active.ratio) { applyPixelSizing(); return }
        const resizeWidth = blockImageResizeWidth(Math.round(actualWidth))
        if (!Number.isFinite(ratio) || ratio !== blockImageRatio(ratio) || resizeWidth === null) return
        if (currentNode.attrs.ratio === ratio && currentNode.attrs.resizeWidth === resizeWidth) return
        // Capture before the native pointerup listener. Both values enter one
        // transaction; its subsequent same-ratio update adds no content change.
        view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...currentNode.attrs, ratio, resizeWidth }, currentNode.marks))
      }
      const beginResize = (event: PointerEvent) => {
        if (disposed || !view.editable || node.type.name !== 'image-block' || event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.image-resize-handle') || !(current.dom instanceof Element)) return
        const image = current.dom.querySelector<HTMLImageElement>('img[data-type="image-block"]')
        if (!image) return
        cancelResize()
        activeResize = { image, pointerId: event.pointerId, width: image.getBoundingClientRect().width, ratio: Number(node.attrs.ratio) }
        resizeWindow?.addEventListener('pointerup', finishResize, true)
        resizeWindow?.addEventListener('pointercancel', cancelResize, true)
      }
      dom.addEventListener('pointerdown', beginResize, true)
      const onImageLoad = (event: Event) => {
        if (!(event.target instanceof HTMLImageElement) || event.target.dataset.type !== 'image-block') return
        cancelLoadSizing()
        // Native load events can run a microtask checkpoint between capture and
        // target listeners. Restore pixels in the next task, after Vue's onLoad
        // has finished writing its intrinsic-size ratio to the image styles.
        loadSizingTimer = resizeWindow?.setTimeout(() => { loadSizingTimer = undefined; applyPixelSizing() }, 0)
      }
      dom.addEventListener('load', onImageLoad, true)
      const refresh = () => {
        if (disposed || view.isDestroyed) return
        linkInput.refreshLocale()
        const pendingCaption = current.dom instanceof Element ? current.dom.querySelector<HTMLInputElement>('input.caption-input') : null
        if (pendingCaption && pendingCaption.value !== String(node.attrs.caption ?? '')) {
          // Keep the original native timer/input until its draft has committed.
          // Repeated locale notifications then share the same pending edit.
          if (localeRefreshTimer === undefined) localeRefreshTimer = resizeWindow?.setTimeout(() => { localeRefreshTimer = undefined; refresh() }, 25)
          return
        }
        cancelLocaleRefresh()
        cancelLoadSizing()
        cancelResize()
        const oldDom = current.dom
        const inputs = oldDom instanceof Element ? ['input.caption-input', 'input.link-input-area'].flatMap((selector) => {
          const input = oldDom.querySelector<HTMLInputElement>(selector)
          // Preserve an unfinished text edit by semantic role, never by DOM index.
          // Range/file controls and untouched values must not generate transactions.
          if (!input || document.activeElement !== input && this.focusedElement !== input) return []
          return [{ selector, value: input.value, from: input.selectionStart, to: input.selectionEnd, direction: input.selectionDirection, active: document.activeElement === input, remembered: this.focusedElement === input }]
        }) : []
        presentationObserver.disconnect()
        current.destroy?.()
        current = create()
        attachedSource = null
        nativeSlot.replaceChildren()
        observePresentation()
        if (selected) current.selectNode?.()
        const replacement = current
        const expandedCaptionControls = new WeakSet<Element>()
        const restoreInputs = () => {
          if (disposed || current !== replacement || !(current.dom instanceof Element)) return
          inputs.forEach((saved) => {
            const input = current.dom.querySelector<HTMLInputElement>(saved.selector)
            if (!input) {
              // The native viewer initially hides an empty caption. Restore its
              // opened UI state through its toggle without changing the node.
              const control = saved.selector === 'input.caption-input' ? current.dom.querySelector('.image-wrapper .operation-item') : null
              if (control && !expandedCaptionControls.has(control)) { expandedCaptionControls.add(control); control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) }
              return
            }
            if (input.value !== saved.value) { input.value = saved.value; input.dispatchEvent(new Event('input', { bubbles: true })) }
            if (saved.from !== null && saved.to !== null) input.setSelectionRange(saved.from, saved.to, saved.direction ?? undefined)
            if (saved.remembered) this.focusedElement = input
            if (saved.active) input.focus()
          })
        }
        // Vue replaces the placeholder after the authorized image URL resolves.
        // Observe only this atomic view so a pending caption can survive that turn.
        if (inputs.length) {
          const observer = new MutationObserver(() => { restoreInputs(); if (inputs.every(({ selector }) => current.dom instanceof Element && current.dom.querySelector(selector))) observer.disconnect() })
          observer.observe(current.dom, { childList: true, subtree: true })
          const disconnect = () => observer.disconnect()
          view.dom.ownerDocument.defaultView?.queueMicrotask(restoreInputs)
          const previousDestroy = current.destroy
          current.destroy = () => { disconnect(); previousDestroy?.() }
        }
      }
      this.imageLocaleUpdates.add(refresh)
      const refreshResource = () => {
        if (disposed || view.isDestroyed) return
        linkInput.refreshResources()
        current.update?.(node, decorations, innerDecorations)
        applyPixelSizing()
      }
      this.imageResourceUpdates.add(refreshResource)
      const hasPendingCaption = (source: string) => {
        if (disposed || node.type.name !== 'image-block' || node.attrs.src !== source || !(current.dom instanceof Element)) return false
        const input = current.dom.querySelector<HTMLInputElement>('input.caption-input')
        return !!input && (document.activeElement === input || this.focusedElement === input) && input.value !== String(node.attrs.caption ?? '')
      }
      this.imageDraftChecks.add(hasPendingCaption)
      return {
        dom,
        update: (next, nextDecorations, nextInnerDecorations) => {
          if (next.type !== node.type || current.update && !current.update(next, nextDecorations, nextInnerDecorations)) return false
          node = next; decorations = nextDecorations; innerDecorations = nextInnerDecorations
          linkInput.updateSource(String(node.attrs.src ?? '')); updatePresentation(); syncImageAttributes(); return true
        },
        selectNode: () => { selected = true; linkInput.setSelected(true); current.selectNode?.() },
        deselectNode: () => { selected = false; linkInput.setSelected(false); current.deselectNode?.() },
        stopEvent: (event) => linkInput.stopEvent(event) || (current.stopEvent?.(event) ?? false),
        ignoreMutation: (mutation) => current.ignoreMutation?.(mutation) ?? mutation.type !== 'selection',
        destroy: () => { disposed = true; cancelLocaleRefresh(); cancelLoadSizing(); cancelResize(); dom.removeEventListener('pointerdown', beginResize, true); dom.removeEventListener('load', onImageLoad, true); attributesObserver.disconnect(); presentationObserver.disconnect(); this.imageLocaleUpdates.delete(refresh); this.imageResourceUpdates.delete(refreshResource); this.imageDraftChecks.delete(hasPendingCaption); if (this.focusedElement && dom.contains(this.focusedElement)) this.focusedElement = null; linkInput.destroy(); current.destroy?.() },
      }
    }
  }

  private withEditorView<T>(run: (view: EditorView) => T): T {
    return this.crepe.editor.action((ctx) => run(ctx.get(editorViewCtx)))
  }

  private getSearchSummary(
    state: EditorState,
  ): EditorSearchSummary {
    if (!this.searchQuery.valid || !this.searchQuery.search) {
      return { count: 0, current: 0, valid: this.searchQuery.valid }
    }

    const matches: Array<{ from: number; to: number }> = []
    const limit = state.doc.content.size
    let position = 0
    while (position <= limit) {
      const match = this.searchQuery.findNext(state, position, limit)
      if (!match) break
      matches.push(match)
      const nextPosition = Math.max(match.to, match.from + 1)
      if (nextPosition <= position) break
      position = nextPosition
    }
    const selection = state.selection
    const current = matches.findIndex(
      (match) => match.from === selection.from && match.to === selection.to,
    )
    return {
      count: matches.length,
      current: current >= 0 ? current + 1 : 0,
      valid: true,
    }
  }

  async destroy(): Promise<void> {
    this.markdownSerialization.clear()
    this.imageResourcesDisposed = true
    this.imageResourceGeneration++
    this.clipboardContentSerializer = null
    this.codePreferences.destroy()
    this.tableClipboard.reset()
    // Stop DOM observers and node-view callbacks before Crepe removes their configuration contexts.
    const created = this.created
    this.created = false
    this.headingDocument = null
    this.headingPositions = []
    this.publishedHeadingIndex = undefined
    window.removeEventListener('ttypora:interface-language', this.refreshLocale)
    this.root.removeEventListener('focusin', this.rememberFocus)
    this.focusedElement = null
    if (created) this.withEditorView((view) => view.destroy())
    this.imageLocaleUpdates.clear()
    this.imageResourceUpdates.clear()
    this.imageDraftChecks.clear()
    this.htmlResourceUpdates.clear()
    await this.crepe.destroy()
  }
}
