import { useCallback, useRef, useState } from 'react'
import { closeSessionDocument, newDocument, openSessionDocument, updateSessionDocument, type ActiveDocument, type DocumentSession } from '../shared/document-session'

export function useDocumentSession() {
  const [session, setSession] = useState<DocumentSession>(() => { const document = newDocument(); return { documents: [document], activeId: document.id } })
  const sessionRef = useRef(session)
  const documentRef = useRef(session.documents[0])
  const commit = useCallback((update: (state: DocumentSession) => DocumentSession) => {
    const next = update(sessionRef.current)
    sessionRef.current = next
    documentRef.current = next.documents.find((document) => document.id === next.activeId)!
    setSession(next)
  }, [])
  const setDocument = useCallback((update: ActiveDocument | ((document: ActiveDocument) => ActiveDocument)) => {
    commit((state) => typeof update === 'function' ? updateSessionDocument(state, state.activeId, update) : openSessionDocument(state, update))
  }, [commit])
  const updateDocument = useCallback((id: string, update: (document: ActiveDocument) => ActiveDocument) => commit((state) => updateSessionDocument(state, id, update)), [commit])
  const activateDocument = useCallback((id: string) => commit((state) => state.documents.some((document) => document.id === id) ? { ...state, activeId: id } : state), [commit])
  const removeDocument = useCallback((id: string) => commit((state) => closeSessionDocument(state, id)), [commit])
  return { session, sessionRef, document: session.documents.find((document) => document.id === session.activeId)!, documentRef, setDocument, updateDocument, activateDocument, removeDocument }
}
