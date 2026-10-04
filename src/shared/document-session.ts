import type { DocumentSnapshot, ExternalFileChange, RecoveryDraft, TextFormat } from './contracts'

export interface ActiveDocument {
  id: string
  path: string | null
  displayName: string
  markdown: string
  savedMarkdown: string
  format: TextFormat
  version: DocumentSnapshot['version'] | null
  revision: number
  recovered: boolean
  conflict?: ExternalFileChange | null
}

export interface DocumentSession { documents: ActiveDocument[]; activeId: string }
export const samePath = (left: string | null, right: string): boolean =>
  Boolean(left && left.replaceAll('\\', '/').toLocaleLowerCase() === right.replaceAll('\\', '/').toLocaleLowerCase())
export const isDirty = (document: ActiveDocument): boolean => document.recovered || document.markdown !== document.savedMarkdown
export function newDocument(): ActiveDocument {
  return { id: crypto.randomUUID(), path: null, displayName: '未命名文档', markdown: '', savedMarkdown: '', format: { hasBom: false, lineEnding: 'lf' }, version: null, revision: 0, recovered: false }
}
export function fromSnapshot(snapshot: DocumentSnapshot): ActiveDocument {
  return { ...newDocument(), ...snapshot, savedMarkdown: snapshot.markdown }
}
export function draftFromDocument(document: ActiveDocument, markdown = document.markdown): RecoveryDraft {
  return { id: document.id, sourcePath: document.path, displayName: document.displayName, markdown, format: document.format, expectedVersion: document.version, updatedAt: new Date().toISOString(), schemaVersion: 1 }
}
export function openSessionDocument(session: DocumentSession, document: ActiveDocument): DocumentSession {
  const existing = session.documents.find((item) => item.id === document.id || (document.path && samePath(item.path, document.path)))
  // Reopening a file activates its working copy, including unsaved changes.
  if (existing) return { ...session, activeId: existing.id }
  const replacePlaceholder = session.documents.length === 1 && !session.documents[0].path && !isDirty(session.documents[0]) && !session.documents[0].markdown
  return { documents: [...(replacePlaceholder ? [] : session.documents), document], activeId: document.id }
}
export function updateSessionDocument(session: DocumentSession, id: string, update: (document: ActiveDocument) => ActiveDocument): DocumentSession {
  return { ...session, documents: session.documents.map((document) => document.id === id ? update(document) : document) }
}
export function closeSessionDocument(session: DocumentSession, id: string): DocumentSession {
  const index = session.documents.findIndex((document) => document.id === id)
  if (index < 0) return session
  const documents = session.documents.filter((document) => document.id !== id)
  if (!documents.length) { const blank = newDocument(); return { documents: [blank], activeId: blank.id } }
  return { documents, activeId: session.activeId === id ? documents[Math.min(index, documents.length - 1)].id : session.activeId }
}
