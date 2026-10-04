import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import { InitReady, remarkPluginsCtx } from '@milkdown/kit/core'
import { hardbreakSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark'
import { tableCellSchema, tableHeaderSchema } from '@milkdown/kit/preset/gfm'
import { TextSelection, type Command } from '@milkdown/kit/prose/state'
import type { MarkdownNode, SerializerState } from '@milkdown/kit/transformer'

const inlineBreakHtml = '<span data-type="hardbreak"> </span>'

/** A table cell keeps one paragraph, even after consecutive Shift+Enter keys. */
export const insertTableHardbreakCommand: Command = (state, dispatch) => {
  const { selection, schema } = state
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to) ||
      selection.$from.parent.type.name !== 'paragraph' || selection.$from.depth < 2 ||
      !['table_cell', 'table_header'].includes(selection.$from.node(-1).type.name) || !schema.nodes.hardbreak) return false
  // Do not inherit formatting marks or set the native hardbreak meta: its
  // CommonMark filter intentionally rejects table transactions with that meta.
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hardbreak.create({ isInline: false }), false).scrollIntoView())
  return true
}

/** Keep editable hardbreak nodes on a single GFM table line, including at cell ends. */
export function configureTableHardbreakCompatibility(ctx: Ctx): void {
  // SerializerState exposes only its current stack element publicly. Scope the
  // native synchronous cell runner instead of relying on its protected ancestors.
  const cells = new WeakMap<SerializerState, number>()
  for (const cell of [tableCellSchema, tableHeaderSchema]) {
    ctx.update(cell.key, (previous) => (context) => {
      const schema = previous(context), native = schema.toMarkdown.runner
      return { ...schema, toMarkdown: { ...schema.toMarkdown, runner: (state, node) => {
        const depth = cells.get(state) ?? 0
        cells.set(state, depth + 1)
        try { return native(state, node) }
        finally { if (depth) cells.set(state, depth); else cells.delete(state) }
      } } }
    })
  }
  ctx.update(paragraphSchema.key, (previous) => (context) => {
    const schema = previous(context), native = schema.toMarkdown.runner
    return { ...schema, toMarkdown: { ...schema.toMarkdown, runner: (state, node) => {
      if (!cells.has(state)) return native(state, node)
      // Keep all real breaks and leave empty cells empty. The native paragraph
      // handler emits synthetic <br /> for empty paragraphs, which would otherwise
      // be parsed as a real break by this table compatibility layer.
      state.openNode('paragraph').next(node.content).closeNode()
    } } }
  })
  ctx.update(hardbreakSchema.key, (previous) => (context) => {
    const schema = previous(context), native = schema.toMarkdown.runner
    return { ...schema, toMarkdown: { ...schema.toMarkdown, runner: (state, node) => {
      if (!cells.has(state)) return native(state, node)
      // The span matches the native inline-break DOM (a visible space), while a
      // normal line break remains standard <br> for other Markdown renderers.
      state.addNode('html', undefined, node.attrs.isInline ? inlineBreakHtml : '<br>')
    } } }
  })
}

/** Interpret supported break HTML only within cells; inline code/text stays literal. */
export function transformTableHardbreaks(tree: MarkdownNode): void {
  const walk = (parent: MarkdownNode, inCell = false) => {
    if (!parent.children) return
    inCell ||= parent.type === 'tableCell'
    for (let index = 0; index < parent.children.length; index++) {
      const node = parent.children[index]
      if (inCell && node.type === 'html' && typeof node.value === 'string') {
        if (/^<br\s*\/?>$/i.test(node.value)) {
          parent.children[index] = { type: 'break', data: { isInline: false } }
          continue
        }
        const space = parent.children[index + 1], end = parent.children[index + 2]
        if (node.value === '<span data-type="hardbreak">' && space?.type === 'text' && space.value === ' ' &&
            end?.type === 'html' && end.value === '</span>') {
          parent.children.splice(index, 3, { type: 'break', data: { isInline: true } })
          continue
        }
      }
      walk(node, inCell)
    }
  }
  walk(tree)
}

/** Run before native empty-line preservation, which otherwise deletes table <br> HTML. */
export const tableHardbreakCompatibility: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(InitReady)
  const definition = { plugin: () => (tree: unknown) => transformTableHardbreaks(tree as MarkdownNode), options: {} }
  ctx.update(remarkPluginsCtx, (previous) => [definition, ...previous])
  return () => { ctx.update(remarkPluginsCtx, (previous) => previous.filter((plugin) => plugin !== definition)) }
}
