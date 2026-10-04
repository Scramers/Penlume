import { $node, $remark, $view, $prose, $mark, $inputRule } from '@milkdown/kit/utils'
import { markRule } from '@milkdown/kit/prose'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import remarkFrontmatter from 'remark-frontmatter'
import { renderHtmlMediaPreview, type ResourceResolver } from './media-preview'
import '../styles/media.css'
import { readInterfaceLanguage } from '../localization'
import { translate } from '../../shared/localization'
import { remarkEditorExtensions, uniqueHeadingIds } from '../../shared/markdown-extensions'
import { defaultMarkdownExtensions, type MarkdownExtensionOptions } from '../../shared/preferences'
import { completeEmoji, emojiForShortcode, type EmojiEntry } from '../../shared/emoji-shortcodes'

const frontMatter = $remark('ttyporaFrontmatter', () => remarkFrontmatter, ['yaml'])

const yamlNode = $node('front_matter', () => ({
  group: 'block', content: 'text*', marks: '', code: true, defining: true,
  parseDOM: [{ tag: 'pre[data-front-matter]', preserveWhitespace: 'full' }],
  toDOM: () => ['pre', { 'data-front-matter': 'true', class: 'front-matter-source' }, 0],
  parseMarkdown: {
    match: (node) => node.type === 'yaml',
    runner: (state, node, type) => { state.openNode(type); if (node.value) state.addText(String(node.value)); state.closeNode() },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'front_matter',
    runner: (state, node) => { state.addNode('yaml', undefined, node.textContent) },
  },
}))

const yamlView = $view(yamlNode, () => () => {
  const dom = document.createElement('details')
  dom.className = 'front-matter'
  dom.open = true
  const summary = document.createElement('summary')
  summary.textContent = 'YAML Front Matter'
  summary.contentEditable = 'false'
  const contentDOM = document.createElement('pre')
  contentDOM.className = 'front-matter-source'
  dom.append(summary, contentDOM)
  return { dom, contentDOM, ignoreMutation: (mutation) => mutation.type === 'attributes' && mutation.target === dom }
})

const tocNode = $node('document_toc', () => ({
  group: 'block', atom: true,
  parseDOM: [{ tag: 'nav[data-toc]' }],
  toDOM: () => ['nav', { 'data-toc': 'true', class: 'document-toc', contenteditable: 'false' }, '目录'],
  parseMarkdown: { match: (node) => node.type === 'ttyporaToc', runner: (state, _node, type) => { state.addNode(type) } },
  toMarkdown: { match: (node) => node.type.name === 'document_toc', runner: (state) => { state.addNode('html', undefined, '[TOC]') } },
}))

const tocRenderers = new WeakMap<EditorView, Set<() => void>>()
const tocView = $view(tocNode, () => (_node, view) => {
  const dom = document.createElement('nav')
  dom.dataset.toc = 'true'
  dom.className = 'document-toc'
  dom.contentEditable = 'false'
  const render = () => {
    const headings: Array<{ text: string; level: number }> = []
    view.state.doc.descendants((node) => { if (node.type.name === 'heading') headings.push({ text: node.textContent, level: node.attrs.level }) })
    const ids = uniqueHeadingIds(headings.map((heading) => heading.text))
    dom.replaceChildren()
    headings.forEach((heading, index) => { const link = document.createElement('a'); link.href = `#${ids[index]}`; link.textContent = heading.text; link.className = `toc-level-${heading.level}`; dom.append(link) })
    if (!headings.length) dom.textContent = translate(readInterfaceLanguage(), '添加标题后将在这里显示目录')
  }
  const renderers = tocRenderers.get(view) ?? new Set<() => void>()
  renderers.add(render)
  tocRenderers.set(view, renderers)
  render()
  window.addEventListener('ttypora:interface-language', render)
  return { dom, ignoreMutation: () => true, update: (node) => { if (node.type.name !== 'document_toc') return false; render(); return true }, destroy: () => { renderers.delete(render); window.removeEventListener('ttypora:interface-language', render) } }
})

const alertNode = $node('markdown_alert', () => ({
  group: 'block', content: 'block+', defining: true,
  attrs: { kind: { default: 'NOTE' } },
  parseDOM: [{ tag: 'aside[data-alert]', getAttrs: (dom) => ({ kind: dom.getAttribute('data-alert') }) }],
  toDOM: (node) => ['aside', { 'data-alert': node.attrs.kind, class: `markdown-alert markdown-alert-${String(node.attrs.kind).toLowerCase()}` }, ['strong', { contenteditable: 'false' }, node.attrs.kind], ['div', 0]],
  parseMarkdown: { match: (node) => node.type === 'ttyporaAlert', runner: (state, node, type) => { state.openNode(type, { kind: node.kind }); state.next(node.children?.length ? node.children : [{ type: 'paragraph', children: [] }]); state.closeNode() } },
  toMarkdown: { match: (node) => node.type.name === 'markdown_alert', runner: (state, node) => {
    state.openNode('blockquote'); state.addNode('html', undefined, `[!${node.attrs.kind}]`); state.next(node.content); state.closeNode()
  } },
}))

const htmlNode = $node('html_block', () => ({
  group: 'block', atom: true, attrs: { value: { default: '' } },
  parseDOM: [{ tag: 'div[data-html-source]', getAttrs: (dom) => ({ value: dom.getAttribute('data-html-source') }) }],
  toDOM: (node) => ['div', { 'data-html-source': node.attrs.value }, node.attrs.value],
  parseMarkdown: { match: (node) => node.type === 'ttyporaHtmlBlock', runner: (state, node, type) => { state.addNode(type, { value: node.value }) } },
  toMarkdown: { match: (node) => node.type.name === 'html_block', runner: (state, node) => { state.addNode('html', undefined, node.attrs.value) } },
}))

const createHtmlView = (resolveImageUrl: ResourceResolver, resolveMediaUrl: ResourceResolver, registerResourceRefresh: (refresh: () => void) => () => void) => $view(htmlNode, () => (node, view, getPos) => {
  const dom = document.createElement('div')
  dom.className = 'html-block'
  const preview = document.createElement('div')
  const input = document.createElement('textarea')
  input.dataset.htmlSourceEditor = 'true'
  input.value = String(node.attrs.value)
  const details = document.createElement('details')
  details.className = 'html-source'
  details.open = !/<(?:audio|video)\b/i.test(input.value)
  const summary = document.createElement('summary')
  const localize = () => { const label = translate(readInterfaceLanguage(), 'HTML 源码'); input.setAttribute('aria-label', label); summary.textContent = label }
  localize()
  window.addEventListener('ttypora:interface-language', localize)
  details.append(summary, input)
  let generation = 0, disposed = false, rendered = ''
  let clearPreview = () => undefined as void
  const render = () => {
    const current = ++generation
    clearPreview()
    rendered = input.value
    clearPreview = renderHtmlMediaPreview(preview, input.value, resolveImageUrl, resolveMediaUrl, () => !disposed && current === generation)
  }
  render()
  const unregisterResourceRefresh = registerResourceRefresh(render)
  input.addEventListener('input', () => {
    const position = getPos()
    if (typeof position === 'number') view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { value: input.value }))
    if (rendered !== input.value) render()
  })
  dom.append(preview, details)
  return { dom, stopEvent: (event) => event.target instanceof Element && Boolean(event.target.closest('textarea,summary,button,audio,video')), ignoreMutation: () => true,
    update: (next) => { if (next.type !== node.type) return false; input.value = String(next.attrs.value); if (rendered !== input.value) render(); return true },
    destroy: () => { disposed = true; generation++; unregisterResourceRefresh(); clearPreview(); window.removeEventListener('ttypora:interface-language', localize) },
  }
})

const navigation = $prose(() => new Plugin({
  view: (view) => {
    const update = () => {
      const headings = Array.from(view.dom.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
      const ids = uniqueHeadingIds(headings.map((heading) => heading.textContent ?? ''))
      headings.forEach((heading, index) => { if (heading.id !== ids[index]) heading.id = ids[index] })
      tocRenderers.get(view)?.forEach((render) => render())
    }
    let frame = requestAnimationFrame(update)
    return { update: (current, previous) => { if (!current.state.doc.eq(previous.doc)) { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) } }, destroy: () => cancelAnimationFrame(frame) }
  },
  props: { handleClick: (view, _position, event) => {
    const target = event.target as HTMLElement
    const reference = target.closest<HTMLElement>('sup[data-type="footnote_reference"]')
    if (reference) {
      const definition = Array.from(view.dom.querySelectorAll<HTMLElement>('dl[data-type="footnote_definition"]')).find((item) => item.dataset.label === reference.dataset.label)
      definition?.scrollIntoView({ block: 'center' }); return true
    }
    return false
  } },
}))

const inlineDefinitions = [
  { id: 'highlight', type: 'ttyporaHighlight', tag: 'mark', rule: /(?<![=\\])==([^=\n]+)==$/ },
  { id: 'superscript', type: 'ttyporaSuperscript', tag: 'sup', rule: /(?<![\^\\])\^((?:\\[ \t]|[^\s^])+)\^$/ },
  { id: 'subscript', type: 'ttyporaSubscript', tag: 'sub', rule: /(?<![~\\])~((?:\\[ \t]|[^\s~])+)~$/ },
  { id: 'underline', type: 'ttyporaUnderline', tag: 'u', rule: /<u>([^\n]+)<\/u>$/ },
] as const

const emojiNode = $node('emoji', () => ({
  inline: true, group: 'inline', atom: true,
  attrs: { name: { default: 'smile' }, value: { default: '😄' } },
  leafText: (node) => String(node.attrs.value),
  parseDOM: [{ tag: 'span[data-emoji]', getAttrs: (dom) => { const entry = emojiForShortcode(dom.getAttribute('data-emoji') ?? ''); return entry ? { name: entry.name, value: entry.emoji } : false } }],
  toDOM: (node) => ['span', { 'data-emoji': node.attrs.name, title: `:${node.attrs.name}:`, class: 'markdown-emoji', role: 'img', 'aria-label': node.attrs.name }, node.attrs.value],
  parseMarkdown: { match: (node) => node.type === 'ttyporaEmoji', runner: (state, node, type) => { state.addNode(type, { name: node.name, value: node.value }) } },
  toMarkdown: { match: (node) => node.type.name === 'emoji', runner: (state, node) => { state.addNode('ttyporaEmoji', undefined, node.attrs.value, { name: node.attrs.name }) } },
}))

function emojiCompletion() {
  let entries: EmojiEntry[] = [], start = 0, end = 0, selected = 0, dismissedAt = -1
  let popup: HTMLElement | null = null
  const choose = (view: EditorView, entry: EmojiEntry) => {
    const node = view.state.schema.nodes.emoji.create({ name: entry.name, value: entry.emoji })
    view.dispatch(view.state.tr.replaceWith(start, end, node).scrollIntoView())
    view.focus()
  }
  return $prose(() => new Plugin({
    view: (view) => {
      popup = document.createElement('div')
      popup.className = 'emoji-completions'
      popup.setAttribute('role', 'listbox')
      const localize = () => popup?.setAttribute('aria-label', translate(readInterfaceLanguage(), 'Emoji 自动补全'))
      localize()
      window.addEventListener('ttypora:interface-language', localize)
      Object.assign(popup.style, { display: 'none', position: 'fixed', zIndex: '1500', minWidth: '230px', maxHeight: '320px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--surface)', color: 'var(--text)', boxShadow: '0 12px 35px #0003', padding: '6px' })
      document.body.append(popup)
      const render = () => {
        if (!popup) return
        const { selection } = view.state
        const parent = selection.$from.parent
        const code = parent.type.spec.code || selection.$from.marks().some((mark) => mark.type.spec.code)
        const match = selection.empty && !code && view.hasFocus() && parent.isTextblock ? parent.textBetween(0, selection.$from.parentOffset, '', '\ufffc').match(/(?:^|[^\w/\\]):([\w+-]{1,40})$/) : null
        if (!match || selection.from === dismissedAt) { entries = []; popup.style.display = 'none'; return }
        const nextStart = selection.from - match[1].length - 1
        if (nextStart !== start || selection.from !== end) selected = 0
        start = nextStart; end = selection.from; entries = completeEmoji(match[1])
        if (!entries.length) { popup.style.display = 'none'; return }
        selected = Math.min(selected, entries.length - 1)
        popup.replaceChildren(...entries.map((entry, index) => {
          const button = document.createElement('button')
          button.type = 'button'; button.role = 'option'; button.setAttribute('aria-selected', String(index === selected)); button.tabIndex = -1
          button.textContent = `${entry.emoji}  :${entry.name}:`; button.title = entry.description
          Object.assign(button.style, { display: 'block', width: '100%', textAlign: 'left', border: '0', borderRadius: '6px', padding: '7px 10px', background: index === selected ? 'var(--accent-soft, #e8e7ff)' : 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '14px' })
          button.addEventListener('mousedown', (event) => { event.preventDefault(); choose(view, entry) })
          return button
        }))
        const coordinates = view.coordsAtPos(selection.from)
        popup.style.left = `${Math.min(coordinates.left, window.innerWidth - 280)}px`
        popup.style.top = `${Math.min(coordinates.bottom + 8, Math.max(8, window.innerHeight - 326))}px`
        popup.style.display = 'block'
      }
      const blur = () => { if (popup) popup.style.display = 'none'; entries = [] }
      view.dom.addEventListener('blur', blur)
      return { update: render, destroy: () => { view.dom.removeEventListener('blur', blur); window.removeEventListener('ttypora:interface-language', localize); popup?.remove(); popup = null; entries = [] } }
    },
    props: { handleKeyDown: (view, event) => {
      if (!entries.length || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false
      if (event.key === 'Escape') { dismissedAt = view.state.selection.from; entries = []; if (popup) popup.style.display = 'none'; return true }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        selected = (selected + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length
        popup?.querySelectorAll<HTMLElement>('[role=option]').forEach((button, index) => { button.setAttribute('aria-selected', String(index === selected)); button.style.background = index === selected ? 'var(--accent-soft, #e8e7ff)' : 'transparent'; if (index === selected) button.scrollIntoView({ block: 'nearest' }) })
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') { choose(view, entries[selected]); return true }
      return false
    } },
  }))
}

export function createMarkdownExtensions(input: Partial<MarkdownExtensionOptions> = {}, resolveImageUrl: ResourceResolver = (source) => source, resolveMediaUrl: ResourceResolver = () => { throw new Error('媒体路径没有得到授权。') }, registerResourceRefresh: (refresh: () => void) => () => void = () => () => {}) {
  const options = { ...defaultMarkdownExtensions, ...input }
  const extensions = $remark('ttyporaExtensions', () => remarkEditorExtensions, options)
  const inline = inlineDefinitions.flatMap((definition) => {
    const mark = $mark(definition.id, () => ({
      parseDOM: [{ tag: definition.tag }],
      toDOM: () => [definition.tag, { class: `markdown-${definition.id}` }, 0],
      parseMarkdown: { match: (node) => node.type === definition.type, runner: (state, node, type) => { state.openMark(type); state.next(node.children); state.closeMark(type) } },
      toMarkdown: { match: (mark) => mark.type.name === definition.id, runner: (state, mark) => { state.withMark(mark, definition.type) } },
    }))
    return options[definition.id] ? [mark, $inputRule((ctx) => markRule(definition.rule, mark.type(ctx), {
      beforeDispatch: ({ match, start, tr }) => {
        if (definition.id !== 'superscript' && definition.id !== 'subscript') return
        const escapes = [...match[1].matchAll(/\\(?=[ \t])/g)]
        escapes.reverse().forEach((escape) => tr.delete(start + escape.index!, start + escape.index! + 1))
      },
    }))] : [mark]
  })
  const emojiInput = $inputRule((ctx) => new InputRule(/(?<![\w/\\]):([\w+-]+):$/, (state, match, start, end) => {
    const entry = emojiForShortcode(match[1])
    if (!entry) return null
    return state.tr.replaceWith(start, end, emojiNode.type(ctx).create({ name: entry.name, value: entry.emoji }))
  }, { inCode: false, inCodeMark: false }))
  return [frontMatter, extensions, yamlNode, yamlView, tocNode, tocView, alertNode, htmlNode, createHtmlView(resolveImageUrl, resolveMediaUrl, registerResourceRefresh), navigation, ...inline, emojiNode, ...(options.emoji ? [emojiInput, ...(options.emojiCompletion ? [emojiCompletion()] : [])] : [])].flat()
}
