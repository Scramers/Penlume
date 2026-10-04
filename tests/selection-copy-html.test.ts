import { describe, expect, it } from 'vitest'
import { fromHtml } from 'hast-util-from-html'
import { defaultPreferences } from '../src/shared/preferences'
import { clipboardBodyFragment, readableClipboardHtml, renderSelectionFragment } from '../src/renderer/selection-copy-html'

describe('selection clipboard rendering without a browser document', () => {
  it('strips only a resource preparation shell and preserves body data and embedded images', () => {
    const html = '<!doctype html><html><head><title>unused</title></head><body>\n<p>alpha</p><img src="data:image/png;base64,YQ==" alt="A">\n</body></html>'
    expect(clipboardBodyFragment(html)).toBe('<p>alpha</p><img src="data:image/png;base64,YQ==" alt="A">')
  })

  it('renders only the selected source fragment and strips the document shell', async () => {
    const fragment = Object.freeze({ kind: 'source' as const, markdown: '**alpha** and [beta](https://example.com)\n\n## Gamma', plain: 'unchanged source placeholder' })
    const rendered = await renderSelectionFragment(fragment, defaultPreferences)
    expect(rendered.text).toBe('alpha and beta\n\nGamma')
    expect(rendered.html).toContain('<strong>alpha</strong>')
    expect(rendered.html).toContain('href="https://example.com"')
    expect(rendered.html).toContain('Gamma</h2>')
    expect(rendered.html).not.toMatch(/<(?:html|head|body|style|meta|title)\b/)
    expect(fragment.plain).toBe('unchanged source placeholder')
  })

  it('leaves incomplete selected Markdown to its own fragment parser', async () => {
    const rendered = await renderSelectionFragment({ kind: 'source', markdown: '**alp', plain: '**alp' }, defaultPreferences)
    expect(rendered.text).toBe('**alp')
    expect(rendered.html).not.toContain('<strong>')
    expect(rendered.html).not.toContain('alpha')
  })

  it('escapes a native input selection as literal text, including blank lines and dangerous markup', async () => {
    const raw = '<img src="../outside.png" onerror="alert(1)">&amp;\n\n\nend'
    const rendered = await renderSelectionFragment({ kind: 'literal', markdown: raw, plain: raw }, defaultPreferences)
    expect(rendered.text).toBe(raw)
    const tree = fromHtml(rendered.html, { fragment: true })
    expect(tree.children[0]).toMatchObject({ type: 'element', tagName: 'pre', children: [{ type: 'text', value: raw }] })
    expect(rendered.html).not.toMatch(/<img\b|<script\b/)
  })

  it('preserves a selected source whitespace range instead of treating it as empty', async () => {
    const raw = '\t \n '
    expect(await renderSelectionFragment({ kind: 'source', markdown: raw, plain: raw }, defaultPreferences)).toMatchObject({ text: raw })
  })

  it('preserves literal code blank lines and spaces in readable source output', async () => {
    const markdown = '```latex title="literal"\na  \n\n\nb\n```'
    const rendered = await renderSelectionFragment({ kind: 'source', markdown, plain: markdown }, defaultPreferences)
    expect(rendered.text).toBe('a  \n\n\nb\n')
    expect(rendered.html).toContain('language-latex')
    expect(rendered.html).not.toContain('class="katex"')
  })

  it('uses one TeX readable representation instead of duplicated KaTeX presentation trees', async () => {
    const rendered = await renderSelectionFragment({ kind: 'source', markdown: '$x+1$ **bold**', plain: 'not used' }, defaultPreferences)
    expect(rendered.text).toBe('x+1 bold')
    expect(rendered.html).toContain('katex')
  })

  it('produces row/column separators and ignores script/style markup', () => {
    const html = '<p>head</p>\n<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table><p>end</p><script>bad()</script><style>bad{}</style>'
    expect(readableClipboardHtml(html)).toBe('head\n\nA\tB\nC\tD\n\nend')
  })

  it('keeps the rich schema text oracle rather than deriving it from rendered controls', async () => {
    const rendered = await renderSelectionFragment({ kind: 'rich', markdown: '![alt](photo.png)', plain: 'alt (photo.png)' }, defaultPreferences)
    expect(rendered.text).toBe('alt (photo.png)')
    expect(rendered.html).toContain('<img')
    expect(rendered.html).not.toContain('input')
  })
})
