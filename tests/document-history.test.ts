import { describe, expect, it } from 'vitest'
import { DocumentHistory } from '../src/shared/document-history'

describe('document history', () => {
  it('groups consecutive typing and preserves the original bytes on undo', () => {
    const history = new DocumentHistory('# Original\n')
    history.setBookmark({ anchor: 10, head: 10 })
    history.record('# Originala\n', { anchor: 11, head: 11 }, 1000)
    history.record('# Originalab\n', { anchor: 12, head: 12 }, 1100)
    expect(history.undo()).toEqual({ markdown: '# Original\n', bookmark: { anchor: 10, head: 10 } })
    expect(history.redo()?.markdown).toBe('# Originalab\n')
  })
  it('keeps pasted blocks, formatting and view boundaries as separate steps', () => {
    const history = new DocumentHistory('hello')
    history.record('hello world', null, 1)
    history.boundary()
    history.record('hello world!', null, 2)
    history.record('**hello world!**', null, 3)
    expect(history.undo()?.markdown).toBe('hello world!')
    expect(history.undo()?.markdown).toBe('hello world')
    expect(history.undo()?.markdown).toBe('hello')
  })
  it('clears redo after a branch and separates noncontiguous edits', () => {
    const history = new DocumentHistory('ab')
    history.record('abc', null, 100)
    history.record('zabc', null, 110)
    expect(history.undo()?.markdown).toBe('abc')
    history.record('abcd', null, 120)
    expect(history.canRedo).toBe(false)
  })
  it('retains Unicode and bounds memory without discarding the current document', () => {
    const history = new DocumentHistory('中文🙂', 2, 100)
    for (const text of ['第一段🙂', '第二段🚀', '最后一段𠮷']) { history.boundary(); history.record(text) }
    expect(history.undo()?.markdown).toBe('第二段🚀')
    expect(history.undo()?.markdown).toBe('第一段🙂')
    expect(history.undo()).toBeNull()
  })
  it('groups composition replacements and separates the next committed edit', () => {
    const history = new DocumentHistory('hello ')
    history.boundary()
    history.record('hello ni', null, 100, true)
    history.record('hello nihao', null, 120, true)
    history.record('hello 你好', null, 140, true)
    history.boundary()
    history.record('hello 你好！', null, 160)
    expect(history.undo()?.markdown).toBe('hello 你好')
    expect(history.undo()?.markdown).toBe('hello ')
    expect(history.redo()?.markdown).toBe('hello 你好')
  })
})
