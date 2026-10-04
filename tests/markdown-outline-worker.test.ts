import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMarkdownOutlineClient, isCurrentMarkdownOutlineSnapshot, markdownOutlineOptions, useMarkdownOutline,
  type MarkdownOutlineIdentity, type MarkdownOutlineRequest, type MarkdownOutlineResponse,
  type MarkdownOutlineSnapshot, type OutlineWorker,
} from '../src/renderer/use-markdown-outline'
import { defaultMarkdownExtensions } from '../src/shared/preferences'

class WorkerDouble implements OutlineWorker {
  requests: MarkdownOutlineRequest[] = []
  terminate = vi.fn()
  onmessage: OutlineWorker['onmessage'] = null
  onerror: OutlineWorker['onerror'] = null
  onmessageerror: OutlineWorker['onmessageerror'] = null
  postMessage(request: MarkdownOutlineRequest) { this.requests.push(request) }
  reply(request: MarkdownOutlineIdentity, kind: 'result' | 'error' = 'result') {
    const payload: MarkdownOutlineResponse = kind === 'result'
      ? { ...request, kind, headings: [{ level: 1, line: 1, text: 'Repeat' }, { level: 2, line: 3, text: 'Repeat' }] }
      : { ...request, kind, error: 'Parser failed' }
    this.onmessage?.({ data: payload } as MessageEvent<MarkdownOutlineResponse>)
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function client() {
  const worker = new WorkerDouble(), onSnapshot = vi.fn<(snapshot: MarkdownOutlineSnapshot) => void>(), onError = vi.fn()
  const connection = createMarkdownOutlineClient({ createWorker: () => worker, onSnapshot, onError })
  return { worker, onSnapshot, onError, ...connection }
}

describe('outline background scheduling and identities', () => {
  it('submits only after 150ms and does not publish any headings before a worker result', () => {
    const e = client()
    e.request('doc', '# First')
    vi.advanceTimersByTime(149)
    expect(e.worker.requests).toEqual([])
    expect(e.onSnapshot).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(e.worker.requests).toHaveLength(1)
    e.worker.reply(e.worker.requests[0])
    expect(e.onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ documentKey: 'doc', markdown: '# First', headings: expect.arrayContaining([{ level: 2, line: 3, text: 'Repeat' }]) }))
    e.dispose()
  })

  it('coalesces a burst into the exact final raw snapshot without posting every edit', () => {
    const e = client()
    for (let index = 0; index < 20; index++) { e.request('doc', `# Draft ${index}`); vi.advanceTimersByTime(10) }
    expect(e.worker.requests).toEqual([])
    vi.advanceTimersByTime(139)
    expect(e.worker.requests).toEqual([])
    vi.advanceTimersByTime(1)
    expect(e.worker.requests).toHaveLength(1)
    expect(e.worker.requests[0].markdown).toBe('# Draft 19')
    e.dispose()
  })

  it('keeps one in-flight parse and replaces all waiting drafts with a single latest request', () => {
    const e = client()
    e.request('doc', '# Initial'); vi.advanceTimersByTime(150)
    const initial = e.worker.requests[0]
    for (let index = 0; index < 50; index++) { e.request('doc', `# Body ${index}`); vi.advanceTimersByTime(10) }
    vi.advanceTimersByTime(150)
    expect(e.worker.requests).toHaveLength(1)
    e.worker.reply(initial)
    expect(e.onSnapshot).not.toHaveBeenCalled()
    expect(e.worker.requests).toHaveLength(2)
    expect(e.worker.requests[1].markdown).toBe('# Body 49')
    e.worker.reply(e.worker.requests[1])
    expect(e.onSnapshot).toHaveBeenCalledTimes(1)
    expect(e.onSnapshot.mock.calls[0][0].markdown).toBe('# Body 49')
    e.dispose()
  })

  it('does not bypass the newest debounce interval when an older parse finishes early', () => {
    const e = client()
    e.request('doc', '# Initial'); vi.advanceTimersByTime(150)
    e.request('doc', '# New'); vi.advanceTimersByTime(10)
    e.worker.reply(e.worker.requests[0])
    expect(e.worker.requests).toHaveLength(1)
    vi.advanceTimersByTime(139)
    expect(e.worker.requests).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(e.worker.requests).toHaveLength(2)
    e.dispose()
  })

  it.each(['documentKey', 'revision', 'optionsKey'] as const)('ignores a mismatched response %s without releasing the genuine in-flight slot', (field) => {
    const e = client()
    e.request('doc', '# Initial'); vi.advanceTimersByTime(150)
    e.request('doc', '# Latest'); vi.advanceTimersByTime(150)
    const wrong = { ...e.worker.requests[0], [field]: field === 'revision' ? -1 : 'wrong' }
    e.worker.reply(wrong as MarkdownOutlineIdentity)
    expect(e.worker.requests).toHaveLength(1)
    expect(e.onSnapshot).not.toHaveBeenCalled()
    e.worker.reply(e.worker.requests[0])
    expect(e.worker.requests).toHaveLength(2)
    e.dispose()
  })

  it('rejects old results across a document change even if source bytes and options are identical', () => {
    const e = client()
    e.request('A', '# Same'); vi.advanceTimersByTime(150)
    e.request('B', '# Same'); vi.advanceTimersByTime(150)
    e.worker.reply(e.worker.requests[0])
    expect(e.onSnapshot).not.toHaveBeenCalled()
    expect(e.worker.requests[1].documentKey).toBe('B')
    e.worker.reply(e.worker.requests[1])
    expect(e.onSnapshot.mock.calls[0][0].documentKey).toBe('B')
    e.dispose()
  })

  it('rejects an A/B/A stale revision even when the final raw bytes match the first request', () => {
    const e = client()
    e.request('doc', '# A'); vi.advanceTimersByTime(150)
    e.request('doc', '# B'); e.request('doc', '# A'); vi.advanceTimersByTime(150)
    e.worker.reply(e.worker.requests[0])
    expect(e.onSnapshot).not.toHaveBeenCalled()
    expect(e.worker.requests[1].markdown).toBe('# A')
    expect(e.worker.requests[1].revision).toBeGreaterThan(e.worker.requests[0].revision)
    e.worker.reply(e.worker.requests[1])
    expect(e.onSnapshot).toHaveBeenCalledTimes(1)
    e.dispose()
  })

  it('uses normalized exact option values and does not parse equivalent reordered option objects again', () => {
    const e = client()
    const first = e.request('doc', '# :smile:', { emoji: false, underline: true })
    vi.advanceTimersByTime(150)
    e.worker.reply(e.worker.requests[0])
    const equivalent = e.request('doc', '# :smile:', { underline: true, emoji: false, highlight: true })
    vi.advanceTimersByTime(1_000)
    expect(equivalent).toEqual(first)
    expect(e.worker.requests).toHaveLength(1)
    const changed = e.request('doc', '# :smile:', { emoji: true })
    vi.advanceTimersByTime(150)
    expect(changed?.revision).toBeGreaterThan(first!.revision)
    expect(e.worker.requests).toHaveLength(2)
    e.dispose()
  })

  it('copies primitive options at submission so later caller mutation cannot change the queued parse', () => {
    const e = client(), options = { ...defaultMarkdownExtensions }
    e.request('doc', '# :smile:', options)
    options.emoji = false
    vi.advanceTimersByTime(150)
    expect(e.worker.requests[0].options.emoji).toBe(true)
    expect(e.worker.requests[0].optionsKey).toBe(markdownOutlineOptions({ emoji: true }).optionsKey)
    e.dispose()
  })

  it('clears pending timers, terminates once and rejects captured late callbacks after disposal', () => {
    const e = client()
    e.request('doc', '# First'); vi.advanceTimersByTime(150)
    const handler = e.worker.onmessage!, request = e.worker.requests[0]
    e.request('doc', '# Waiting')
    e.dispose(); e.dispose()
    vi.advanceTimersByTime(1_000)
    handler(new MessageEvent<MarkdownOutlineResponse>('message', {
      data: { ...request, kind: 'result', headings: [] },
    }))
    expect(e.request('doc', '# Closed')).toBeNull()
    expect(e.worker.requests).toHaveLength(1)
    expect(e.worker.terminate).toHaveBeenCalledTimes(1)
    expect(e.worker.onmessage).toBeNull()
    expect(e.onSnapshot).not.toHaveBeenCalled()
  })

  it('reports only a current parse error, then allows a new revision on the same worker', () => {
    const e = client()
    e.request('doc', '# Old'); vi.advanceTimersByTime(150)
    e.request('doc', '# Current'); vi.advanceTimersByTime(150)
    e.worker.reply(e.worker.requests[0], 'error')
    expect(e.onError).not.toHaveBeenCalled()
    e.worker.reply(e.worker.requests[1], 'error')
    expect(e.onError).toHaveBeenCalledWith(expect.objectContaining({ markdown: '# Current', fatal: false, error: 'Parser failed' }))
    e.request('doc', '# Corrected'); vi.advanceTimersByTime(150)
    e.worker.reply(e.worker.requests[2])
    expect(e.onSnapshot).toHaveBeenCalledTimes(1)
    expect(e.worker.terminate).not.toHaveBeenCalled()
    e.dispose()
  })

  it.each(['error', 'messageerror'] as const)('terminates a failed worker on %s and reports the newest requested snapshot', (event) => {
    const e = client()
    e.request('doc', '# Old'); vi.advanceTimersByTime(150)
    e.request('doc', '# Latest')
    if (event === 'error') e.worker.onerror?.({ message: 'Worker load failed' } as ErrorEvent)
    else e.worker.onmessageerror?.({} as MessageEvent)
    expect(e.onError).toHaveBeenCalledWith(expect.objectContaining({ markdown: '# Latest', fatal: true }))
    expect(e.worker.terminate).toHaveBeenCalledTimes(1)
    expect(e.request('doc', '# After failure')).toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(e.worker.requests).toHaveLength(1)
  })

  it('reports a postMessage failure and releases its worker instead of retaining an invisible in-flight request', () => {
    const e = client()
    vi.spyOn(e.worker, 'postMessage').mockImplementation(() => { throw new Error('Cannot clone request') })
    e.request('doc', '# Current'); vi.advanceTimersByTime(150)
    expect(e.onError).toHaveBeenCalledWith(expect.objectContaining({ markdown: '# Current', fatal: true }))
    expect(e.worker.terminate).toHaveBeenCalledTimes(1)
    expect(e.request('doc', '# New')).toBeNull()
  })
})

describe('current snapshot validity', () => {
  it('requires exact document, raw bytes, revision and option identity rather than title equality', () => {
    const e = client(), raw = '# Repeat\n\n# Repeat', optionsKey = markdownOutlineOptions().optionsKey
    const request = e.request('doc', raw)!
    vi.advanceTimersByTime(150); e.worker.reply(e.worker.requests[0])
    const snapshot = e.onSnapshot.mock.calls[0][0]
    expect(isCurrentMarkdownOutlineSnapshot(snapshot, request, 'doc', raw, optionsKey)).toBe(true)
    expect(isCurrentMarkdownOutlineSnapshot(snapshot, request, 'other-doc', raw, optionsKey)).toBe(false)
    expect(isCurrentMarkdownOutlineSnapshot(snapshot, request, 'doc', raw + '\n', optionsKey)).toBe(false)
    expect(isCurrentMarkdownOutlineSnapshot(snapshot, request, 'doc', raw, markdownOutlineOptions({ emoji: false }).optionsKey)).toBe(false)
    expect(isCurrentMarkdownOutlineSnapshot(snapshot, { ...request, revision: request.revision + 1 }, 'doc', raw, optionsKey)).toBe(false)
    expect(isCurrentMarkdownOutlineSnapshot(null, request, 'doc', raw, optionsKey)).toBe(false)
    expect(isCurrentMarkdownOutlineSnapshot(snapshot, null, 'doc', raw, optionsKey)).toBe(false)
    e.dispose()
  })

  it('never reuses an old worker revision after closing and reopening the same document', () => {
    const first = client(), identity = first.request('doc', '# Same')!
    vi.advanceTimersByTime(150); first.worker.reply(first.worker.requests[0])
    const snapshot = first.onSnapshot.mock.calls[0][0]
    first.dispose()
    const reopened = client(), next = reopened.request('doc', '# Same')!
    expect(next.revision).toBeGreaterThan(identity.revision)
    expect(isCurrentMarkdownOutlineSnapshot(snapshot, next, 'doc', '# Same', next.optionsKey)).toBe(false)
    reopened.dispose()
  })

  it('starts pending with no worker construction or parsing during server render', () => {
    const worker = vi.fn(() => { throw new Error('Worker must only mount in a client effect') })
    vi.stubGlobal('Worker', worker)
    let state: ReturnType<typeof useMarkdownOutline> | undefined
    function Probe() { state = useMarkdownOutline('doc', '# Title'); return null }
    renderToStaticMarkup(createElement(Probe))
    expect(state).toEqual({ headings: [], pending: true, snapshot: null, error: null })
    expect(worker).not.toHaveBeenCalled()
  })
})

describe('real outline worker entry', () => {
  it('runs canonical extraction and echoes only snapshot identity with the complete heading list', async () => {
    const scope: { onmessage: ((event: MessageEvent<MarkdownOutlineRequest>) => void) | null; postMessage: ReturnType<typeof vi.fn> } = { onmessage: null, postMessage: vi.fn() }
    vi.stubGlobal('self', scope)
    await import('../src/renderer/outline-worker')
    const { options, optionsKey } = markdownOutlineOptions()
    const request: MarkdownOutlineRequest = { documentKey: 'worker-doc', revision: 17, optionsKey, options, markdown: '> # Quote\n\n$$\n# Literal\n$$\n\n#\n\n# Repeat\n\n# Repeat' }
    scope.onmessage?.({ data: request } as MessageEvent<MarkdownOutlineRequest>)
    expect(scope.postMessage).toHaveBeenCalledWith({ documentKey: 'worker-doc', revision: 17, optionsKey, kind: 'result', headings: [
      { level: 1, line: 1, text: 'Quote' }, { level: 1, line: 7, text: '' },
      { level: 1, line: 9, text: 'Repeat' }, { level: 1, line: 11, text: 'Repeat' },
    ] })
    expect(scope.postMessage.mock.calls[0][0]).not.toHaveProperty('markdown')
  })
})
