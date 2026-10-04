import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactElement } from 'react'

// Exercise the component's real mount, notification and teardown closures without
// requiring a browser. The harness separates render from passive effect cleanup,
// which is the ordering that exposed the cross-document notification.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void; effect?: () => void | (() => void) }
  const slots: Slot[] = []
  let index = 0
  let pending: number[] = []
  const changed = (before: readonly unknown[] | undefined, after: readonly unknown[] | undefined) => !before || !after || before.length !== after.length || after.some((value, i) => !Object.is(value, before[i]))
  return {
    begin: () => { index = 0 },
    reset: () => { slots.length = 0; pending = []; index = 0 },
    useRef: <T,>(value: T) => {
      const slot = slots[index++] ??= {}
      slot.value ??= { current: value }
      return slot.value as { current: T }
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const position = index++, slot = slots[position] ??= {}
      if (!changed(slot.dependencies, dependencies)) return
      slot.dependencies = dependencies; slot.effect = effect; pending.push(position)
    },
    useImperativeHandle: (ref: { current: unknown }, create: () => unknown) => { index++; ref.current = create() },
    commit: () => {
      const effects = pending; pending = []
      effects.forEach((position) => slots[position].cleanup?.())
      effects.forEach((position) => { slots[position].cleanup = slots[position].effect?.() || undefined })
    },
    unmount: () => { slots.forEach((slot) => slot.cleanup?.()); pending = [] },
  }
})
vi.mock('react', () => ({
  forwardRef: (component: unknown) => component,
  useRef: hooks.useRef,
  useEffect: hooks.useEffect,
  useImperativeHandle: hooks.useImperativeHandle,
}))

const adapters = vi.hoisted(() => {
  const instances: Adapter[] = []
  let nextMount: Promise<void> | undefined
  class Adapter {
    markdown: string
    bookmark = { anchor: 7, head: 9 }
    restored: unknown = null
    destroyed = false
    constructor(_root: unknown, markdown: string, readonly notify: (markdown: string) => void, _upload: unknown, _image: unknown, _extensions: unknown, _media: unknown, readonly context: (value: unknown) => void) {
      this.markdown = markdown; instances.push(this)
      this.mountResult = nextMount ?? Promise.resolve(); nextMount = undefined
    }
    private mountResult: Promise<void>
    mount = () => this.mountResult
    destroy = async () => { this.destroyed = true; this.context(null) }
    setPreferences = () => {}
    getMarkdown = () => this.markdown
    getBookmark = () => this.bookmark
    restoreBookmark = (value: unknown) => { this.restored = value }
    replaceMarkdown = (markdown: string) => { this.markdown = markdown }
    edit = (markdown: string) => { this.markdown = markdown; this.notify(markdown) }
  }
  return { Adapter, instances, reset: () => { instances.length = 0; nextMount = undefined }, deferNext: (promise: Promise<void>) => { nextMount = promise } }
})
vi.mock('../src/renderer/editor/crepe-adapter', () => ({ CrepeEditorAdapter: adapters.Adapter }))

import { MarkdownEditor, type MarkdownEditorHandle } from '../src/renderer/editor/MarkdownEditor'
import { defaultPreferences } from '../src/shared/preferences'

type Props = ComponentProps<typeof MarkdownEditor>
const handle: { current: MarkdownEditorHandle | null } = { current: null }
const props = (key: string): Props => ({ documentKey: key, initialMarkdown: `${key} original`, onChange: vi.fn(), onReady: vi.fn(), onLoading: vi.fn(), onError: vi.fn(), onTableContextChange: vi.fn(), onUploadImage: async () => '', onResolveImageUrl: () => '', onResolveMediaUrl: () => '' })
function render(value: Props) {
  hooks.begin()
  const element = (MarkdownEditor as unknown as (value: Props, ref: typeof handle) => ReactElement<{ ref: { current: unknown } }>)(value, handle)
  element.props.ref.current = {}
}
const settled = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const deferred = () => {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { hooks.reset(); adapters.reset(); handle.current = null })

describe('visual editor document lifecycle notifications', () => {
  it('flushes an unnotified history replacement to its original document during a switch', async () => {
    const first = props('first'), next = props('next')
    render(first); hooks.commit(); await settled()
    handle.current!.replaceMarkdown('first after undo')
    render(next)
    // A delayed native update in the render/cleanup interval cannot notify next.
    adapters.instances[0].notify('first delayed')
    hooks.commit(); await settled()
    expect(first.onChange).toHaveBeenCalledExactlyOnceWith('first after undo')
    expect(next.onChange).not.toHaveBeenCalled()
    expect(first.onLoading).toHaveBeenCalledOnce()
    expect(next.onLoading).not.toHaveBeenCalled()
    expect(handle.current!.getMarkdown()).toBe('next original')
    expect(adapters.instances[0].destroyed).toBe(true)
    expect(first.onTableContextChange).not.toHaveBeenCalled()
    expect(next.onTableContextChange).not.toHaveBeenCalled()
  })
  it('uses updated callbacks within the same document without creating another editor', async () => {
    const first = props('same')
    render(first); hooks.commit(); await settled()
    const updated = { ...first, onChange: vi.fn(), onLoading: vi.fn(), onTableContextChange: vi.fn() }
    render(updated); hooks.commit()
    adapters.instances[0].edit('latest typing')
    adapters.instances[0].context({ row: 2 })
    hooks.unmount(); await settled()
    expect(adapters.instances).toHaveLength(1)
    expect(first.onChange).not.toHaveBeenCalled()
    expect(updated.onChange).toHaveBeenCalledExactlyOnceWith('latest typing')
    expect(updated.onTableContextChange).toHaveBeenCalledExactlyOnceWith({ row: 2 })
    expect(updated.onLoading).toHaveBeenCalledOnce()
    expect(first.onLoading).not.toHaveBeenCalled()
  })
  it.each(['resolve', 'reject'] as const)('ignores a stale asynchronous mount %s after the next document renders', async (completion) => {
    const oldMount = deferred(), first = props('pending'), next = props('next')
    adapters.deferNext(oldMount.promise)
    render(first); hooks.commit(); await settled()
    render(next)
    if (completion === 'resolve') oldMount.resolve()
    else oldMount.reject(new Error('old initialization failed'))
    await settled()
    expect(first.onReady).not.toHaveBeenCalled(); expect(first.onError).not.toHaveBeenCalled()
    expect(next.onReady).not.toHaveBeenCalled(); expect(next.onError).not.toHaveBeenCalled()
    hooks.commit(); await settled()
    expect(next.onReady).toHaveBeenCalledOnce()
    expect(next.onError).not.toHaveBeenCalled()
    if (completion === 'resolve') expect(adapters.instances[0].destroyed).toBe(true)
  })
  it('preserves replaced content and its bookmark when extensions remount the same document', async () => {
    const first = props('same')
    render(first); hooks.commit(); await settled()
    handle.current!.replaceMarkdown('content after shared undo')
    const updated = { ...first, preferences: { ...defaultPreferences, markdownExtensions: { ...defaultPreferences.markdownExtensions, emoji: !defaultPreferences.markdownExtensions.emoji } }, onChange: vi.fn() }
    render(updated); hooks.commit(); await settled()
    expect(updated.onChange).toHaveBeenCalledExactlyOnceWith('content after shared undo')
    expect(first.onChange).not.toHaveBeenCalled()
    expect(adapters.instances).toHaveLength(2)
    expect(handle.current!.getMarkdown()).toBe('content after shared undo')
    expect(adapters.instances[1].restored).toEqual({ anchor: 7, head: 9 })
  })
})
