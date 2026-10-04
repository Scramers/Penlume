import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { defaultPreferences } from '../src/shared/preferences'
import { createCodePreferences } from '../src/renderer/editor/code-preferences'

function configured(codeLineNumbers: boolean) {
  const controller = createCodePreferences(() => ({ ...defaultPreferences, codeLineNumbers }))
  const state = EditorState.create({ doc: 'const original = 1', extensions: [controller.extension] })
  return { controller, state, modules: state.facet(EditorView.styleModule) }
}

describe('code line number preference CSS', () => {
  it('overrides the native important gutter display with a scoped, more specific rule', () => {
    const { controller, state, modules } = configured(false)
    const rule = modules.flatMap((module) => module.getRules().split('\n')).find((rule) => /display:\s*none\s*!important/.test(rule))
    // .cm-gutter has display:flex !important in CodeMirror's base theme.
    // Both classes plus the generated editor scope are needed to win that cascade.
    expect(rule).toMatch(/^\.\S+ \.cm-gutter\.cm-lineNumbers \{display: none !important;\}$/)
    expect(rule).not.toMatch(/\.cm-foldGutter|\.cm-gutters(?:\s|\.)/)
    expect(state.doc.toString()).toBe('const original = 1')
    controller.destroy()
  })

  it('restores the native visible gutter by removing the override when enabled', () => {
    const { controller, modules } = configured(true)
    expect(modules.map((module) => module.getRules()).join('\n')).not.toMatch(/cm-lineNumbers[^}]*display:\s*none/)
    controller.destroy()
  })

  it('reuses one hidden style module across independently configured views', () => {
    const first = configured(false), second = configured(false)
    const hidden = (modules: typeof first.modules) => modules.find((module) => /cm-lineNumbers[^}]*display:\s*none/.test(module.getRules()))
    expect(hidden(first.modules)).toBe(hidden(second.modules))
    first.controller.destroy(); second.controller.destroy()
  })
})
