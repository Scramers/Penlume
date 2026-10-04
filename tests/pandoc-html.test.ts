import { describe, expect, it } from 'vitest'
import { sanitizePandocHtmlOutput, sanitizePandocInput, sanitizePandocMarkdownHtml } from '../src/main/pandoc-html'

async function inspectHtml(html: string) {
  const { fromHtml } = await import('hast-util-from-html')
  const root = fromHtml(html)
  const elements: Array<{ tagName: string; properties: Record<string, unknown> }> = []
  const visit = (node: (typeof root) | (typeof root.children)[number]) => { if (node.type === 'element') elements.push(node); if ('children' in node) node.children.forEach(visit) }
  visit(root)
  return elements
}

describe('Pandoc Markdown HTML input', () => {
  it('preserves separate inline opening and closing tags, Unicode text and entity meaning', async () => {
    const markdown = '# 标题\n\n<u>下划线 &amp; 符号</u> H<sub>2</sub>O x<sup>2</sup> <mark>重点🙂</mark>\n'
    expect(await sanitizePandocMarkdownHtml(markdown)).toBe(markdown)
    expect(await sanitizePandocMarkdownHtml('A <u title="a > b">word</u> Z')).toBe('A <u title="a > b">word</u> Z')
  })

  it('keeps safe HTML links and images, without auto-closing the opening anchor token', async () => {
    const markdown = 'A <a href="https://example.com/?x=1&amp;y=2" onclick="bad()">链接 &copy;</a> <img src="assets/图.png" alt="图 &amp; 说明" onerror="bad()"> Z'
    const clean = await sanitizePandocMarkdownHtml(markdown)
    expect(clean).toContain('<a href="https://example.com/?x=1&amp;y=2">链接 &copy;</a>')
    expect(clean).toContain('<img src="assets/图.png" alt="图 &amp; 说明">')
    expect(clean).not.toMatch(/onclick|onerror|bad\(\)/)
    expect(clean).not.toContain('</a>链接')
  })

  it('removes dangerous inline elements and their content while retaining nearby Markdown', async () => {
    const clean = await sanitizePandocMarkdownHtml('before <script>alert(1)</script> **bold** <iframe src="https://x.example">payload</iframe> after')
    expect(clean).toBe('before  **bold**  after')
    expect(await sanitizePandocMarkdownHtml('before <script>alert(1)')).toBe('before ')
  })

  it('sanitizes complete HTML blocks and preserves safe headings, tables and entity semantics', async () => {
    const clean = await sanitizePandocMarkdownHtml('<div onclick="bad()"><h2 id="section">A &amp; B</h2><script>bad()</script><table><tr><th>项目</th><td>&lt;x&gt; &copy;</td></tr></table><object data="x">unsafe</object><p>safe</p></div>\n')
    expect(clean).toContain('<h2 id="section">A &amp; B</h2>')
    expect(clean).toContain('<table><tbody><tr><th>项目</th><td>&lt;x> ©</td></tr></tbody></table>')
    expect(clean).toContain('<p>safe</p>')
    expect(clean).not.toMatch(/onclick|script|object|unsafe|bad\(\)/)
  })

  it('does not change similar text in fenced/indented code, inline code, math or YAML', async () => {
    const markdown = '---\ntitle: "<script>alert(1)</script>"\n---\n\n```html\n<img src=x onerror=bad()>\n<script>literal</script>\n```\n\n    <u onclick="bad()">indented</u>\n\n`<script>literal</script>`\n\n$<img src=x onerror=bad()>$\n\n$$\n<script>math</script>\n$$\n'
    expect(await sanitizePandocMarkdownHtml(markdown)).toBe(markdown)
  })

  it('rejects entity-encoded and control-obfuscated dangerous protocols while keeping safe URL schemes', async () => {
    const clean = await sanitizePandocMarkdownHtml('<a href="jav&#x61;script:alert(1)">a</a> <a href="java&#10;script:alert(1)">b</a> <a href="data:text/html,bad">c</a> <a href="HTTPS://example.com">ok</a> <a href="mailto:a@example.com">mail</a> <a href="#section">anchor</a>')
    expect(clean).toContain('<a>a</a> <a>b</a> <a>c</a>')
    expect(clean).toContain('<a href="https://example.com">ok</a>')
    expect(clean).toContain('href="mailto:a@example.com"')
    expect(clean).toContain('href="#section"')
    expect(clean).not.toMatch(/javascript|data:text\/html|alert\(1\)/i)
  })

  it('keeps inline data raster images but rejects SVG/HTML data and file URLs', async () => {
    const clean = await sanitizePandocMarkdownHtml('<img src="data:image/png;base64,aGVsbG8=" alt="png"> <img src="data:image/svg+xml;base64,aGVsbG8=" alt="svg"> <img src="data:text/html;base64,aGVsbG8=" alt="html"> <img src="file:///C:/secret.png" alt="file">')
    expect(clean).toContain('<img src="data:image/png;base64,aGVsbG8=" alt="png">')
    expect(clean).toContain('<img alt="svg">')
    expect(clean).toContain('<img alt="html">')
    expect(clean).toContain('<img alt="file">')
    expect(await sanitizePandocMarkdownHtml('<img src="https://example.com/中文 图.png" alt="远程">')).toContain('src="https://example.com/中文 图.png"')
  })

  it('retains standalone table tags split by blank lines without introducing empty pairs', async () => {
    const clean = await sanitizePandocMarkdownHtml('<table>\n\n<tr>\n\n<td>\n\nCell\n\n</td>\n\n</tr>\n\n</table>')
    expect(clean).toBe('<table>\n\n<tr>\n\n<td>\n\nCell\n\n</td>\n\n</tr>\n\n</table>')
  })
})

describe('Pandoc standalone HTML output', () => {
  it('returns a standalone document and preserves title, headings, tables, images and math text', async () => {
    const clean = await sanitizePandocHtmlOutput('<!doctype html><html lang="zh-CN"><head><title>A &amp; B</title></head><body><h1 id="标题">标题</h1><p>H<sub>2</sub>O <u>下划线</u> <mark>强调</mark></p><table><tr><th>列</th><td>值</td></tr></table><img src="data:image/png;base64,aGVsbG8=" alt="图"><span class="math inline">\\(x^2 + y^2\\)</span></body></html>')
    expect(clean).toMatch(/^<!doctype html>\n<html lang="zh-CN">/)
    expect(clean).toContain('<title>A &amp; B</title>')
    expect(clean).toContain('<h1 id="标题">标题</h1>')
    expect(clean).toContain('<td>值</td>')
    expect(clean).toContain('src="data:image/png;base64,aGVsbG8="')
    expect(clean).toContain('<span class="math inline">\\(x^2 + y^2\\)</span>')
    expect(clean).toContain('http-equiv="Content-Security-Policy"')
    expect((await inspectHtml(clean)).find((element) => element.tagName === 'meta' && (element.properties.httpEquiv as string[] | undefined)?.includes('Content-Security-Policy'))?.properties.content).toContain("default-src 'none'")
  })

  it('strips active containers, scripts, styles, refresh meta, event attributes, srcdoc and unsafe links', async () => {
    const clean = await sanitizePandocHtmlOutput('<html><head><title>Safe</title><meta http-equiv="refresh" content="0;url=https://evil.example"><style>@import "https://evil.example";</style><link rel="stylesheet" href="https://evil.example"><base href="https://evil.example"></head><body onload="bad()"><script src="https://evil.example">bad()</script><iframe srcdoc="<script>bad()</script>">bad-frame</iframe><embed src="data:text/html,x"><object data="x">bad-object</object><p style="background:url(x)" onclick="bad()">Good <a href="javascript:bad()">Link</a></p></body></html>')
    expect(clean).toContain('<p>Good <a>Link</a></p>')
    expect(clean).not.toMatch(/<script|<style|<iframe|<embed|<object|<base|<link|onload|onclick|srcdoc|javascript:|http-equiv="refresh"|evil\.example|bad-frame|bad-object/)
  })

  it('resists malformed nesting and namespace mutation payloads without losing ordinary text', async () => {
    const payload = '<svg><foreignObject><iframe srcdoc="<script>x</script>"></iframe></foreignObject></svg><math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>"></table></mtext></math><p>kept &amp; readable</p><noscript><img src=x onerror=bad()></noscript>'
    const clean = await sanitizePandocHtmlOutput(payload)
    expect(clean).toContain('kept &amp; readable')
    const elements = await inspectHtml(clean)
    expect(elements.some((element) => ['svg', 'foreignobject', 'iframe', 'style', 'script', 'noscript'].includes(element.tagName))).toBe(false)
    expect(elements.some((element) => Object.keys(element.properties).some((key) => /^on/i.test(key) || key.toLowerCase() === 'srcdoc'))).toBe(false)
    // A second parse must not resurrect a payload after HTML serialization.
    expect(await sanitizePandocHtmlOutput(clean)).toBe(clean)
  })

  it('preserves safe MathML, footnote IDs, emphasis, underline, checkboxes and table spans', async () => {
    const clean = await sanitizePandocHtmlOutput('<p id="fn1"><strong>bold</strong> <em>italic</em> <u>under</u> <sup>2</sup> <sub>n</sub> <mark>mark</mark><a href="#fn1">back</a></p><math display="block"><mfrac><mi>x</mi><mn>2</mn></mfrac><msup><mi>y</mi><mn>2</mn></msup><mfenced open="[" close="]" separators=","><mi>a</mi><mi>b</mi></mfenced><semantics><mrow><mo>+</mo><mi>z</mi></mrow><annotation encoding="application/x-tex">x/2 + y^2 + z</annotation></semantics></math><input type="checkbox" checked><table><tr><td colspan="2" rowspan="3">merged</td></tr></table>')
    expect(clean).toContain('<u>under</u>')
    expect(clean).toContain('<a href="#fn1">back</a>')
    expect(clean).toContain('<math display="block"><mfrac><mi>x</mi><mn>2</mn></mfrac>')
    expect(clean).toContain('<annotation encoding="application/x-tex">x/2 + y^2 + z</annotation>')
    expect(clean).toContain('<mfenced open="[" close="]" separators=","><mi>a</mi><mi>b</mi></mfenced>')
    expect(clean).toMatch(/<input[^>]*checked[^>]*disabled[^>]*>/)
    expect(clean).toContain('<td colspan="2" rowspan="3">merged</td>')
  })
})

describe('complete Pandoc input boundaries', () => {
  it('unwraps unsafe inline and autolinks while preserving formatted labels and nearby safe links', async () => {
    const markdown = '[**bold** &amp; [bracket]](javascript:alert(1)) [vb](VbScript:msgbox(1)) [local](file:///C:/secret) <javascript:bad()> [web](HTTPS://example.com/a) [mail](mailto:a@example.com) [call](tel:1234) [relative](../notes/a.md)'
    const clean = await sanitizePandocInput(markdown)
    expect(clean).toBe('**bold** &amp; [bracket] vb local javascript:bad() [web](HTTPS://example.com/a) [mail](mailto:a@example.com) [call](tel:1234) [relative](../notes/a.md)')
  })

  it('removes unsafe definitions and unwraps full, collapsed and shortcut references', async () => {
    const markdown = '[**Label**][Danger] [Danger][] [danger] ![Photo][danger] [safe][Good]\n\n[danger]: javascript:bad() "bad title"\n[Good]: https://example.com "good title"\n'
    const clean = await sanitizePandocInput(markdown)
    expect(clean).toContain('**Label** Danger danger Photo [safe][Good]')
    expect(clean).not.toContain('[danger]:')
    expect(clean).not.toContain('javascript:')
    expect(clean).toContain('[Good]: https://example.com "good title"')
  })

  it('keeps raster data image references and strips unsafe nested image destinations', async () => {
    const markdown = '![Photo][image]\n\n[image]: data:image/png;base64,aGVsbG8=\n\n[![Nested](file:///C:/secret.png)](javascript:bad()) [link](data:text/html,bad)'
    const clean = await sanitizePandocInput(markdown)
    expect(clean).toContain('![Photo][image]\n\n[image]: data:image/png;base64,aGVsbG8=')
    expect(clean).toContain('Nested link')
    expect(clean).not.toMatch(/file:\/\/\/|javascript:|data:text\/html/)
    const shared = await sanitizePandocInput('![Photo][image] [Open][image]\n\n[image]: data:image/png;base64,aGVsbG8=')
    expect(shared.trim()).toBe('Photo Open')
  })

  it('preserves safe metadata byte-for-byte and never rewrites code or math body', async () => {
    const markdown = '---\n# keep this comment\ntitle: "A & B"\nauthor: [张三, 李四]\ndate: 2026-10-02\ncount: 5\nenabled: true\nabstract: |\n  Safe **formatting**.\n  [Web](https://example.com)\n---\n\n```md\n[Code](javascript:literal)\n<script>literal</script>\n---\ntitle: "<script>literal</script>"\n---\n```\n\n`[Inline](file:///literal)`\n\n$<script>math</script>$\n\n$$\n[display](vbscript:literal)\n$$\n'
    expect(await sanitizePandocInput(markdown)).toBe(markdown)
  })

  it('cleans YAML scalars, nested authors and aliases while retaining safe metadata semantics', async () => {
    const markdown = '---\n# document metadata\ntitle: "<u onclick=bad()>Title</u><script>bad()</script>"\nauthor:\n  - &writer "<img src=photo.png onerror=bad()> Writer"\n  - *writer\nsubtitle: "[Read](javascript:bad()) and H<sub>2</sub>O"\nheader-includes: |\n  <script src="https://evil.example">bad()</script>\n  <meta http-equiv="refresh" content="0;url=evil">\n  <style>body{display:none}</style>\ncount: 7\nenabled: true\n---\n\nBody.\n'
    const clean = await sanitizePandocInput(markdown)
    const { parse } = await import('yaml')
    const metadata = parse(clean.match(/^---\n([\s\S]*?)\n---/)![1])
    expect(metadata).toMatchObject({ title: '<u>Title</u>', author: ['<img src="photo.png"> Writer', '<img src="photo.png"> Writer'], subtitle: 'Read and H<sub>2</sub>O', count: 7, enabled: true })
    expect(metadata['header-includes']).not.toMatch(/script|meta|style|bad\(\)|evil\.example/)
    expect(clean).toContain('# document metadata')
    expect(clean.endsWith('\n\nBody.\n')).toBe(true)
  })

  it('cleans metadata after body text and supports the YAML document-end marker', async () => {
    const markdown = 'Introduction.\n\n---\ntitle: "<script>bad()</script>Safe"\n...\n\nBody H<sub>2</sub>O.\n'
    const clean = await sanitizePandocInput(markdown)
    expect(clean).toContain('title: "Safe"')
    expect(clean).toContain('\n...\n')
    expect(clean).toContain('Body H<sub>2</sub>O.')
    expect(clean).not.toContain('<script>')
  })

  it('fails closed for malformed YAML instead of forwarding unknown metadata content', async () => {
    await expect(sanitizePandocInput('---\ntitle: ["<script>bad()</script>"\n---\n\nBody')).rejects.toThrow('YAML')
  })

  it('clears raw engine directives from include variables with explicit warnings and valid aliases', async () => {
    const markdown = '---\ntitle: "A normal title"\nauthor: 张三\nheader-includes:\n  - &raw \'\\input{/private/secret}\'\n  - "<meta http-equiv=refresh content=evil>"\ninclude-before: *raw\ninclude-after-body: \'{\\rtf1 \\object payload}\'\nsubtitle: "Safe $x^2$ and **bold**"\n---\n\nBody $\\frac{a}{b}$ and `\\input{literal}`.\n'
    const warnings: string[] = []
    const clean = await sanitizePandocInput(markdown, (message) => warnings.push(message))
    const { parse } = await import('yaml')
    const metadata = parse(clean.match(/^---\n([\s\S]*?)\n---/)![1])
    expect(metadata).toMatchObject({ title: 'A normal title', author: '张三', 'header-includes': ['', ''], 'include-before': '', 'include-after-body': '', subtitle: 'Safe $x^2$ and **bold**' })
    expect(warnings.some((message) => message.includes('header-includes') && message.includes('原始引擎'))).toBe(true)
    expect(warnings.some((message) => message.includes('include-after-body'))).toBe(true)
    expect(clean).toContain('Body $\\frac{a}{b}$ and `\\input{literal}`.')
  })

  it('prevents raw include directives hidden behind scalar, collection and cyclic aliases', async () => {
    const markdown = '---\ntitle: Safe\ncustom-command: &command \'\\input{secret}\'\ncustom-sequence: &sequence [*command, Safe]\ncustom-cycle: &cycle [*cycle, *command]\nheader-includes: *command\ninclude-before: *sequence\ninclude-after: *cycle\n---\n\nBody.'
    const warnings: string[] = []
    const clean = await sanitizePandocInput(markdown, (message) => warnings.push(message))
    const { parseDocument } = await import('yaml')
    const metadata = parseDocument(clean.match(/^---\n([\s\S]*?)\n---/)![1])
    expect(metadata.get('header-includes')).toBe('')
    expect(metadata.get('include-before')).toBe('')
    expect(metadata.get('include-after')).toBe('')
    expect(metadata.get('custom-command')).toBe('\\input{secret}')
    expect(metadata.get('title')).toBe('Safe')
    expect(warnings.filter((message) => message.includes('引用的原始引擎')).length).toBe(3)
  })
})
