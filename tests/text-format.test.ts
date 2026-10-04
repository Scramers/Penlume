import { describe, expect, it } from 'vitest'
import {
  decodeUtf8,
  detectLineEnding,
  encodeUtf8,
  normalizeLineEndings,
} from '../src/shared/text-format'

describe('text format', () => {
  it('detects and normalizes CRLF while preserving format metadata', () => {
    const source = new TextEncoder().encode('# 标题\r\n\r\n正文\r\n')
    const decoded = decodeUtf8(source)

    expect(decoded.text).toBe('# 标题\n\n正文\n')
    expect(decoded.format).toEqual({ hasBom: false, lineEnding: 'crlf' })
  })

  it('round-trips a UTF-8 BOM document', () => {
    const encoded = encodeUtf8('你好\n', {
      hasBom: true,
      lineEnding: 'crlf',
    })
    const decoded = decodeUtf8(encoded)

    expect([...encoded.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(decoded.text).toBe('你好\n')
    expect(decoded.format).toEqual({ hasBom: true, lineEnding: 'crlf' })
  })

  it('normalizes mixed line endings deterministically', () => {
    expect(normalizeLineEndings('a\r\nb\rc\n', 'lf')).toBe('a\nb\nc\n')
    expect(normalizeLineEndings('a\r\nb\rc\n', 'crlf')).toBe(
      'a\r\nb\r\nc\r\n',
    )
    expect(detectLineEnding('one\ntwo')).toBe('lf')
  })
})

