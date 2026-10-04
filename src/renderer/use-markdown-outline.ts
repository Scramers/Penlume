import { useEffect, useRef, useState } from 'react'
import type { MarkdownHeading } from '../shared/markdown-outline'
import { defaultMarkdownExtensions, type MarkdownExtensionOptions } from '../shared/preferences'

export interface MarkdownOutlineIdentity {
  documentKey: string
  revision: number
  optionsKey: string
}
export interface MarkdownOutlineRequest extends MarkdownOutlineIdentity {
  markdown: string
  options: MarkdownExtensionOptions
}
export type MarkdownOutlineResponse = MarkdownOutlineIdentity & (
  | { kind: 'result'; headings: MarkdownHeading[] }
  | { kind: 'error'; error: string }
)
export interface MarkdownOutlineSnapshot extends MarkdownOutlineIdentity {
  /** Exact raw snapshot reference, not a hash or normalized Markdown. */
  markdown: string
  headings: MarkdownHeading[]
}
export interface MarkdownOutlineFailure extends MarkdownOutlineIdentity {
  markdown: string
  error: string
  fatal: boolean
}

export interface OutlineWorker {
  postMessage(request: MarkdownOutlineRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<MarkdownOutlineResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}

export function markdownOutlineOptions(input: Partial<MarkdownExtensionOptions> = {}) {
  // Fixed order and primitive values: equivalent option objects share an identity.
  const options: MarkdownExtensionOptions = {
    highlight: input.highlight ?? defaultMarkdownExtensions.highlight,
    superscript: input.superscript ?? defaultMarkdownExtensions.superscript,
    subscript: input.subscript ?? defaultMarkdownExtensions.subscript,
    underline: input.underline ?? defaultMarkdownExtensions.underline,
    emoji: input.emoji ?? defaultMarkdownExtensions.emoji,
    emojiCompletion: input.emojiCompletion ?? defaultMarkdownExtensions.emojiCompletion,
  }
  return { options, optionsKey: JSON.stringify(options) }
}

const createOutlineWorker = (): OutlineWorker => new Worker(new URL('./outline-worker.ts', import.meta.url), { type: 'module' })
const sameIdentity = (left: MarkdownOutlineIdentity, right: MarkdownOutlineIdentity) => left.documentKey === right.documentKey
  && left.revision === right.revision && left.optionsKey === right.optionsKey
// A tab switch creates a fresh worker, but must not reuse a previous worker's
// revision (including an A -> B -> A document/snapshot transition).
let nextOutlineRevision = 0

export function isCurrentMarkdownOutlineSnapshot(
  snapshot: MarkdownOutlineSnapshot | null,
  request: MarkdownOutlineIdentity | null,
  documentKey: string,
  markdown: string,
  optionsKey: string,
): boolean {
  return Boolean(snapshot && request && sameIdentity(snapshot, request) && snapshot.documentKey === documentKey
    && snapshot.markdown === markdown && snapshot.optionsKey === optionsKey)
}

/** One worker, one in-flight parse and one latest request. The latter replaces
 * earlier drafts rather than enqueueing a parse per key. A request becomes ready
 * 150ms after its latest edit; completing an old parse does not bypass that delay.
 * This controller has no document reads, editor transactions or parser import.
 */
export function createMarkdownOutlineClient({
  onSnapshot,
  onError,
  createWorker = createOutlineWorker,
}: {
  onSnapshot: (snapshot: MarkdownOutlineSnapshot) => void
  onError?: (failure: MarkdownOutlineFailure) => void
  createWorker?: () => OutlineWorker
}) {
  const worker = createWorker()
  let disposed = false
  let latest: MarkdownOutlineRequest | null = null
  let inFlight: MarkdownOutlineRequest | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let ready = false

  const stop = () => {
    if (disposed) return
    disposed = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    latest = inFlight = null
    worker.onmessage = worker.onerror = worker.onmessageerror = null
    worker.terminate()
  }
  const fail = (request: MarkdownOutlineRequest, error: string, fatal: boolean) => onError?.({
    documentKey: request.documentKey, revision: request.revision, optionsKey: request.optionsKey,
    markdown: request.markdown, error, fatal,
  })
  const flush = () => {
    if (disposed || inFlight || !ready || !latest) return
    const request = latest
    inFlight = request
    ready = false
    try { worker.postMessage(request) }
    catch (reason) { stop(); fail(request, String(reason), true) }
  }
  worker.onmessage = (event) => {
    const response = event.data
    if (disposed || !inFlight || !response || typeof response !== 'object'
      || !['result', 'error'].includes(response.kind) || !sameIdentity(response, inFlight)) return
    const completed = inFlight
    inFlight = null
    if (latest && sameIdentity(completed, latest) && completed.markdown === latest.markdown) {
      if (response.kind === 'result') onSnapshot({
        documentKey: completed.documentKey, revision: completed.revision, optionsKey: completed.optionsKey,
        markdown: completed.markdown, headings: response.headings,
      })
      else fail(completed, response.error, false)
    }
    flush()
  }
  const fatal = (error: string) => {
    if (disposed) return
    const request = latest
    stop()
    if (request) fail(request, error, true)
  }
  worker.onerror = (event) => fatal(event.message || 'Outline worker failed')
  worker.onmessageerror = () => fatal('Unable to receive outline worker result')

  return {
    request(documentKey: string, markdown: string, input: Partial<MarkdownExtensionOptions> = {}): MarkdownOutlineIdentity | null {
      if (disposed) return null
      const { options, optionsKey } = markdownOutlineOptions(input)
      if (latest?.documentKey === documentKey && latest.markdown === markdown && latest.optionsKey === optionsKey) return {
        documentKey, revision: latest.revision, optionsKey,
      }
      latest = { documentKey, markdown, options, optionsKey, revision: ++nextOutlineRevision }
      ready = false
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; ready = true; flush() }, 150)
      return { documentKey, revision: latest.revision, optionsKey }
    },
    dispose: stop,
  }
}

export interface MarkdownOutlineState {
  /** Same-document list may remain visible while pending. It is NOT a valid
   * current index/navigation snapshot until pending is false. */
  headings: MarkdownHeading[]
  pending: boolean
  snapshot: MarkdownOutlineSnapshot | null
  error: string | null
}

/** Mount per document key, never per character. Effects submit already-owned raw
 * snapshots; selection-only renders do not submit or serialize anything. Worker
 * teardown cancels a closed tab's work and rejects even a captured late callback.
 * pending is derived during render, so an old result cannot look current in the
 * interval before the next effect submits a newer Markdown/options revision.
 */
export function useMarkdownOutline(
  documentKey: string,
  markdown: string,
  input: Partial<MarkdownExtensionOptions> = {},
): MarkdownOutlineState {
  const { options, optionsKey } = markdownOutlineOptions(input)
  const clientRef = useRef<ReturnType<typeof createMarkdownOutlineClient> | null>(null)
  const requestRef = useRef<MarkdownOutlineIdentity | null>(null)
  const [snapshot, setSnapshot] = useState<MarkdownOutlineSnapshot | null>(null)
  const [failure, setFailure] = useState<MarkdownOutlineFailure | null>(null)
  useEffect(() => {
    let client: ReturnType<typeof createMarkdownOutlineClient> | null = null
    try {
      client = createMarkdownOutlineClient({ onSnapshot: (next) => { setSnapshot(next); setFailure(null) }, onError: setFailure })
      clientRef.current = client
    } catch (reason) {
      setFailure({ documentKey, revision: 0, optionsKey, markdown, error: String(reason), fatal: true })
    }
    return () => { client?.dispose(); if (clientRef.current === client) { clientRef.current = null; requestRef.current = null } }
  }, [documentKey])
  useEffect(() => {
    requestRef.current = clientRef.current?.request(documentKey, markdown, options) ?? null
    if (requestRef.current) setFailure(null)
  }, [documentKey, markdown, optionsKey])

  const sameDocument = snapshot?.documentKey === documentKey ? snapshot : null
  const pending = !isCurrentMarkdownOutlineSnapshot(sameDocument, requestRef.current, documentKey, markdown, optionsKey)
  const currentFailure = failure?.documentKey === documentKey && (failure.fatal
    || failure.markdown === markdown && failure.optionsKey === optionsKey) ? failure : null
  return { headings: sameDocument?.headings ?? [], pending, snapshot: sameDocument, error: currentFailure?.error ?? null }
}
