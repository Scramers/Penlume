import { describe, expect, it } from 'vitest'
import { markdownTextBlocks, nearestTextOffset } from '../src/renderer/editor/markdown-position'

describe('Markdown cursor mapping', () => {
  it('maps visible characters through headings, marks, links and escaped punctuation', () => {
    const source = '# 中文 **bold** and [link](target.md) \\* end\n'
    const [block] = markdownTextBlocks(source)
    expect(block.text).toBe('中文 bold and link * end')
    for (const word of ['中文', 'bold', 'link', '*', 'end']) {
      const sourceOffset = word === '*' ? source.indexOf('\\*') + 1 : source.indexOf(word)
      expect(block.offsets[block.text.indexOf(word)]).toBe(sourceOffset)
      expect(nearestTextOffset(block.offsets, sourceOffset)).toBe(block.text.indexOf(word))
    }
  })
  it('maps entities and astral Unicode using UTF-16 without shifting following characters', () => {
    const source = 'A &amp; B &#x1f642; C'
    const [block] = markdownTextBlocks(source)
    expect(block.text).toBe('A & B 🙂 C')
    expect(block.offsets[block.text.indexOf('B')]).toBe(source.indexOf('B'))
    expect(block.offsets[block.text.indexOf('C')]).toBe(source.indexOf('C'))
  })
  it('keeps selection edges inside Markdown marks and link labels in either direction', () => {
    const source = 'Alpha **bold** and [link](target.md).'
    const [block] = markdownTextBlocks(source)
    for (const word of ['bold', 'link']) {
      const start = block.text.indexOf(word), end = start + word.length
      expect(source.slice(block.offsets[start], block.endOffsets[end])).toBe(word)
      expect(nearestTextOffset(block.endOffsets, source.indexOf(word) + word.length)).toBe(end)
    }
  })
  it('matches nested lists and individual table cells in document order', () => {
    const source = '- first\n  - nested **word**\n\n| A | B |\n|---|---|\n| C | D |'
    const blocks = markdownTextBlocks(source)
    expect(blocks.map((block) => block.text)).toEqual(['first', 'nested word', 'A', 'B', 'C', 'D'])
    expect(blocks[1].offsets[7]).toBe(source.indexOf('word'))
  })
  it('excludes TOC and alert labels and locates YAML and code content', () => {
    const source = '---\ntitle: Test\n---\n\n[TOC]\n\n> [!NOTE]\n> Body\n\n```js\nconst a = 1\n```'
    const blocks = markdownTextBlocks(source)
    expect(blocks.map((block) => block.text)).toEqual(['title: Test', 'Body', 'const a = 1'])
    expect(blocks[0].offsets[0]).toBe(source.indexOf('title:'))
    expect(blocks[2].offsets[0]).toBe(source.indexOf('const'))
  })
  it('maps multiline code inside containers, indented code and CRLF source', () => {
    for (const source of ['> ```js\n> const a = 1\n> const b = 2\n> ```', '- item\n\n  ```js\n  const a = 1\n  const b = 2\n  ```', '    const a = 1\n    const b = 2\n', '```js\r\nconst a = 1\r\nconst b = 2\r\n```', '> ```js title="test.js"\r\n> const a = 1\r\n> const b = 2\r\n> ```']) {
      const block = markdownTextBlocks(source).find((block) => block.type === 'code')!
      expect(block.text).toBe('const a = 1\nconst b = 2')
      for (const line of ['const a = 1', 'const b = 2']) {
        const index = block.text.indexOf(line)
        expect(block.offsets[index]).toBe(source.indexOf(line))
        expect(source.slice(block.offsets[index], block.endOffsets[index + line.length])).toBe(line)
      }
    }
  })
  it('maps true math source in root, quote, list and CRLF without including delimiters', () => {
    for (const source of ['$$ label\nx^2 + y^2\n\\alpha + \\beta\n$$', '> $$\n> x^2 + y^2\n> \\alpha + \\beta\n> $$', '- item\n\n  $$\n  x^2 + y^2\n  \\alpha + \\beta\n  $$', '$$\r\nx^2 + y^2\r\n\\alpha + \\beta\r\n$$']) {
      const block = markdownTextBlocks(source).find((block) => block.type === 'math')!
      expect(block.text).toBe('x^2 + y^2\n\\alpha + \\beta')
      for (const line of ['x^2 + y^2', '\\alpha + \\beta']) {
        const index = block.text.indexOf(line), offset = source.indexOf(line)
        expect(block.offsets[index]).toBe(offset)
        expect(source.slice(block.offsets[index], block.endOffsets[index + line.length])).toBe(line)
        expect(nearestTextOffset(block.offsets, offset)).toBe(index)
        expect(nearestTextOffset(block.endOffsets, offset + line.length)).toBe(index + line.length)
      }
      expect(block.offsets).toHaveLength(block.text.length + 1)
      expect(block.endOffsets).toHaveLength(block.text.length + 1)
    }
  })
  it('keeps latex code and formula mappings distinct among repeated nested text', () => {
    const source = '> ```latex title="same.tex"\n> x^2\n> ```\n>\n> $$\n> x^2\n> $$\n\n- item\n\n  $$\n  x^2\n  $$\n\nAfter'
    const blocks = markdownTextBlocks(source)
    expect(blocks.map((block) => [block.type, block.text])).toEqual([['code', 'x^2'], ['math', 'x^2'], ['paragraph', 'item'], ['math', 'x^2'], ['paragraph', 'After']])
    const occurrences = Array.from(source.matchAll(/x\^2/g), (match) => match.index!)
    expect(blocks.filter((block) => block.text === 'x^2').map((block) => block.offsets[0])).toEqual(occurrences)
  })
})
