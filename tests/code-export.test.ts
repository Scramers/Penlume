import { describe, expect, it } from 'vitest'
import { fromHtml } from 'hast-util-from-html'
import type { Element, Root, RootContent } from 'hast'
import { renderDocumentHtml } from '../src/renderer/export-document'
import { highlightExportCode, maxHighlightedBlockLength } from '../src/renderer/code-export'
import { defaultPreferences } from '../src/shared/preferences'

function elements(html: string, name: string): Element[] {
  const found: Element[] = []
  const visit = (node: Root | RootContent) => { if (node.type === 'element' && node.tagName === name) found.push(node); if ('children' in node) node.children.forEach(visit) }
  visit(fromHtml(html)); return found
}
function content(node: Root | RootContent): string { return node.type === 'text' ? node.value : 'children' in node ? node.children.map(content).join('') : '' }
function body(html: string): string { return html.split('<body>')[1]?.split('</body>')[0] ?? '' }

describe('standalone code export', () => {
  it('highlights actual JavaScript and Python grammars without changing a single source character', async () => {
    for (const [language, source] of [['js', 'const café = "<img src=x onerror=alert(1)>";\n// 中文\n'], ['python', 'def greet(name):\n\treturn "你好 " + name\n']]) {
      const html = await renderDocumentHtml('```' + language + '\n' + source + '```', 'Code')
      const code = elements(html, 'code')[0]
      expect(content(code)).toBe(source)
      expect(body(html)).toContain('tok-keyword')
      expect(body(html)).toContain('tok-string')
      expect(elements(body(html), 'img')).toHaveLength(0)
      expect(elements(body(html), 'script')).toHaveLength(0)
    }
  })
  it('keeps unknown, unlabeled and Mermaid fences as exact text', async () => {
    for (const language of ['', 'not-a-language', 'mermaid']) {
      const source = 'graph TD\nA["<script>danger()</script>"] --> B\n'
      const html = await renderDocumentHtml('```' + language + '\n' + source + '```', 'Literal')
      expect(content(elements(html, 'code')[0])).toBe(source)
      expect(body(html)).not.toContain('tok-keyword')
      expect(elements(body(html), 'script')).toHaveLength(0)
    }
  })
  it('preserves ordinary latex/math code while rendering only dollar-delimited math', async () => {
    const html = await renderDocumentHtml('```latex title="example"\n\\frac{a}{b}\n```\n\n```math\n\\frac{c}{d}\n```\n\n$$\nx^2\n$$\n\n$x+1$', 'Math')
    expect(elements(html, 'pre')).toHaveLength(2)
    expect(elements(html, 'code').map(content)).toEqual(['\\frac{a}{b}\n', '\\frac{c}{d}\n'])
    expect(elements(body(html), 'span').filter((node) => (node.properties.className as string[] | undefined)?.includes('katex'))).toHaveLength(2)
    expect(body(html)).toContain('class="language-math"')
    expect(body(html)).not.toContain('ttypora-literal-math')
  })
  it('exports line numbers and wrapping without contaminating code copied as text, including blank lines', async () => {
    const source = 'const x = 1;\n\n\tconsole.log("a\\nb");\n'
    const preferences = { ...defaultPreferences, codeLineNumbers: true, codeWrap: true, tabSize: 4 }
    const html = await renderDocumentHtml('```js\n' + source + '```', 'Numbered', { preferences })
    expect(content(elements(html, 'code')[0])).toBe(source)
    expect(body(html)).toContain('code-export-numbered')
    expect(body(html)).toContain('data-line="3"')
    expect(body(html)).toContain('code-export-wrap')
    expect(html).toContain('--code-tab-size: 4')
    const nowrap = await renderDocumentHtml('```js\n' + source + '```', 'No wrap', { preferences: { ...preferences, codeLineNumbers: false, codeWrap: false } })
    expect(body(nowrap)).not.toContain('code-export-wrap')
    expect(body(nowrap)).not.toContain('code-export-numbered')
    expect(content(elements(nowrap, 'code')[0])).toBe(source)
  })
  it('bounds optional grammar work for oversized blocks and keeps literal content', async () => {
    const source = 'const value = 1;\n'.repeat(Math.ceil(maxHighlightedBlockLength / 17) + 1)
    expect(await highlightExportCode(source, 'javascript')).toEqual([{ type: 'text', value: source }])
  })
  it('preserves nested fenced code and malformed syntax without executing or losing text', async () => {
    const html = await renderDocumentHtml('> ```js\n> const x = { broken: "unterminated\n> ```', 'Nested')
    expect(content(elements(html, 'code')[0])).toBe('const x = { broken: "unterminated\n')
    expect(elements(html, 'blockquote')).toHaveLength(1)
    expect(body(html)).toContain('tok-keyword')
  })
})
