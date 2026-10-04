import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'
import type { Root, RootContent } from 'mdast'
import { codeMetadataFieldBookmark, codeMetadataOffset, inferCodeMathField, inlineMathFieldBookmark } from '../src/renderer/editor/code-math-position'
import { serializeCodeMetadata } from '../src/renderer/editor/code-metadata'
import { markdownInlineMathRanges, markdownTextBlocks } from '../src/renderer/editor/markdown-position'

function inlineValues(source: string): string[] {
  const values: string[] = []
  const visit = (node: Root | RootContent) => {
    if (node.type === 'inlineMath') values.push(node.value)
    if ('children' in node) node.children.forEach((child) => visit(child as RootContent))
  }
  visit(unified().use(remarkParse).use(remarkMath).parse(source) as Root)
  return values
}

function metadataValue(source: string): string | null | undefined {
  let value: string | null | undefined
  const visit = (node: Root | RootContent) => {
    if (node.type === 'code') value = node.meta
    if ('children' in node) node.children.forEach((child) => visit(child as RootContent))
  }
  visit(unified().use(remarkParse).parse(source) as Root)
  return value
}

function metadataSelection(source: string, anchor: number, head: number) {
  const blocks = markdownTextBlocks(source), block = blocks.find((block) => block.type === 'code')!
  const bookmark = codeMetadataFieldBookmark(source, block.from, anchor, head)!
  expect(bookmark, source).toBeDefined()
  expect(bookmark.embedded).toEqual({ kind: 'code-meta', sourceOffset: block.from, anchor, head })
  expect(inferCodeMathField(source, blocks, { anchor: bookmark.anchor, head: bookmark.head }), `${source}: ${anchor}→${head}`).toEqual(bookmark.embedded)
  return source.slice(Math.min(bookmark.anchor, bookmark.head), Math.max(bookmark.anchor, bookmark.head))
}

describe('source field selection in non-contiguous Markdown', () => {
  it('does not infer a metadata input from the first line end of indented code', () => {
    const source = '    print("hello")\n    print("world")\n'
    const blocks = markdownTextBlocks(source)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'code', text: 'print("hello")\nprint("world")' })
    const head = source.indexOf('\n')
    expect(inferCodeMathField(source, blocks, { anchor: head, head })).toBeUndefined()
  })

  it('maps the final character of CRLF inline math to its normalized textarea value', () => {
    const source = 'Before $a\r\n+b$ after'
    expect(inlineValues(source)).toEqual(['a\r\n+b'])
    const from = source.indexOf('b$', source.indexOf('$')), to = from + 1
    expect(inferCodeMathField(source, markdownTextBlocks(source), { anchor: from, head: to })).toEqual({ kind: 'inline-math', sourceOffset: source.indexOf('$'), anchor: 3, head: 4 })
  })

  it('maps math continued on a quoted line without counting the block quote prefix as formula text', () => {
    const source = '> Before $a\n> +b$ after\n'
    expect(inlineValues(source)).toEqual(['a\n+b'])
    const from = source.indexOf('b$', source.indexOf('$')), to = from + 1
    expect(inferCodeMathField(source, markdownTextBlocks(source), { anchor: from, head: to })).toEqual({ kind: 'inline-math', sourceOffset: source.indexOf('$'), anchor: 3, head: 4 })
  })

  it('maps every editable character through literal padding, nested containers, line endings and astral Unicode in both directions', () => {
    for (const source of [
      'Before $x+y$ after', 'Before $$ x+y $$ after', 'Before $$$x$y$$$ after',
      'Before $  x+y  $ after', 'Before $ $ after', 'Before $\na\n$ after',
      'Before $ \na\n $ after',
      'Before $a\r\n+b🙂$ after', 'Before $a\r+b🙂$ after',
      '> Before $a\n> +b🙂$ after', '> Before $ \n> a\n>  $ after',
      '> > Before $a\r\n> > +b🙂$ after', '- Before $a\n  +b🙂$ after',
      '- Before $a\r\n  +b🙂$ after', '> - Before $a\n>   +b🙂$ after',
      'Before $a\t+b$ after', 'Before $a &amp; \\alpha$ after',
    ]) {
      const values = inlineValues(source).map((value) => value.replace(/\r\n?/g, '\n'))
      expect(values, source).toHaveLength(1)
      const ranges = markdownInlineMathRanges(source)
      expect(ranges.map((range) => range.value), source).toEqual(values)
      const range = ranges[0], value = values[0], blocks = markdownTextBlocks(source)
      expect(range.offsets, source).toHaveLength(value.length + 1)
      expect(range.endOffsets, source).toHaveLength(value.length + 1)
      for (let index = 0; index < value.length; index++) {
        const raw = source.slice(range.offsets[index], range.endOffsets[index + 1]).replace(/\r\n?/g, '\n')
        expect(raw, `${source}: character ${index}`).toBe(value[index])
        for (const [anchor, head] of [[index, index + 1], [index + 1, index]]) {
          const bookmark = inlineMathFieldBookmark(source, range.from, anchor, head)!
          expect(bookmark.embedded).toEqual({ kind: 'inline-math', sourceOffset: range.from, anchor, head })
          const inferred = inferCodeMathField(source, blocks, { anchor: bookmark.anchor, head: bookmark.head })
          expect(inferred, `${source}: ${anchor}→${head}`).toEqual(bookmark.embedded)
        }
      }
    }
  })

  it('recognizes metadata after an indented fence while refusing an indented literal fence line', () => {
    for (const source of ['  ```cpp cpp\nx\n  ```', '   ~~~cpp cpp\nx\n   ~~~']) {
      const blocks = markdownTextBlocks(source), block = blocks.find((block) => block.type === 'code')!
      const offset = source.lastIndexOf('cpp', source.indexOf('\n'))
      expect(codeMetadataOffset(source, block.from)).toBe(offset)
      expect(inferCodeMathField(source, blocks, { anchor: offset + 3, head: offset })).toEqual({ kind: 'code-meta', sourceOffset: block.from, anchor: 3, head: 0 })
    }
    const source = '    ```cpp cpp\n    x\n    ```\n'
    const blocks = markdownTextBlocks(source)
    const position = source.indexOf('\n')
    expect(codeMetadataOffset(source, blocks[0].from)).toBeUndefined()
    expect(inferCodeMathField(source, blocks, { anchor: position, head: position })).toBeUndefined()
  })

  it('keeps every complete metadata character and reverse selection at its actual serialized source position', () => {
    const serializer = unified().use(remarkStringify)
    for (const meta of [
      'title="example`name.txt" {2}', 'title="<span> & 中文🙂</span>" linenos',
      'title="literal &#x60; &amp; &NotEqualTilde;" label=`inline`',
      'path="C:\\temp\\file.txt" quote=\\" slash=\\\\ end', '{1,3-5} linenos title="last.txt"',
      ' title="padded.txt" ', '  ', '\ttitle="tabbed.txt"\t',
    ]) {
      const source = serializer.stringify({ type: 'root', children: [{ type: 'code', lang: 'text', meta: serializeCodeMetadata(meta), value: 'x' }] } satisfies Root)
      expect(metadataValue(source), source).toBe(meta)
      let index = 0
      for (const character of meta) {
        const end = index + character.length
        const forward = metadataSelection(source, index, end), backward = metadataSelection(source, end, index)
        expect(backward, `${meta}: ${index}`).toBe(forward)
        if (character === '&') expect(forward).toBe('&amp;')
        else if (character === '`') expect(forward).toBe('&#x60;')
        else if (character === '\\') expect(['\\', '\\\\']).toContain(forward)
        else if (character === ' ' || character === '\t') expect([character, `&#x${character.charCodeAt(0).toString(16)};`]).toContain(forward)
        else expect(forward, `${meta}: ${index}`).toBe(character)
        index = end
      }
      metadataSelection(source, 0, meta.length)
      metadataSelection(source, meta.length, 0)
      for (const index of [0, meta.length]) metadataSelection(source, index, index)
    }
  })

  it('decodes loaded code info exactly once and maps complete source entities and backslash escapes', () => {
    const cases = [
      { raw: 'label=&amp;#x60; later', value: 'label=&#x60; later', selected: '&#x60;', token: '&amp;#x60;' },
      { raw: 'label=&#x1F642; later', value: 'label=🙂 later', selected: '🙂', token: '&#x1F642;' },
      { raw: 'label=&NotEqualTilde; later', value: 'label=≂̸ later', selected: '≂̸', token: '&NotEqualTilde;' },
      { raw: 'label=&#0; later', value: 'label=� later', selected: '�', token: '&#0;' },
      { raw: 'label=&#xD800; later', value: 'label=� later', selected: '�', token: '&#xD800;' },
      { raw: 'label=&#x110000; later', value: 'label=� later', selected: '�', token: '&#x110000;' },
      { raw: 'label=&UnknownEntity; later', value: 'label=&UnknownEntity; later', selected: '&UnknownEntity;', token: '&UnknownEntity;' },
      { raw: 'label=\\` later', value: 'label=` later', selected: '`', token: '\\`' },
      { raw: 'label=\\\\ later', value: 'label=\\ later', selected: '\\', token: '\\\\' },
      { raw: 'label=\\q later', value: 'label=\\q later', selected: '\\q', token: '\\q' },
      { raw: 'label=\\&amp; later', value: 'label=&amp; later', selected: '&amp;', token: '\\&amp;' },
    ]
    for (const { raw, value, selected, token } of cases) {
      for (const [prefix, continuation, newline] of [['', '', '\n'], ['> ', '> ', '\r\n'], ['- ', '  ', '\r'], ['   ', '', '\n']]) {
        const source = `${prefix}~~~text ${raw}${newline}${continuation}x${newline}${continuation}~~~${newline}`
        expect(metadataValue(source), source).toBe(value)
        const start = value.indexOf(selected), end = start + selected.length
        expect(metadataSelection(source, start, end), source).toBe(token)
        expect(metadataSelection(source, end, start), source).toBe(token)
        const later = value.indexOf('later')
        expect(metadataSelection(source, later, later + 5), source).toBe('later')
        expect(metadataSelection(source, later + 5, later), source).toBe('later')
        metadataSelection(source, 0, value.length)
        metadataSelection(source, value.length, 0)
      }
    }
  })

  it('does not infer code metadata outside a real fence or across its language and body', () => {
    for (const source of ['    ~~~text title=example\n    x\n    ~~~', 'Body ~~~text title=example', '---\n~~~text title=example\n---\nBody']) {
      const start = source.indexOf('title'), blocks = markdownTextBlocks(source)
      expect(inferCodeMathField(source, blocks, { anchor: start, head: start + 5 }), source).toBeUndefined()
      for (const block of blocks) expect(codeMetadataFieldBookmark(source, block.from, 0, 1), source).toBeUndefined()
    }
    const source = '~~~text title=example\nx\n~~~', blocks = markdownTextBlocks(source)
    expect(inferCodeMathField(source, blocks, { anchor: source.indexOf('text'), head: source.indexOf('example') })).toBeUndefined()
    expect(inferCodeMathField(source, blocks, { anchor: source.indexOf('title'), head: source.indexOf('\nx') + 2 })).toBeUndefined()
    const empty = '~~~text\nx\n~~~'
    expect(metadataSelection(empty, 0, 0)).toBe('')
  })

  it('does not treat dollar text inside code, raw HTML or another document field as an editable math field', () => {
    for (const source of ['`$a$`', '```math\n$a$\n```', '    $a$\n', '<pre>$a$</pre>', '---\ntitle: $a$\n---\n\nBody', 'Before $\n\na\n\n$ after']) {
      expect(markdownInlineMathRanges(source), source).toHaveLength(0)
      const position = source.indexOf('a$') >= 0 ? source.indexOf('a$') : source.indexOf('a')
      expect(inferCodeMathField(source, markdownTextBlocks(source), { anchor: position, head: position + 1 }), source).toBeUndefined()
    }
  })
})
