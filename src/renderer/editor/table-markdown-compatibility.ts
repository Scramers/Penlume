import type { Ctx } from '@milkdown/kit/ctx'
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import type { MarkdownNode } from '@milkdown/kit/transformer'
import { $remark } from '@milkdown/kit/utils'
import type { Options } from 'remark-stringify'

/** GFM trims literal cell padding. Character references preserve intended edge whitespace. */
export function compatibleTableMarkdownOptions(previous: Options): Options {
  const text = previous.handlers?.text
  return { ...previous, handlers: { ...previous.handlers, text: (node, parent, state, info) => {
    if (!state.stack.includes('tableCell')) return text ? text(node, parent, state, info) : state.safe(node.value, info)
    // Use the active GFM unsafe rules, including pipes and line terminators. The
    // core's trailing-whitespace shortcut would bypass those escaping rules.
    return state.safe(node.value, { ...info, encode: [] }).replace(/^[\t ]+|[\t ]+$/g, (value) =>
      Array.from(value, (character) => character === '\t' ? '&#x9;' : '&#x20;').join(''))
  } } }
}

export function configureTableMarkdownCompatibility(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, compatibleTableMarkdownOptions)
}

/** Same soft-break transformation as CommonMark's remarkLineBreak, outside table cells. */
export function transformTableCompatibleLineBreaks(tree: MarkdownNode): void {
  const find = /[\t ]*(?:\r?\n|\r)/g
  const walk = (parent: MarkdownNode) => {
    if (parent.type === 'tableCell' || !parent.children) return
    for (let index = 0; index < parent.children.length; index++) {
      const node = parent.children[index]
      if (node.type !== 'text' || typeof node.value !== 'string' || !node.value) { walk(node); continue }
      const result: MarkdownNode[] = []
      let start = 0
      find.lastIndex = 0
      let match = find.exec(node.value)
      while (match) {
        if (start !== match.index) result.push({ type: 'text', value: node.value.slice(start, match.index) })
        result.push({ type: 'break', data: { isInline: true } })
        start = match.index + match[0].length
        match = find.exec(node.value)
      }
      if (!result.length) continue
      if (start < node.value.length) result.push({ type: 'text', value: node.value.slice(start) })
      parent.children.splice(index, 1, ...result)
      index += result.length - 1
    }
  }
  walk(tree)
}

/** Remove remarkLineBreak.plugin and register this replacement; no schema/atomic nodes change. */
export const tableLineBreakCompatibility = $remark('ttyporaTableLineBreak', () => () => (tree) => transformTableCompatibleLineBreaks(tree as unknown as MarkdownNode))
