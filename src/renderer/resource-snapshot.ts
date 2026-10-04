import { splitFrontMatter } from '../shared/markdown-extensions'

export interface EditorResourceSnapshot {
  readonly documentId: string
  readonly documentPath: string | null
  readonly markdown: string
  readonly resourceRevision: number
}

/** Tracks resource context changes without making a document history boundary. */
export function createResourceSnapshotTracker() {
  const documents = new Map<string, { path: string | null; frontMatter: string; revision: number }>()
  let revision = 0
  return {
    capture(documentId: string, documentPath: string | null, markdown: string): EditorResourceSnapshot {
      const previous = documents.get(documentId)
      // Body edits cannot change a complete leading metadata block. Avoid scanning
      // a large document when that block is unchanged.
      const frontMatter = previous?.frontMatter && markdown.startsWith(previous.frontMatter)
        ? previous.frontMatter : splitFrontMatter(markdown).frontMatter
      if (!previous || previous.path !== documentPath || previous.frontMatter !== frontMatter) {
        documents.set(documentId, { path: documentPath, frontMatter, revision: ++revision })
      }
      return Object.freeze({ documentId, documentPath, markdown, resourceRevision: documents.get(documentId)!.revision })
    },
    forget(documentId: string): void { documents.delete(documentId) },
  }
}

export function isSameResourceSnapshot(a: EditorResourceSnapshot, b: EditorResourceSnapshot | null): boolean {
  return b !== null && a.documentId === b.documentId && a.documentPath === b.documentPath
    && a.resourceRevision === b.resourceRevision
}
