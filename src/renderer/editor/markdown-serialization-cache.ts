import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/** One immutable PM document owns one canonical serialization. Raw-source
 * fallback belongs to the adapter and must never be stored in this cache. */
export function createMarkdownSerializationCache() {
  let cachedDocument: ProseNode | null = null
  let cachedMarkdown = ''
  const clear = () => { cachedDocument = null; cachedMarkdown = '' }
  return {
    read(document: ProseNode, serialize: (document: ProseNode) => string): string {
      if (cachedDocument !== document) {
        // A failed serialization cannot retain the previous document's entry or
        // publish a partial value as the new document's canonical Markdown.
        clear()
        const markdown = serialize(document)
        cachedDocument = document
        cachedMarkdown = markdown
      }
      return cachedMarkdown
    },
    clear,
  }
}
