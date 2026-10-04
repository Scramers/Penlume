import { afterEach, describe, expect, it, vi } from 'vitest'
import { Clock, Container, Ctx } from '@milkdown/kit/ctx'
import { CommandManager, CommandsReady, InitReady, SchemaReady, commandsCtx, editorViewCtx, inputRulesCtx, markViewCtx, nodeViewCtx, nodesCtx, prosePluginsCtx, remarkPluginsCtx, schemaCtx } from '@milkdown/kit/core'
import { customInputRules } from '@milkdown/kit/prose'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { history, undo } from '@milkdown/kit/prose/history'
import { createCodeMathCompatibility } from '../src/renderer/editor/code-math-compatibility'
import { compatibleCodeBlockSchema, displayMathSchema, inlineMathSchema } from '../src/renderer/editor/code-math-schema'
import { markdownTextBlocks } from '../src/renderer/editor/markdown-position'

afterEach(() => vi.unstubAllGlobals())

async function harness(text: string, options: { codeBlock?: boolean; inlineCode?: boolean } = {}) {
  const lifecycle = new EventTarget()
  vi.stubGlobal('dispatchEvent', lifecycle.dispatchEvent.bind(lifecycle))
  vi.stubGlobal('addEventListener', lifecycle.addEventListener.bind(lifecycle))
  vi.stubGlobal('removeEventListener', lifecycle.removeEventListener.bind(lifecycle))
  const ctx = new Ctx(new Container(), new Clock())
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' }, text: { group: 'inline' },
    code_block: compatibleCodeBlockSchema({ group: 'block', content: 'text*', marks: '', code: true, attrs: { language: { default: '' } }, parseMarkdown: { match: () => false, runner: () => undefined }, toMarkdown: { match: () => false, runner: () => undefined } }),
    math_block: displayMathSchema(), math_inline: inlineMathSchema(),
  }, marks: { inlineCode: { code: true, inclusive: false } } })
  const marks = options.inlineCode ? [schema.marks.inlineCode.create()] : []
  const doc = schema.node('doc', null, schema.node(options.codeBlock ? 'code_block' : 'paragraph', null, text ? schema.text(text, marks) : []))
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, text.length + 1), plugins: [history()] })
  const dispatch = (tr: Transaction) => { state = state.apply(tr); state.doc.check() }
  const view = { get state() { return state }, editable: true, composing: false, dispatch } as unknown as EditorView
  const commands = new CommandManager()
  commands.setCtx(ctx)
  ctx.inject(schemaCtx, schema).inject(commandsCtx, commands).inject(editorViewCtx, view)
    .inject(nodesCtx, []).inject(remarkPluginsCtx, []).inject(inputRulesCtx, []).inject(nodeViewCtx, []).inject(markViewCtx, []).inject(prosePluginsCtx, [])
  for (const timer of [InitReady, SchemaReady, CommandsReady]) {
    ctx.record(timer)
    const ready = ctx.wait(timer)
    ctx.done(timer)
    await ready
  }
  for (const plugin of createCodeMathCompatibility()) await plugin(ctx)()
  const input = customInputRules({ rules: ctx.get(inputRulesCtx) })
  return { ctx, commands, dispatch, view, schema, state: () => state, type: (value: string) => input.props.handleTextInput?.call(input, view, state.selection.from, state.selection.to, value, () => state.tr) }
}

describe('real math registration and literal input boundaries', () => {
  it('creates inline math through the registered Milkdown input rule in prose and reverses the command', async () => {
    const editor = await harness('$x')
    expect(editor.type('$')).toBe(true)
    const formula = editor.state().doc.firstChild?.firstChild
    expect(formula?.type.name).toBe('math_inline')
    expect(formula?.attrs.value).toBe('x')
    editor.dispatch(editor.state().tr.setSelection(NodeSelection.create(editor.state().doc, 1)))
    expect(editor.commands.call('ToggleLatex')).toBe(true)
    expect(editor.state().doc.textContent).toBe('x')
    expect(undo(editor.state(), editor.dispatch)).toBe(true)
    expect(editor.state().doc.textContent).toBe('$x')
  })

  it('keeps dollar-delimited input literal inside an existing inline code mark', async () => {
    const editor = await harness('$x', { inlineCode: true })
    expect(editor.type('$')).toBe(false)
    expect(editor.state().doc.firstChild?.firstChild?.type.name).toBe('text')
    expect(editor.state().doc.textContent).toBe('$x')
  })

  it('refuses explicit inline-math conversion inside a code fence without changing source', async () => {
    const editor = await harness('x+y', { codeBlock: true })
    editor.dispatch(editor.state().tr.setSelection(TextSelection.create(editor.state().doc, 1, 4)))
    const original = editor.state().doc
    expect(editor.commands.call('ToggleLatex')).toBe(false)
    expect(editor.state().doc.eq(original)).toBe(true)
  })
})

describe('full smoke source mappings', () => {
  it('locates the list formula independently of preceding root and quote formulas after serialization', () => {
    const source = '# 公式与代码\n\nBody paragraph. edited\n\n```latex title="example.tex" {1,3-5}\n\\begin{document}\n普通代码正文\n\\end{document}\n```\n\n```math title="math-code.txt"\nMATH-CODE stays literal\n```\n\n$$equation-root\nx^2 + y^2\n$$\n\n> $$equation-quote\n> a+b=c\n> $$\n\n* Item\n\n  $$equation-list\n  c+d=e\n  $$\n\n$$\n\\frac{a}\n$$\n\nInline broken $\\unknowncommand$.\n\nTail.\n'
    const blocks = markdownTextBlocks(source)
    expect(blocks.map(({ type, text }) => [type, text])).toEqual([
      ['heading', '公式与代码'], ['paragraph', 'Body paragraph. edited'],
      ['code', '\\begin{document}\n普通代码正文\n\\end{document}'], ['code', 'MATH-CODE stays literal'],
      ['math', 'x^2 + y^2'], ['math', 'a+b=c'], ['paragraph', 'Item'], ['math', 'c+d=e'], ['math', '\\frac{a}'], ['paragraph', 'Inline broken \ufffc.'], ['paragraph', 'Tail.'],
    ])
    const list = blocks.find((block) => block.type === 'math' && block.text === 'c+d=e')!
    expect(source.slice(list.offsets[0], list.endOffsets[3])).toBe('c+d')
    expect(list.offsets[0]).toBe(source.indexOf('c+d=e'))
    expect(list.from).toBe(source.indexOf('$$equation-list'))
  })
})
