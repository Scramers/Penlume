import { describe, expect, it } from 'vitest'
import { closeSessionDocument, newDocument, openSessionDocument, updateSessionDocument, type DocumentSession } from '../src/shared/document-session'

describe('document sessions', () => {
  const start = (): DocumentSession => { const doc = newDocument(); return { documents: [doc], activeId: doc.id } }
  it('replaces only a pristine startup placeholder', () => {
    const session = start(); const file = { ...newDocument(), path: 'C:\\note.md' }
    expect(openSessionDocument(session, file).documents).toEqual([file])
    session.documents[0].markdown = 'last keystroke'
    expect(openSessionDocument(session, file).documents).toHaveLength(2)
  })
  it('reopens case-insensitive paths without destroying their unsaved copy', () => {
    const original = { ...newDocument(), path: 'C:\\note.md', markdown: 'unsaved', recovered: true }
    const session = { documents: [original], activeId: original.id }
    const reopened = openSessionDocument(session, { ...newDocument(), path: 'c:/NOTE.md', markdown: 'disk' })
    expect(reopened.documents).toEqual([original]); expect(reopened.activeId).toBe(original.id)
  })
  it('routes delayed saves to their document without changing the active tab', () => {
    const a = newDocument(), b = newDocument()
    const session = updateSessionDocument({ documents: [a, b], activeId: b.id }, a.id, (doc) => ({ ...doc, savedMarkdown: 'saved a' }))
    expect(session.activeId).toBe(b.id); expect(session.documents[1]).toEqual(b)
    expect(session.documents[0].savedMarkdown).toBe('saved a')
    expect(updateSessionDocument(closeSessionDocument(session, a.id), a.id, () => a).documents).toEqual([b])
  })
  it('chooses a neighboring tab and creates a blank only after the last tab closes', () => {
    const a = newDocument(), b = newDocument(), c = newDocument()
    const next = closeSessionDocument({ documents: [a, b, c], activeId: b.id }, b.id)
    expect(next.activeId).toBe(c.id)
    const last = closeSessionDocument({ documents: [a], activeId: a.id }, a.id)
    expect(last.documents).toHaveLength(1); expect(last.activeId).not.toBe(a.id)
  })
})
