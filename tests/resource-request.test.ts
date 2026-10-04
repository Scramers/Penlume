import { describe, expect, it } from 'vitest'
import { exportDocumentRequestSchema, resourceDocumentSnapshotSchema } from '../src/shared/schemas'

describe('raw resource document IPC snapshots', () => {
  it('requires a bounded raw snapshot and retains metadata bytes without normalization', () => {
    const markdown = '---\r\ntypora-root-url: "../图片%2520"\r\n---\r\n![图](/cover.png)\r\n'
    expect(resourceDocumentSnapshotSchema.parse({ documentPath: 'C:/notes/稿件.md', markdown })).toEqual({ documentPath: 'C:/notes/稿件.md', markdown })
    for (const input of ['C:/notes/a.md', { documentPath: 'C:/notes/a.md' }, { documentPath: '', markdown }, { documentPath: 'C:/notes/a.md', markdown: 'x'.repeat(20 * 1024 * 1024 + 1) }]) {
      expect(resourceDocumentSnapshotSchema.safeParse(input).success).toBe(false)
    }
  })
  it('refuses renderer-supplied contexts, candidates and access grants', () => {
    const snapshot = { documentPath: 'C:/notes/a.md', markdown: '---\ntypora-root-url: ../private\n---\n' }
    for (const extra of [{ candidatePath: 'C:/private/secret.png' }, { authorizedRoot: 'C:/' }, { context: { root: { status: 'local', candidatePath: 'C:/' } } }]) {
      expect(resourceDocumentSnapshotSchema.safeParse({ ...snapshot, ...extra }).success).toBe(false)
    }
  })
  it('requires export HTML and raw Markdown from the same explicit request', () => {
    const request = { html: '<!doctype html><img src="cover.png">', sourcePath: 'C:/notes/a.md', suggestedName: 'a.html' }
    expect(exportDocumentRequestSchema.safeParse(request).success).toBe(false)
    const markdown = '---\ntypora-root-url: ../images\n---\n![image](cover.png)'
    expect(exportDocumentRequestSchema.parse({ ...request, markdown }).markdown).toBe(markdown)
    expect(exportDocumentRequestSchema.safeParse({ ...request, sourcePath: null, markdown }).success).toBe(true)
  })
})
