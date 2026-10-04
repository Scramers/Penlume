/** Shared prose layout. Apply before theme/custom CSS so those rules can override it. */
export function documentTypographyCss(scope: string): string {
  if (!scope.trim()) throw new Error('A document typography scope is required.')
  const root = `:is(${scope.trim()})`
  // Paragraphs and lists inside these views belong to their UI or renderer, not prose.
  const protectedViews = [
    `${root} [contenteditable="false"]`, '.milkdown-code-block', '.ttypora-code-block',
    '.ttypora-math-block', '.ttypora-math-inline', '.katex', '.code-export',
    '.media-card', '.media-reference-placeholder', '.image-reference-placeholder',
    '.mermaid-preview', '.mermaid-export', '.html-block', 'nav.document-toc', '.milkdown-table-block .drag-preview',
  ]
  const proseOnly = `:not(:where(${protectedViews.flatMap((selector) => [selector, `${selector} *`]).join(', ')}))`
  const prose = (selector: string) => `${root} ${selector}${proseOnly}`
  const headings = prose(':is(h1, h2, h3, h4, h5, h6)')
  const paragraphs = prose('p')
  const lists = prose(':is(ul, ol)')
  const items = prose('li')
  const quotes = prose('blockquote')
  const tables = prose('table')
  const compactParagraphs = `${root} :where(li, .milkdown-list-item-block .content-dom, blockquote, td, th) > p${proseOnly}`
  const nestedLists = `${root} :where(li, .milkdown-list-item-block .content-dom) > :is(ul, ol)${proseOnly}`

  return `${headings} { font-weight: 600; line-height: 1.35; margin-block: 1.5em .6em; padding-block: 0; }
${[2, 1.5, 1.25, 1.1, 1, .95].map((size, index) => `${prose(`h${index + 1}`)} { font-size: ${size}em; }`).join('\n')}
${paragraphs} { line-height: inherit; margin-block: 0 .9em; padding-block: 0; }
${lists} { margin-block: .75em 1em; padding-inline-start: 1.5em; }
${items} { line-height: inherit; margin-block: .2em; }
${nestedLists} { margin-block: .35em .5em; }
${compactParagraphs} { margin-block: 0 .35em; }
${quotes} { margin-block: 1em; padding-block: .25em; padding-inline: 1em; }
${tables} { margin-block: 1em; }
${root} :where(td, th) > p${proseOnly} { margin-block: .15em; }
${paragraphs}:where(:last-child) { margin-block-end: 0; }
${root} > :is(h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, table):where(:nth-child(1 of :not(.prosemirror-virtual-cursor, .ProseMirror-widget)))${proseOnly} { margin-block-start: 0; }`
}
