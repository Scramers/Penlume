import { describe, expect, it } from 'vitest'
import { createResourceSnapshotTracker, isSameResourceSnapshot } from '../src/renderer/resource-snapshot'

const root = (value: string, body = '正文') => `---\ntypora-root-url: ${value}\n---\n${body}`

describe('resource snapshot ownership', () => {
  it('uses the current raw body but preserves revision for body-only typing', () => {
    const tracker = createResourceSnapshotTracker()
    const first = tracker.capture('one', 'C:/notes/one.md', root('../assets'))
    const next = tracker.capture('one', 'C:/notes/one.md', root('../assets', '正文new'))
    expect(isSameResourceSnapshot(first, next)).toBe(true)
    expect(next.markdown).toBe(root('../assets', '正文new'))
    expect(Object.isFrozen(next)).toBe(true)
  })
  it('rejects a pending result after a root change even when the root is later restored', () => {
    const tracker = createResourceSnapshotTracker()
    const first = tracker.capture('one', 'C:/notes/one.md', root('../a'))
    tracker.capture('one', 'C:/notes/one.md', root('../b'))
    const restored = tracker.capture('one', 'C:/notes/one.md', root('../a'))
    expect(isSameResourceSnapshot(first, restored)).toBe(false)
  })
  it('tracks raw metadata changes without interpreting unsupported or invalid YAML', () => {
    const tracker = createResourceSnapshotTracker()
    const first = tracker.capture('one', 'C:/one.md', root('${filename}'))
    const changed = tracker.capture('one', 'C:/one.md', '---\ntypora-root-url: [\n---\n正文')
    expect(isSameResourceSnapshot(first, changed)).toBe(false)
    expect(changed.markdown).toContain('typora-root-url: [')
  })
  it('changes revision when metadata is removed or added', () => {
    const tracker = createResourceSnapshotTracker()
    const first = tracker.capture('one', 'C:/one.md', root('../a'))
    const removed = tracker.capture('one', 'C:/one.md', '正文')
    const added = tracker.capture('one', 'C:/one.md', root('../a'))
    expect(isSameResourceSnapshot(first, removed)).toBe(false)
    expect(isSameResourceSnapshot(first, added)).toBe(false)
  })
  it('rejects results belonging to another document or saved path', () => {
    const tracker = createResourceSnapshotTracker()
    const first = tracker.capture('one', null, root('../a'))
    const saved = tracker.capture('one', 'C:/one.md', root('../a'))
    const other = tracker.capture('two', 'C:/one.md', root('../a'))
    expect(isSameResourceSnapshot(first, saved)).toBe(false)
    expect(isSameResourceSnapshot(saved, other)).toBe(false)
    expect(isSameResourceSnapshot(saved, null)).toBe(false)
  })
  it('does not reuse a revision after a document closes and reopens', () => {
    const tracker = createResourceSnapshotTracker()
    const first = tracker.capture('one', 'C:/one.md', root('../a'))
    tracker.forget('one')
    const reopened = tracker.capture('one', 'C:/one.md', root('../a'))
    expect(isSameResourceSnapshot(first, reopened)).toBe(false)
  })
  it('keeps independent document revisions when other tabs change', () => {
    const tracker = createResourceSnapshotTracker()
    const one = tracker.capture('one', 'C:/one.md', root('../a'))
    tracker.capture('two', 'C:/two.md', root('../b'))
    tracker.capture('two', 'C:/two.md', root('../c'))
    expect(isSameResourceSnapshot(one, tracker.capture('one', 'C:/one.md', root('../a')))).toBe(true)
  })
})
