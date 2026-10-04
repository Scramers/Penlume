import { describe, expect, it } from 'vitest'
import { splitFrontMatter, readMetadata, uniqueHeadingIds } from '../src/shared/markdown-extensions'
import { extractMarkdownHeadings } from '../src/shared/markdown-outline'
import { renderDocumentHtml } from '../src/renderer/export-document'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { remarkEditorExtensions, normalizeMarkdownForPandoc } from '../src/shared/markdown-extensions'
import { defaultPreferences, parsePreferences } from '../src/shared/preferences'
import { completeEmoji, emojiForShortcode, emojiEntries } from '../src/shared/emoji-shortcodes'
import { formatMarkdown } from '../src/shared/formatting'
import { markdownTextBlocks } from '../src/renderer/editor/markdown-position'

describe('extended Markdown compatibility', () => {
  it('preserves front matter text and excludes metadata from the outline', () => {
    const input = '---\ntitle: "My title"\ntags: [a, b]\n---\n\n# Actual heading\n'
    expect(splitFrontMatter(input).frontMatter + splitFrontMatter(input).body).toBe(input)
    expect(readMetadata(input)).toMatchObject({ title: 'My title', tags: ['a', 'b'] })
    expect(extractMarkdownHeadings(input)).toEqual([{ text: 'Actual heading', level: 1, line: 6 }])
    expect(splitFrontMatter('---\nNot closed').frontMatter).toBe('')
  })
  it('generates unique Chinese anchors, including naturally suffixed headings', () => {
    expect(uniqueHeadingIds(['你好 世界', '你好 世界', '你好 世界-1'])).toEqual(['你好-世界', '你好-世界-1', '你好-世界-1-1'])
  })
  it('exports TOC, alerts, footnotes, mathematics and opt-in metadata', async () => {
    const input = '---\ntitle: Export title\nauthor: Someone\n---\n\n[TOC]\n\n# 第一章\n\n> [!WARNING]\n> Be careful.\n\nFootnote[^a].\n\n[^a]: A note\n\n$x^2$\n'
    const html = await renderDocumentHtml(input, 'Fallback', { metadata: true })
    expect(html).toContain('<title>Export title</title>')
    expect(html).toContain(`href="#${encodeURIComponent('第一章')}"`)
    expect(html).toContain('markdown-alert-warning')
    expect(html).toContain('data-footnote-ref')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('title: Export title')
    expect(await renderDocumentHtml(input, 'Fallback')).toContain('<title>Fallback</title>')
  })
  it('keeps literal extension syntax in code and sanitizes active HTML', async () => {
    const html = await renderDocumentHtml('```text\n[TOC]\n> [!NOTE]\n```\n\n<script>alert(1)</script>\n\n<a href="javascript:alert(2)" onclick="alert(3)">link</a>\n\n<mark>safe</mark>', 'Safety')
    expect(html).toContain('[TOC]')
    expect(html).not.toContain('<nav')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('onclick=')
    expect(html).toContain('<mark>safe</mark>')
  })
  it('renders nested inline marks, compact notation and offline emoji aliases', async () => {
    const input = '==重点 **粗体** [链接](https://example.com)== H~2~O x^2^ <u>下划线 *斜体*</u> :smile: :+1: :cn: :unknown:\n\n==外层 ^2^=='
    const html = await renderDocumentHtml(input, 'Inline')
    expect(html).toContain('<mark>重点 <strong>粗体</strong> <a href="https://example.com">链接</a></mark>')
    expect(html).toContain('H<sub>2</sub>O x<sup>2</sup>')
    expect(html).toContain('<u>下划线 <em>斜体</em></u>')
    expect(html).toContain('😄')
    expect(html).toContain('👍')
    expect(html).toContain('🇨🇳')
    expect(html).toContain(':unknown:')
    expect(html).toContain('<mark>外层 <sup>2</sup></mark>')
    expect(await renderDocumentHtml('==2^10 and ~ literal==', 'Unpaired')).toContain('<mark>2^10 and ~ literal</mark>')
    expect((await renderDocumentHtml(':smile::+1:', 'Adjacent')).match(/class="markdown-emoji"/g)).toHaveLength(2)
  })
  it('round trips extension syntax after visual editing and keeps literal delimiters escaped', async () => {
    const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkEditorExtensions).use(remarkStringify)
    const input = '==A **bold**== H~2~O x^hello\\ world^ <u>中文</u> :smile: :+1:'
    const result = String(await processor.process(input))
    expect(result).toContain('==A **bold**==')
    expect(result).toContain('H~2~O')
    expect(result).toContain('x^hello\\ world^')
    expect(result).toContain('<u>中文</u>')
    expect(result).toContain(':smile: :+1:')
    expect(await renderDocumentHtml(result, 'Round trip')).toContain('<sup>hello world</sup>')
    const literal = String(await processor.process('\\==literal\\== \\^literal\\^'))
    expect(await renderDocumentHtml(literal, 'Literal')).not.toContain('<mark>')
    expect(await renderDocumentHtml(literal, 'Literal')).not.toContain('<sup>literal')
  })
  it('leaves code, math, escaped syntax, URL destinations and incomplete delimiters untouched', async () => {
    const input = '`==code== ^2^ ~2~ :smile:`\n\n```\n==code== ^2^ ~2~ :smile:\n```\n\n[==label==](https://example.com/==path==?q=:smile:)\n\n\\==literal\\== \\^literal\\^ \\~literal\\~ \\:smile: :unknown: ^two words^ ~two words~ ==unfinished\n\n$x^2$'
    const html = await renderDocumentHtml(input, 'Literals')
    expect(html).toContain('<code>==code== ^2^ ~2~ :smile:</code>')
    expect(html).toContain('href="https://example.com/==path==?q=:smile:"')
    expect(html).toContain('<mark>label</mark>')
    expect(html).not.toContain('<mark>literal')
    expect(html).not.toContain('<sup>literal')
    expect(html).not.toContain('<sub>literal')
    expect(html).toContain('^two words^ ~two words~ ==unfinished')
    expect(html).not.toContain('markdown-emoji')
    expect(html).toContain('class="katex"')
  })
  it('configures each extension independently and migrates older preferences', async () => {
    expect(parsePreferences({ fontSize: 19 }).markdownExtensions).toEqual(defaultPreferences.markdownExtensions)
    const preferences = { ...defaultPreferences, markdownExtensions: { ...defaultPreferences.markdownExtensions, highlight: false, superscript: false, subscript: false, emoji: false } }
    const html = await renderDocumentHtml('==plain== x^2^ H~2~O :smile: ~~strike~~', 'Disabled', { preferences })
    expect(html).toContain('==plain== x^2^ H~2~O :smile: <del>strike</del>')
    expect(html).not.toContain('<mark>')
    expect(html).not.toContain('<sup>2')
    expect(html).not.toContain('<sub>2')
    expect(formatMarkdown('superscript', 'hello world')).toBe('^hello\\ world^')
    expect(formatMarkdown('underline', 'text')).toBe('<u>text</u>')
  })
  it('keeps selected extension text mapped to source and maps emoji as one atomic node', () => {
    const source = 'Text ==**中文**== H~2~O x^hello\\ world^ <u>under</u> :smile:'
    const block = markdownTextBlocks(source)[0]
    expect(block.text).toBe('Text 中文 H2O xhello world under \ufffc')
    expect(block.offsets[block.text.indexOf('中文')]).toBe(source.indexOf('中文'))
    expect(block.endOffsets[block.text.indexOf('中文') + 2]).toBe(source.indexOf('中文') + 2)
    expect(block.offsets[block.text.indexOf('under')]).toBe(source.indexOf('under'))
    expect(block.offsets[block.text.indexOf('\ufffc')]).toBe(source.indexOf(':smile:'))
    expect(block.endOffsets.at(-1)).toBe(source.length)
  })
  it('provides a bundled comprehensive emoji catalog and ranks exact/prefix completions', () => {
    expect(emojiEntries.length).toBeGreaterThan(1900)
    expect(emojiForShortcode('smile')?.emoji).toBe('😄')
    expect(emojiForShortcode('nonexistent')).toBeUndefined()
    expect(completeEmoji('smile')[0].name).toBe('smile')
    expect(completeEmoji('thumbs', 4).map((entry) => entry.name)).toContain('thumbsup')
    expect(completeEmoji('cn')[0].emoji).toBe('🇨🇳')
  })
  it('keeps entity-encoded delimiters literal and preserves positions after multi-character entities', async () => {
    const source = '&NotEqualTilde; &bogus; ==中文== &#x1f642; &Hat;plain&Hat; &equals;&equals;encoded&equals;&equals;'
    const html = await renderDocumentHtml(source, 'Entities')
    expect(html).toContain('<mark>中文</mark>')
    expect(html).not.toContain('<sup>plain')
    expect(html).not.toContain('<mark>encoded')
    expect(html).toContain('==encoded==')
    const block = markdownTextBlocks(source)[0]
    expect(block.offsets[block.text.indexOf('中文')]).toBe(source.indexOf('中文'))
    expect(block.endOffsets[block.text.indexOf('中文') + 2]).toBe(source.indexOf('中文') + 2)
  })
  it('normalizes only parsed highlight/emoji spans for Pandoc and leaves destinations and code byte-identical', async () => {
    const input = '---\ntitle: ==metadata== :smile:\n---\n\n==**bold** :smile:== H~2~O x^2^\n\n[==label== :+1:](https://example.com/==path==?q=:smile:)\n\nhttps://example.com?q=:smile:\n\n<https://example.com?q=:smile:>\n\n`==code== :smile:`\n\n```md\n==code== :smile:\n```\n\n\\==literal\\== \\:smile: $x^2$\n'
    const result = await normalizeMarkdownForPandoc(input)
    expect(result).toContain('<mark>**bold** 😄</mark> H~2~O x^2^')
    expect(result).toContain('[<mark>label</mark> 👍](https://example.com/==path==?q=:smile:)')
    expect(result).toContain('https://example.com?q=:smile:')
    expect(result).toContain('<https://example.com?q=:smile:>')
    expect(result).toContain('title: ==metadata== :smile:')
    expect(result).toContain('`==code== :smile:`')
    expect(result).toContain('```md\n==code== :smile:\n```')
    expect(result).toContain('\\==literal\\== \\:smile: $x^2$')
    expect(await normalizeMarkdownForPandoc(input, { highlight: false, emoji: false })).toBe(input)
  })
})
