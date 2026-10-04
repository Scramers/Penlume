import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import type { Element, ElementContent, Root, RootContent } from 'hast'
import type { Code, Root as MarkdownRoot } from 'mdast'

// These limits bound optional presentation work, not the document's contents.
export const maxHighlightedBlockLength = 200_000
export const maxHighlightedDocumentLength = 1_000_000
export const maxNumberedLines = 10_000

export function protectLiteralMathCode() {
  return (tree: MarkdownRoot) => {
    const visit = (node: { type: string; children?: unknown[] }) => {
      const code = node as Code
      if (code.type === 'code' && code.lang === 'math') {
        code.data = { ...code.data, hProperties: { ...code.data?.hProperties, className: ['language-ttypora-literal-math'] } }
      }
      node.children?.forEach((child) => visit(child as typeof node))
    }
    visit(tree)
  }
}

function text(value: string): ElementContent { return { type: 'text', value } }

/** Produces only text and trusted span nodes. Source code is never parsed as HTML. */
export async function highlightExportCode(value: string, language: string): Promise<ElementContent[]> {
  if (value.length > maxHighlightedBlockLength) return [text(value)]
  const description = LanguageDescription.matchLanguageName(languages, language, false)
  if (!description) return [text(value)]
  try {
    const support = await description.load()
    const tree = support.language.parser.parse(value)
    const children: ElementContent[] = []
    let cursor = 0
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      if (from > cursor) children.push(text(value.slice(cursor, from)))
      children.push({ type: 'element', tagName: 'span', properties: { className: classes.split(' ') }, children: [text(value.slice(from, to))] })
      cursor = to
    })
    if (cursor < value.length) children.push(text(value.slice(cursor)))
    return children.length ? children : [text(value)]
  } catch {
    // A missing or failing language module must never prevent export.
    return [text(value)]
  }
}

function numberedLines(children: ElementContent[]): ElementContent[] {
  const lines: Element[] = []
  let line: Element = { type: 'element', tagName: 'span', properties: { className: ['code-export-line'], dataLine: 1 }, children: [] }
  const append = (node: ElementContent) => {
    const value = node.type === 'text' ? node.value : node.type === 'element' && node.children[0]?.type === 'text' ? node.children[0].value : ''
    const parts = value.match(/[^\n]*\n|[^\n]+$/g) ?? []
    for (const part of parts) {
      line.children.push(node.type === 'element' ? { ...node, properties: { ...node.properties }, children: [text(part)] } : text(part))
      if (part.endsWith('\n')) {
        lines.push(line)
        line = { type: 'element', tagName: 'span', properties: { className: ['code-export-line'], dataLine: lines.length + 1 }, children: [] }
      }
    }
  }
  children.forEach(append)
  if (line.children.length || !lines.length) lines.push(line)
  return lines
}

export function rehypeExportCode(options: { wrap?: boolean; lineNumbers?: boolean } = {}) {
  return async (tree: Root) => {
    let remaining = maxHighlightedDocumentLength
    const blocks: { pre: Element; code: Element; value: string; language: string }[] = []
    const visit = (node: Root | RootContent) => {
      if (node.type === 'element' && node.tagName === 'pre') {
        const code = node.children.length === 1 && node.children[0].type === 'element' && node.children[0].tagName === 'code' ? node.children[0] : null
        if (code && code.children.every((child) => child.type === 'text')) {
          const classes = Array.isArray(code.properties.className) ? code.properties.className.map(String) : []
          if (classes.includes('language-ttypora-literal-math')) {
            classes[classes.indexOf('language-ttypora-literal-math')] = 'language-math'
            code.properties.className = classes
          }
          const language = classes.find((value) => value.startsWith('language-'))?.slice(9) ?? ''
          if (!classes.includes('math-display') && !classes.includes('math-inline') && language !== 'mermaid') {
            blocks.push({ pre: node, code, value: code.children.map((child) => child.type === 'text' ? child.value : '').join(''), language })
          }
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
    // Sequential work keeps large documents from launching dozens of parsers at once.
    for (const { pre, code, value, language } of blocks) {
      const highlighted = value.length <= remaining ? await highlightExportCode(value, language) : [text(value)]
      remaining = Math.max(0, remaining - value.length)
      const numbers = options.lineNumbers && value.length <= maxHighlightedBlockLength && (value.match(/\n/g)?.length ?? 0) <= maxNumberedLines
      code.children = numbers ? numberedLines(highlighted) : highlighted
      const classes = Array.isArray(pre.properties.className) ? pre.properties.className : []
      pre.properties.className = [...classes, 'code-export', ...(options.wrap === false ? [] : ['code-export-wrap']), ...(numbers ? ['code-export-numbered'] : [])]
    }
  }
}

export const exportCodeCss = `
.code-export { position: relative; tab-size: var(--code-tab-size, 2); }
.code-export code { display: block; }
.code-export-wrap code { white-space: pre-wrap; overflow-wrap: anywhere; }
.code-export-numbered { padding-left: 4.2em; }
.code-export-line { position: relative; }
.code-export-line::before { content: attr(data-line); position: absolute; left: -3.2em; width: 2.2em; text-align: right; color: var(--muted, #76818d); user-select: none; }
.code-export .tok-keyword, .code-export .tok-bool, .code-export .tok-atom { color: color-mix(in srgb, var(--text, #242424) 45%, #9668bf); }
.code-export .tok-string, .code-export .tok-string2, .code-export .tok-inserted { color: color-mix(in srgb, var(--text, #242424) 45%, #39a56d); }
.code-export .tok-number, .code-export .tok-literal { color: color-mix(in srgb, var(--text, #242424) 45%, #cb7736); }
.code-export .tok-comment { color: var(--muted, #697988); font-style: italic; }
.code-export .tok-typeName, .code-export .tok-className, .code-export .tok-namespace { color: color-mix(in srgb, var(--text, #242424) 45%, #c29423); }
.code-export .tok-variableName2, .code-export .tok-propertyName, .code-export .tok-labelName { color: color-mix(in srgb, var(--text, #242424) 45%, #368dc5); }
.code-export .tok-meta, .code-export .tok-macroName { color: color-mix(in srgb, var(--text, #242424) 45%, #b56f9f); }
.code-export .tok-invalid, .code-export .tok-deleted { color: color-mix(in srgb, var(--text, #242424) 45%, #d9564e); }
@media print { .code-export code { white-space: pre-wrap; overflow-wrap: anywhere; } .code-export { overflow: visible; } }
`
