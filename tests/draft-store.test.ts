import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DraftStore } from '../src/main/draft-store'
import type { RecoveryDraft } from '../src/shared/contracts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
const draft = (id: string, markdown: string): RecoveryDraft => ({ id, markdown, displayName: '草稿', sourcePath: null, format: { hasBom: false, lineEnding: 'lf' }, expectedVersion: null, updatedAt: new Date().toISOString(), schemaVersion: 1 })
describe('draft persistence ordering', () => {
  it('keeps the final keystroke when an older debounce write is still running', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ttypora-draft-')); temporary.push(directory)
    const store = new DraftStore(directory)
    await Promise.all([store.write(draft('a', 'old')), store.write(draft('a', 'last keystroke')), store.write(draft('b', 'another document'))])
    expect((await store.get('a'))?.markdown).toBe('last keystroke')
    expect((await store.get('b'))?.markdown).toBe('another document')
  })
  it('does not resurrect a draft after its document has been saved or discarded', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ttypora-draft-')); temporary.push(directory)
    const store = new DraftStore(directory)
    await Promise.all([store.write(draft('a', 'pending')), store.clear('a')])
    expect(await store.get('a')).toBeNull()
    expect(await store.list()).toEqual([])
  })
})
