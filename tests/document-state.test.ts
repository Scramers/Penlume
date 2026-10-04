import { describe, expect, it } from 'vitest'
import {
  createDocumentLifecycle,
  transitionDocumentLifecycle,
} from '../src/shared/document-state'

describe('document lifecycle', () => {
  it('moves an existing document through edit, draft, save and clean', () => {
    let state = createDocumentLifecycle(true)
    state = transitionDocumentLifecycle(state, { type: 'edit' })
    expect(state.status).toBe('dirty')

    state = transitionDocumentLifecycle(state, { type: 'draft-scheduled' })
    expect(state.status).toBe('draft-pending')

    state = transitionDocumentLifecycle(state, { type: 'draft-written' })
    state = transitionDocumentLifecycle(state, { type: 'save-started' })
    state = transitionDocumentLifecycle(state, {
      type: 'save-succeeded',
      hasPath: true,
    })

    expect(state).toEqual({
      status: 'clean',
      hasPath: true,
      dirty: false,
      lastError: null,
    })
  })

  it('enters conflict only when local edits exist', () => {
    const clean = createDocumentLifecycle(true)
    expect(
      transitionDocumentLifecycle(clean, { type: 'external-change' }).status,
    ).toBe('external-changed')

    const dirty = transitionDocumentLifecycle(clean, { type: 'edit' })
    expect(
      transitionDocumentLifecycle(dirty, { type: 'external-change' }).status,
    ).toBe('conflict')
  })

  it('keeps dirty content after a failed save', () => {
    const dirty = transitionDocumentLifecycle(createDocumentLifecycle(), {
      type: 'edit',
    })
    const failed = transitionDocumentLifecycle(dirty, {
      type: 'save-failed',
      message: 'disk full',
    })

    expect(failed.status).toBe('save-error')
    expect(failed.dirty).toBe(true)
    expect(failed.lastError).toBe('disk full')
  })
})

