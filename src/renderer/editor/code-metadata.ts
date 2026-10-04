import { Plugin, type EditorState } from '@milkdown/kit/prose/state'
import { Mapping } from '@milkdown/kit/prose/transform'

/** A fence needs an info-language token before Markdown can retain metadata. */
export function codeMetadataLanguage(language: unknown, metadata: unknown): string {
  const current = typeof language === 'string' ? language : ''
  return typeof metadata === 'string' && metadata.length > 0 && !current.trim() ? 'text' : current
}

/** Code-info tokenization trims boundary whitespace and decodes character references. */
export function serializeCodeMetadata(metadata: unknown): string | null {
  if (typeof metadata !== 'string') return null
  return metadata.replaceAll('&', '&amp;').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, (value) =>
    Array.from(value, (character) => `&#x${character.charCodeAt(0).toString(16)};`).join(''))
}

/** Keep a metadata edit or native language clear atomic with its original history event. */
export function createCodeMetadataPlugin(): Plugin {
  return new Plugin({ appendTransaction: (transactions, previous, current: EditorState) => {
    if (!transactions.some((transaction) => transaction.docChanged)) return null
    const mapping = new Mapping()
    transactions.forEach((transaction) => mapping.appendMapping(transaction.mapping))
    const inverse = mapping.invert()
    let transaction = current.tr
    current.doc.descendants((node, position) => {
      if (node.type.name !== 'code_block') return
      const language = codeMetadataLanguage(node.attrs.language, node.attrs.meta)
      if (language === node.attrs.language) return false
      const oldPosition = inverse.mapResult(position)
      const oldNode = previous.doc.nodeAt(oldPosition.pos)
      // Loading a document or editing a different block must not relabel an
      // untouched fence. New and changed code nodes are the only repair targets.
      if (!oldPosition.deleted && oldNode?.eq(node)) return false
      transaction = transaction.setNodeAttribute(position, 'language', language)
      return false
    })
    return transaction.docChanged ? transaction : null
  } })
}
