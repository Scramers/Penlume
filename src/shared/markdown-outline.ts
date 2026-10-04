import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import remarkInlineLinks from 'remark-inline-links'
import { remarkEditorExtensions } from './markdown-extensions'
import type { MarkdownExtensionOptions } from './preferences'

export interface MarkdownHeading {
  level: number
  line: number
  text: string
}

interface OutlineNode {
  type: string
  value?: string
  depth?: number
  alt?: string
  label?: string
  identifier?: string
  children?: OutlineNode[]
  position?: { start: { line: number } }
}

/** Match the installed visual-editor HTML/break preprocessing BEFORE extension
 * pairing/alert conversion. Milkdown removes exactly these HTML break spellings;
 * the application's tableLineBreakCompatibility replaces soft text newlines
 * outside table cells, with positionless text/break nodes. Both can affect the
 * alert transform (including whether it removes a heading), so label-only
 * cleanup or collecting the untransformed parse tree would give wrong indexes.
 * Keep the real Milkdown pipeline comparison tests when upgrading those plugins.
 */
function remarkVisualOutlineCompatibility() {
  return (tree: unknown) => {
    const root = tree as OutlineNode
    const wrapBlockHtml = (parent: OutlineNode) => {
      parent.children?.forEach((node) => {
        wrapBlockHtml(node)
        if (node.type !== 'html' || !['root', 'blockquote', 'listItem'].includes(parent.type)) return
        node.children = [{ ...node }]
        delete node.value
        node.type = 'paragraph'
      })
    }
    const removeEmptyBreaks = (parent: OutlineNode) => {
      if (!parent.children) return
      parent.children = parent.children.filter((node) => !(
        node.type === 'html' && ['<br />', '<br>', '<br >', '<br/>'].includes(node.value?.trim() ?? '')
      ))
      parent.children.forEach(removeEmptyBreaks)
    }
    const splitSoftBreaks = (parent: OutlineNode) => {
      if (parent.type === 'tableCell' || !parent.children) return
      parent.children = parent.children.flatMap((node) => {
        if (node.type !== 'text' || !node.value) { splitSoftBreaks(node); return [node] }
        const result: OutlineNode[] = []
        const pattern = /[\t ]*(?:\r?\n|\r)/g
        let start = 0
        for (const match of node.value.matchAll(pattern)) {
          if (start !== match.index) result.push({ type: 'text', value: node.value.slice(start, match.index) })
          result.push({ type: 'break' })
          start = match.index! + match[0].length
        }
        if (!result.length) return [node]
        if (start < node.value.length) result.push({ type: 'text', value: node.value.slice(start) })
        return result
      })
    }
    wrapBlockHtml(root)
    removeEmptyBreaks(root)
    splitSoftBreaks(root)
  }
}

const outlineParser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })
  .use(remarkMath).use(remarkFrontmatter).use(remarkInlineLinks).use(remarkVisualOutlineCompatibility)

/** A label is a readable projection, not a heading identity or PM textContent:
 * code stays literal, math uses TeX, emoji uses its glyph, images use alt text,
 * and unpaired inline HTML stays literal as the installed Milkdown HTML node does.
 * Parsed text has already decoded escapes/entities; never decode it a second time.
 */
function headingText(node: OutlineNode): string {
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if (node.type === 'footnoteReference') return node.label ?? node.identifier ?? ''
  if (node.type === 'break') return ' '
  if (node.children) return node.children.map(headingText).join('')
  return node.value ?? ''
}

/** Synchronous canonical extraction for a worker or an explicit navigation action.
 * Do not call this on the renderer's ordinary source input/selection path: remark
 * parses the complete document. Source positions use the original one-based line;
 * nested containers, multi-line Setext and metadata retain their true start lines.
 * Preorder matches PM heading traversal. Empty/repeated labels still occupy indexes.
 */
export function extractMarkdownHeadings(markdown: string, options: Partial<MarkdownExtensionOptions> = {}): MarkdownHeading[] {
  const processor = outlineParser().use(remarkEditorExtensions, options)
  const tree = processor.runSync(processor.parse(markdown), markdown) as unknown as OutlineNode
  const headings: MarkdownHeading[] = []
  const visit = (node: OutlineNode) => {
    if (node.type === 'heading') headings.push({
      level: node.depth!, line: node.position!.start.line, text: headingText(node).trim(),
    })
    node.children?.forEach(visit)
  }
  visit(tree)
  return headings
}
