import type { Preferences } from './preferences'

export type WritingAidOptions = Pick<Preferences, 'smartPunctuation' | 'autoPair' | 'autoLink'>
export interface TypingPlan { from: number; to: number; insert: string; anchor: number; head: number; kind: 'pair' | 'skip' | 'smart' }
export const asciiPairs: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
const word = /[\p{L}\p{N}_]/u

/** Pending literal delimiters are not yet represented as nodes while being typed. */
export function pendingLiteral(prefix: string): boolean {
  let ticks = 0, dollars = 0
  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] === '\\') { index++; continue }
    if (prefix[index] === '`') ticks++
    if (prefix[index] === '$' && ticks % 2 === 0) dollars++
  }
  return ticks % 2 === 1 || dollars % 2 === 1
}

export function urlTokenBefore(prefix: string): boolean { return /(?:https?:\/\/|www\.)[^\s<>]*$/i.test(prefix) }

/** The adapters call this only for one ordinary typed character, never for paste/load. */
export function planTyping(text: string, from: number, to: number, input: string, options: WritingAidOptions, literal = false, composing = false): TypingPlan | null {
  if (composing || input.length !== 1 || from < 0 || to < from || to > text.length) return null
  const before = text.slice(0, from), previous = before.at(-1) ?? '', next = text[to] ?? ''
  const escaped = /(?:^|[^\\])(?:\\\\)*\\$/.test(before)
  const smart = options.smartPunctuation && !literal && !pendingLiteral(before) && !urlTokenBefore(before) && !escaped
  if (options.autoPair && from === to && (Object.values(asciiPairs).includes(input) || input === '"' || input === "'") && (next === input || (smart && ((input === '"' && next === '”') || (input === "'" && next === '’'))))) {
    return { from, to: from, insert: '', anchor: from + 1, head: from + 1, kind: 'skip' }
  }
  if (smart && from === to && input === '-' && previous === '-' && before.at(-2) !== '-') return { from: from - 1, to, insert: '—', anchor: from, head: from, kind: 'smart' }
  if (smart && from === to && input === '.' && before.endsWith('..') && before.at(-3) !== '.') return { from: from - 2, to, insert: '…', anchor: from - 1, head: from - 1, kind: 'smart' }
  let open = input, close = asciiPairs[input]
  if (smart && (input === '"' || input === "'")) {
    const opening = !previous || /[\s([{—–]/.test(previous)
    open = input === '"' ? (opening ? '“' : '”') : (opening ? '‘' : '’')
    close = input === '"' ? '”' : '’'
    if (!opening && from === to) return { from, to, insert: open, anchor: from + 1, head: from + 1, kind: 'smart' }
  }
  if (options.autoPair && close && !escaped && !urlTokenBefore(before)) {
    // The third backtick completes a Markdown fence instead of starting a new pair.
    if (input === '`' && from === to && before.endsWith('``')) return null
    const quote = input === '"' || input === "'" || input === '`'
    if (from !== to || ((!next || /[\s)\]}.,:;!?]/.test(next)) && (!quote || !word.test(previous)))) {
      const selected = text.slice(from, to)
      return { from, to, insert: open + selected + close, anchor: from + open.length, head: from + open.length + selected.length, kind: 'pair' }
    }
  }
  return open !== input ? { from, to, insert: open, anchor: from + open.length, head: from + open.length, kind: 'smart' } : null
}

export function pairedDeletion(text: string, from: number, to: number): { from: number; to: number } | null {
  if (!Number.isInteger(from) || from !== to || from < 1 || from >= text.length) return null
  const open = text[from - 1], close = text[from]
  const expected = open === '“' ? '”' : open === '‘' ? '’' : asciiPairs[open]
  return expected !== undefined && expected === close ? { from: from - 1, to: from + 1 } : null
}

export interface UrlToken { text: string; href: string; from: number; to: number }
export function safeTypingUrl(value: string): string | null {
  if (!value || value.length > 4096 || /[\s<>"\x00-\x1f\x7f]/.test(value) || !/^(?:https?:\/\/|www\.)/i.test(value)) return null
  try { const url = new URL(/^www\./i.test(value) ? `https://${value}` : value); return url.hostname && ['http:', 'https:'].includes(url.protocol) ? url.href : null } catch { return null }
}

export function trailingUrl(prefix: string): UrlToken | null {
  const match = prefix.match(/(?:^|\s)((?:https?:\/\/|www\.)[^\s<>]+)$/i)
  if (!match) return null
  let value = match[1].replace(/[.,;:!?"']+$/, '')
  while (value.endsWith(')') && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) value = value.slice(0, -1)
  while (value.endsWith(']') && (value.match(/\]/g)?.length ?? 0) > (value.match(/\[/g)?.length ?? 0)) value = value.slice(0, -1)
  const href = safeTypingUrl(value)
  const from = prefix.length - match[1].length
  return href ? { text: value, href, from, to: from + value.length } : null
}

export function urlMarkdown(label: string, href: string): string {
  const destination = href.replace(/\\/g, '%5C').replace(/[<>]/g, (character) => character === '<' ? '%3C' : '%3E')
  return `[${label.replace(/[\\[\]]/g, '\\$&')}](<${destination}>)`
}

/** Only user actions creating a block call this; parsing existing code never does. */
export function newCodeBlockMarkdown(text: string, preferences: Pick<Preferences, 'defaultCodeLanguage'>): string {
  const runs = text.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  return `\n\n${fence}${preferences.defaultCodeLanguage}\n${text}\n${fence}\n\n`
}
