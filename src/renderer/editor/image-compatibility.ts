import type { Ctx } from '@milkdown/kit/ctx'
import type { NodeSchema } from '@milkdown/kit/transformer'
import { imageBlockSchema } from '@milkdown/kit/component/image-block'
import { imageSchema } from '@milkdown/kit/preset/commonmark'
import { $remark } from '@milkdown/kit/utils'
import { blockImageAttributes, blockImageRatio, blockImageResizeWidth, remarkBlockImageCompatibility, serializeResizedBlockImage } from '../../shared/block-image-markdown'

/** Install before the application's general raw-HTML remark plugin. */
export const blockImageCompatibilityRemark = $remark('ttypora-block-image-compatibility', () => remarkBlockImageCompatibility)

/** MDAST uses null for an omitted image title, while the native inline schema
 * validates strings. Keep the native mapping and normalize only absent values.
 */
export function compatibleInlineImageSchema(previous: NodeSchema): NodeSchema {
  return {
    ...previous,
    parseMarkdown: {
      ...previous.parseMarkdown,
      runner: (state, node, type) => previous.parseMarkdown.runner(state, {
        ...node, alt: node.alt ?? '', title: node.title ?? '',
      }, type),
    },
  }
}

export function configureInlineImageCompatibility(ctx: Ctx): void {
  ctx.update(imageSchema.key, (previous) => (context) => compatibleInlineImageSchema(previous(context)))
}

/** Extend the existing Crepe schema so its native caption and resize node view stays usable. */
export function compatibleBlockImageSchema(previous: NodeSchema): NodeSchema {
  return {
    ...previous,
    attrs: { ...previous.attrs, alt: { default: '', validate: 'string' }, resizeWidth: { default: null, validate: 'number|null' } },
    parseDOM: [{
      tag: 'img[data-type="image-block"]',
      getAttrs: (element) => {
        if (typeof element === 'string') return false
        const width = element.getAttribute('width')
        return { src: element.getAttribute('src') ?? '', alt: element.getAttribute('alt') ?? '', caption: element.getAttribute('title') ?? element.getAttribute('caption') ?? '', ratio: blockImageRatio(Number(element.getAttribute('data-ttypora-ratio') ?? element.getAttribute('ratio') ?? 1)), resizeWidth: width && /^[\d.]+$/.test(width) ? blockImageResizeWidth(Number(width)) : null }
      },
    }],
    toDOM: (node) => ['img', { 'data-type': 'image-block', src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.caption, width: blockImageResizeWidth(node.attrs.resizeWidth) ?? `${Number((blockImageRatio(node.attrs.ratio) * 100).toPrecision(12))}%`, 'data-ttypora-ratio': blockImageRatio(node.attrs.ratio) }],
    parseMarkdown: {
      match: ({ type }) => type === 'image-block',
      runner: (state, node, type) => state.addNode(type, blockImageAttributes(node as { url?: unknown; alt?: unknown; title?: unknown; ttyporaRatio?: unknown; ttyporaResizeWidth?: unknown })),
    },
    toMarkdown: {
      match: (node) => node.type.name === 'image-block',
      runner: (state, node) => {
        const attributes = { src: String(node.attrs.src ?? ''), alt: String(node.attrs.alt ?? ''), caption: String(node.attrs.caption ?? ''), ratio: blockImageRatio(node.attrs.ratio), resizeWidth: blockImageResizeWidth(node.attrs.resizeWidth) }
        const html = serializeResizedBlockImage(attributes)
        if (html) { state.addNode('html', undefined, html); return }
        state.openNode('paragraph')
        state.addNode('image', undefined, undefined, { url: attributes.src, alt: attributes.alt, title: attributes.caption || null })
        state.closeNode()
      },
    },
  }
}

/** Call inside editor.config, before schema initialization. */
export function configureBlockImageCompatibility(ctx: Ctx): void {
  configureInlineImageCompatibility(ctx)
  ctx.update(imageBlockSchema.key, (previous) => (context) => compatibleBlockImageSchema(previous(context)))
}
