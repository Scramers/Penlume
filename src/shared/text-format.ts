import type { LineEnding, TextFormat } from './contracts'

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])

export interface DecodedText {
  text: string
  format: TextFormat
}

export function detectLineEnding(text: string): LineEnding {
  const firstCarriageReturn = text.indexOf('\r\n')
  const firstLineFeed = text.indexOf('\n')

  if (
    firstCarriageReturn >= 0 &&
    (firstLineFeed < 0 || firstCarriageReturn <= firstLineFeed)
  ) {
    return 'crlf'
  }

  return 'lf'
}

export function decodeUtf8(bytes: Uint8Array): DecodedText {
  const hasBom =
    bytes.length >= UTF8_BOM.length &&
    UTF8_BOM.every((value, index) => bytes[index] === value)
  const content = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content)
  const lineEnding = detectLineEnding(decoded)
  const text = normalizeLineEndings(decoded, 'lf')

  return {
    text,
    format: {
      hasBom,
      lineEnding,
    },
  }
}

export function normalizeLineEndings(
  text: string,
  lineEnding: LineEnding,
): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  return lineEnding === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized
}

export function encodeUtf8(text: string, format: TextFormat): Uint8Array {
  const content = new TextEncoder().encode(
    normalizeLineEndings(text, format.lineEnding),
  )

  if (!format.hasBom) {
    return content
  }

  const result = new Uint8Array(UTF8_BOM.length + content.length)
  result.set(UTF8_BOM)
  result.set(content, UTF8_BOM.length)
  return result
}
