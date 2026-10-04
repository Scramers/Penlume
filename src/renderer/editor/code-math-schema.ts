import type { NodeSchema } from '@milkdown/kit/transformer'
import katex from 'katex'
import { codeMetadataLanguage, serializeCodeMetadata } from './code-metadata'

/** A fence's language and trailing info are independent of display-math syntax. */
export function compatibleCodeBlockSchema(previous: NodeSchema): NodeSchema {
  return {
    ...previous,
    attrs: { ...previous.attrs, meta: { default: null, validate: 'string|null' } },
    parseDOM: [{
      tag: 'pre:not([data-math-block])', preserveWhitespace: 'full',
      getAttrs: (element) => typeof element === 'string' ? false : { language: element.getAttribute('data-language') ?? '', meta: element.getAttribute('data-code-meta') },
    }],
    toDOM: (node) => ['pre', { 'data-language': node.attrs.language || null, 'data-code-meta': node.attrs.meta }, ['code', 0]],
    parseMarkdown: {
      match: ({ type }) => type === 'code',
      runner: (state, node, type) => {
        state.openNode(type, { language: typeof node.lang === 'string' ? node.lang : '', meta: typeof node.meta === 'string' ? node.meta : null })
        // Embedded CodeMirror represents line breaks as LF. The outer adapter
        // retains unopened source bytes; positions map back to the original CRLF.
        if (node.value) state.addText(String(node.value).replace(/\r\n?/g, '\n'))
        state.closeNode()
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'code_block',
      runner: (state, node) => state.addNode('code', undefined, node.textContent, {
        lang: codeMetadataLanguage(node.attrs.language, node.attrs.meta) || null,
        meta: serializeCodeMetadata(node.attrs.meta),
      }),
    },
  }
}

/** Only an mdast `math` node, never a code language, creates this schema node. */
export function displayMathSchema(): NodeSchema {
  return {
    group: 'block', content: 'text*', marks: '', code: true, defining: true,
    attrs: { meta: { default: null, validate: 'string|null' } },
    parseDOM: [{ tag: 'pre[data-math-block]', preserveWhitespace: 'full', getAttrs: (element) => typeof element === 'string' ? false : { meta: element.getAttribute('data-math-meta') } }],
    toDOM: (node) => ['pre', { 'data-math-block': 'true', 'data-math-meta': node.attrs.meta }, ['code', 0]],
    parseMarkdown: {
      match: ({ type }) => type === 'math',
      runner: (state, node, type) => {
        state.openNode(type, { meta: typeof node.meta === 'string' ? node.meta : null })
        // CodeMirror's document uses LF, matching code blocks. Source bookmarks
        // map each original CRLF independently without a phantom carriage return.
        if (node.value) state.addText(String(node.value).replace(/\r\n?/g, '\n'))
        state.closeNode()
      },
    },
    // The installed math info parser decodes references just like code info.
    // Preserve literal references and boundary whitespace before remark-math
    // applies its own escaping for dollars, backslashes and line endings.
    toMarkdown: { match: (node) => node.type.name === 'math_block', runner: (state, node) => state.addNode('math', undefined, node.textContent, { meta: serializeCodeMetadata(node.attrs.meta) }) },
  }
}

export function inlineMathSchema(): NodeSchema {
  return {
    group: 'inline', inline: true, atom: true,
    attrs: { value: { default: '', validate: 'string' } },
    parseDOM: [{ tag: 'span[data-type="math_inline"]', getAttrs: (element) => typeof element === 'string' ? false : { value: element.getAttribute('data-value') ?? '' } }],
    // The NodeView supplies a safe KaTeX preview. DOM clipboard keeps the exact source.
    toDOM: (node) => ['span', { 'data-type': 'math_inline', 'data-value': node.attrs.value }, String(node.attrs.value)],
    parseMarkdown: { match: ({ type }) => type === 'inlineMath', runner: (state, node, type) => state.addNode(type, { value: String(node.value ?? '') }) },
    toMarkdown: { match: (node) => node.type.name === 'math_inline', runner: (state, node) => {
      const value = String(node.attrs.value)
      // Empty formulas are editable drafts. Markdown's adjacent dollars do not
      // encode an empty inline formula and can consume the following paragraph.
      if (value !== '') state.addNode('inlineMath', undefined, value)
    } },
  }
}

export interface MathPreview { html: string | null; error: string | null }

/** Errors stay separate from user source, and URL/HTML commands never become trusted. */
export function renderMathPreview(source: string, displayMode: boolean): MathPreview {
  try {
    return { html: katex.renderToString(source, { displayMode, throwOnError: true, trust: false, strict: 'warn', output: 'htmlAndMathml' }), error: null }
  } catch (error) {
    return { html: null, error: error instanceof Error ? error.message : String(error) }
  }
}
