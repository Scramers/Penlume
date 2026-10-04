import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Extension } from '@codemirror/state'
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import { codeBlockView } from '@milkdown/kit/component/code-block'
import { $command, $inputRule, $node, $prose, $remark, $view } from '@milkdown/kit/utils'
import { InputRule, textblockTypeInputRule } from '@milkdown/kit/prose/inputrules'
import type { EditorState } from '@milkdown/kit/prose/state'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import remarkMath from 'remark-math'
import { compatibleCodeBlockSchema, displayMathSchema, inlineMathSchema } from './code-math-schema'
import { codeMetadataView, createDisplayMathView, inlineMathView } from './code-math-view'
import { createCodeMetadataPlugin } from './code-metadata'
import '../styles/code-math.css'

const mathRemark = $remark('ttypora-math', () => remarkMath)
export const displayMathNode = $node('math_block', displayMathSchema)
export const inlineMathNode = $node('math_inline', inlineMathSchema)

const blockInputRule = $inputRule((ctx) => textblockTypeInputRule(/^\$\$[\s\n]$/, displayMathNode.type(ctx)))
function protectedMathRange(state: EditorState, from: number, to: number): boolean {
  const $from = state.doc.resolve(from), $to = state.doc.resolve(to)
  if (!$from.sameParent($to) || $from.parent.type.spec.code || !$from.parent.inlineContent) return true
  if ([...(state.storedMarks ?? $from.marks()), ...$to.marks()].some((mark) => mark.type.spec.code)) return true
  let code = false
  state.doc.nodesBetween(from, to, (node) => { if (node.type.spec.code || node.marks.some((mark) => mark.type.spec.code)) code = true })
  return code
}
const inlineInputRule = $inputRule((ctx) => {
  return new InputRule(/(?<![$\\])\$([^$\n]+)\$$/, (state, match, from, to) => {
    if (protectedMathRange(state, from, to)) return null
    return state.tr.replaceWith(from, to, inlineMathNode.type(ctx).create({ value: match[1] ?? '' }))
  })
})

// Retain the upstream command name for application toolbar integrations, but do
// not register the upstream feature which conflates latex code and display math.
const toggleInlineMath = $command('ToggleLatex', (ctx) => () => (state, dispatch) => {
  if (state.selection instanceof NodeSelection && state.selection.node.type === inlineMathNode.type(ctx)) {
    const position = state.selection.from, value = String(state.selection.node.attrs.value)
    const transaction = state.tr.replaceWith(position, position + state.selection.node.nodeSize, value ? state.schema.text(value) : [])
    dispatch?.(transaction.setSelection(TextSelection.near(transaction.doc.resolve(position))))
    return true
  }
  if (protectedMathRange(state, state.selection.from, state.selection.to)) return false
  const { $from, $to } = state.selection
  if (!$from.parent.canReplaceWith($from.index(), $to.indexAfter(), inlineMathNode.type(ctx))) return false
  const transaction = state.tr.replaceSelectionWith(inlineMathNode.type(ctx).create({ value: state.doc.textBetween(state.selection.from, state.selection.to) }))
  dispatch?.(transaction.setSelection(NodeSelection.create(transaction.doc, state.selection.from)))
  return true
})

/** Call in editor.config, with Crepe.Feature.Latex disabled. */
export function configureCodeMathCompatibility(ctx: Ctx): void {
  ctx.update(codeBlockSchema.key, (previous) => (context) => compatibleCodeBlockSchema(previous(context)))
}

/** Register after Crepe's native code view, before application Markdown extensions. */
export function createCodeMathCompatibility(mathExtensions: Extension = []): MilkdownPlugin[] {
  return [mathRemark, displayMathNode, inlineMathNode, blockInputRule, inlineInputRule, toggleInlineMath, $prose(createCodeMetadataPlugin),
    $view(displayMathNode, () => createDisplayMathView(mathExtensions)), $view(inlineMathNode, () => inlineMathView),
    $view(codeBlockSchema.node, () => codeMetadataView(() => codeBlockView.view)),
  ].flat()
}
