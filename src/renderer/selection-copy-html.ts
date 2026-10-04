import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'
import type { Root, RootContent, Element } from 'hast'
import type { Preferences } from '../shared/preferences'
import { renderDocumentHtml } from './export-document'
import type { SelectionFragment } from './editor/selection-fragment'

const blocks = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'div', 'aside', 'section', 'nav', 'dl', 'dt', 'dd', 'table'])
const classNames = (node: Element) => Array.isArray(node.properties.className) ? node.properties.className.map(String) : []
const find = (node: Root | RootContent, predicate: (node: Element) => boolean): Element | undefined => {
  if (node.type === 'element' && predicate(node)) return node
  if ('children' in node) for (const child of node.children) { const result = find(child, predicate); if (result) return result }
  return undefined
}

/** Offline AST traversal: no DOMParser document or image/browser loads. */
export function readableClipboardHtml(html: string): string {
  const tree = fromHtml(html, { fragment: true })
  const join = (children: readonly RootContent[]): string => {
    let value = '', previousBlock = false
    const blockContainer = children.some((child) => child.type === 'element' && blocks.has(child.tagName))
    for (const child of children) {
      if (blockContainer && child.type === 'text' && child.value.trim() === '') continue
      const content = text(child), block = child.type === 'element' && blocks.has(child.tagName)
      if (value && content && (block || previousBlock)) value += value.endsWith('\n') || content.startsWith('\n') ? '\n' : '\n\n'
      value += content; previousBlock = block
    }
    return value
  }
  const text = (node: Root | RootContent): string => {
    if (node.type === 'text') return node.value
    if (node.type !== 'element' && node.type !== 'root') return ''
    if (node.type === 'element') {
      if (['script', 'style', 'noscript'].includes(node.tagName) || classNames(node).some((name) => /(?:line-number|line-numbers)/.test(name))) return ''
      if (node.tagName === 'br') return '\n'
      if (node.tagName === 'img') return String(node.properties.alt || node.properties.src || '')
      if (classNames(node).includes('katex')) {
        const source = find(node, (child) => child.tagName === 'annotation' && child.properties.encoding === 'application/x-tex')
        if (source) return source.children.filter((child) => child.type === 'text').map((child) => child.value).join('')
      }
      if (node.tagName === 'table') {
        const rows: Element[] = []
        const collect = (child: RootContent) => { if (child.type === 'element' && child.tagName === 'tr') rows.push(child); else if ('children' in child) child.children.forEach(collect) }
        node.children.forEach(collect)
        return rows.map((row) => row.children.filter((child) => child.type === 'element' && ['td', 'th'].includes(child.tagName)).map(text).join('\t')).join('\n')
      }
    }
    return join(node.children)
  }
  return text(tree)
}

/** Resource preparation may add an HTML shell; copy only its offline body. */
export function clipboardBodyFragment(html: string): string {
  const body = find(fromHtml(html), (node) => node.tagName === 'body')
  if (!body) throw new Error('Selection HTML body missing')
  const children = [...body.children]
  while (children[0]?.type === 'text' && children[0].value.trim() === '') children.shift()
  for (;;) { const last = children.at(-1); if (last?.type !== 'text' || last.value.trim() !== '') break; children.pop() }
  return toHtml({ type: 'root', children })
}

export async function renderSelectionFragment(fragment: SelectionFragment, preferences: Preferences): Promise<{ html: string; text: string }> {
  if (fragment.kind === 'literal' || fragment.kind === 'source' && fragment.markdown.trim() === '') {
    const html = toHtml({ type: 'root', children: [{ type: 'element', tagName: 'pre', properties: {}, children: [{ type: 'text', value: fragment.markdown }] }] })
    return { html, text: fragment.plain }
  }
  const document = await renderDocumentHtml(fragment.markdown, '', { unstyled: true, preferences })
  const html = clipboardBodyFragment(document)
  return { html, text: fragment.kind === 'source' ? readableClipboardHtml(html) : fragment.plain }
}
