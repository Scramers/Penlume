import { describe, expect, it } from 'vitest'
import { codeMetadataOffset, inferCodeMathField } from '../src/renderer/editor/code-math-position'
import { markdownInlineMathRanges, markdownTextBlocks } from '../src/renderer/editor/markdown-position'

describe('editable math and code info source fields', () => {
  it('maps repeated language text to metadata after the language token in root and nested fences', () => {
    for (const source of ['```cpp cpp\nx\n```', '> ```javascript script\n> x\n> ```', '- Item\n\n  ~~~cpp cpp\n  x\n  ~~~', '```cpp\t cpp\r\nx\r\n```']) {
      const blocks = markdownTextBlocks(source), block = blocks.find((item) => item.type === 'code')!
      const meta = source.includes('script') ? 'script' : 'cpp'
      const offset = source.lastIndexOf(meta, source.indexOf('\n', block.from))
      expect(codeMetadataOffset(source, block.from)).toBe(offset)
      const field = inferCodeMathField(source, blocks, { anchor: offset + meta.length, head: offset })
      expect(field).toEqual({ kind: 'code-meta', sourceOffset: block.from, anchor: meta.length, head: 0 })
    }
  })
  it('restores the second inline formula and reverse selection from absolute offsets without a carried UI flag', () => {
    const source = 'Before $x+1$ and $$ y+2 $$; literal `$z$`.\n\n> $a+b$\n\n- $c+d$'
    const ranges = markdownInlineMathRanges(source)
    expect(ranges.map((item) => source.slice(item.contentFrom, item.contentTo))).toEqual(['x+1', 'y+2', 'a+b', 'c+d'])
    for (const range of ranges) {
      const field = inferCodeMathField(source, markdownTextBlocks(source), { anchor: range.contentTo, head: range.contentFrom })
      expect(field).toEqual({ kind: 'inline-math', sourceOffset: range.from, anchor: range.contentTo - range.contentFrom, head: 0 })
    }
    const ignored = source.indexOf('z')
    expect(inferCodeMathField(source, markdownTextBlocks(source), { anchor: ignored, head: ignored + 1 })).toBeUndefined()
  })
  it('leaves selections spanning different fields in the ordinary text mapping', () => {
    const source = '$x$ and $y$\n\n```js title="example"\nconst x = 1\n```'
    expect(inferCodeMathField(source, markdownTextBlocks(source), { anchor: source.indexOf('x'), head: source.indexOf('y') + 1 })).toBeUndefined()
    const offset = source.indexOf('const')
    expect(inferCodeMathField(source, markdownTextBlocks(source), { anchor: offset, head: offset + 5 })).toBeUndefined()
  })
})
