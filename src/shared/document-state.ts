export type DocumentLifecycleStatus =
  | 'new-clean'
  | 'clean'
  | 'dirty'
  | 'draft-pending'
  | 'saving'
  | 'save-error'
  | 'external-changed'
  | 'conflict'
  | 'recovered'

export interface DocumentLifecycle {
  status: DocumentLifecycleStatus
  hasPath: boolean
  dirty: boolean
  lastError: string | null
}

export type DocumentLifecycleEvent =
  | { type: 'edit' }
  | { type: 'draft-scheduled' }
  | { type: 'draft-written' }
  | { type: 'save-started' }
  | { type: 'save-succeeded'; hasPath: boolean }
  | { type: 'save-failed'; message: string }
  | { type: 'external-change' }
  | { type: 'reload-external' }
  | { type: 'restore-draft'; hasPath: boolean }
  | { type: 'discard' }

export function createDocumentLifecycle(hasPath = false): DocumentLifecycle {
  return {
    status: hasPath ? 'clean' : 'new-clean',
    hasPath,
    dirty: false,
    lastError: null,
  }
}

export function transitionDocumentLifecycle(
  state: DocumentLifecycle,
  event: DocumentLifecycleEvent,
): DocumentLifecycle {
  switch (event.type) {
    case 'edit':
      return {
        ...state,
        status: 'dirty',
        dirty: true,
        lastError: null,
      }
    case 'draft-scheduled':
      if (!state.dirty) return state
      return { ...state, status: 'draft-pending' }
    case 'draft-written':
      if (!state.dirty) return state
      return { ...state, status: 'dirty' }
    case 'save-started':
      if (!state.dirty && state.hasPath) return state
      return { ...state, status: 'saving', lastError: null }
    case 'save-succeeded':
      return {
        status: 'clean',
        hasPath: event.hasPath,
        dirty: false,
        lastError: null,
      }
    case 'save-failed':
      return {
        ...state,
        status: 'save-error',
        dirty: true,
        lastError: event.message,
      }
    case 'external-change':
      return {
        ...state,
        status: state.dirty ? 'conflict' : 'external-changed',
      }
    case 'reload-external':
      return {
        status: 'clean',
        hasPath: true,
        dirty: false,
        lastError: null,
      }
    case 'restore-draft':
      return {
        status: 'recovered',
        hasPath: event.hasPath,
        dirty: true,
        lastError: null,
      }
    case 'discard':
      return {
        status: state.hasPath ? 'clean' : 'new-clean',
        hasPath: state.hasPath,
        dirty: false,
        lastError: null,
      }
  }
}

