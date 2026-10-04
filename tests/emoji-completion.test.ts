import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { emojiCompletionSource } from '../src/renderer/editor/SourceEditor'

function completions(source: string, needle = ':smi') {
  const position = source.indexOf(needle) + needle.length
  const state = EditorState.create({ doc: source, extensions: [markdown()] })
  return emojiCompletionSource(new CompletionContext(state, position, true))
}

describe('source emoji completion', () => {
  it('completes names in prose and link labels while preserving shortcode source', () => {
    expect(completions('Hello :smi')?.options[0].apply).toBe(':smile:')
    expect(completions('中文 :smi')?.options[0].displayLabel).toBe('😄 :smile:')
    expect(completions('[:smi](https://example.com)')?.options[0].apply).toBe(':smile:')
    expect(completions(':smile::smi')?.options[0].apply).toBe(':smile:')
    expect(completions('Hello :unknown', ':unknown')).toBeNull()
  })
  it('suppresses completion in fenced and inline code, HTML, metadata, math and URL destinations', () => {
    for (const source of ['` :smi `', '```js\n:smi\n```', '<a title=":smi">text</a>', '[label](https://example.com?q=:smi)', '---\ntitle: :smi\n---', '$x :smi$', '$$\nx :smi\n$$']) expect(completions(source), source).toBeNull()
  })
  it('does not treat escaped, intra-word or URL-like colons as emoji triggers', () => {
    expect(completions('\\:smi')).toBeNull()
    expect(completions('word:smi')).toBeNull()
    expect(completions('https://:smi')).toBeNull()
  })
})
