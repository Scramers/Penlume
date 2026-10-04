import { extractMarkdownHeadings } from '../shared/markdown-outline'
import type { MarkdownOutlineRequest, MarkdownOutlineResponse } from './use-markdown-outline'

// The main renderer tsconfig contains DOM (not WebWorker) declarations. The
// explicit worker-scope shape avoids pretending this entry runs in a Window.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MarkdownOutlineRequest>) => void) | null
  postMessage(response: MarkdownOutlineResponse): void
}
scope.onmessage = ({ data: request }) => {
  const identity = { documentKey: request.documentKey, revision: request.revision, optionsKey: request.optionsKey }
  try { scope.postMessage({ ...identity, kind: 'result', headings: extractMarkdownHeadings(request.markdown, request.options) }) }
  catch (reason) { scope.postMessage({ ...identity, kind: 'error', error: String(reason) }) }
}
