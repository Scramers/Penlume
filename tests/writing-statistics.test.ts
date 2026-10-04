import { describe, expect, it } from 'vitest'
import { computeWritingStatistics } from '../src/shared/writing-statistics'

describe('writing statistics', () => {
  it('counts mixed Chinese and English text without Markdown markers', () => {
    const stats = computeWritingStatistics(
      '# 标题\n\nHello **world**，这是一个测试。\n\n[OpenAI](https://openai.com)',
    )

    expect(stats.words).toBeGreaterThanOrEqual(6)
    expect(stats.charactersWithoutSpaces).toBeLessThan(55)
    expect(stats.lines).toBe(5)
    expect(stats.paragraphs).toBe(3)
    expect(stats.readingMinutes).toBe(1)
  })

  it('ignores YAML front matter metadata', () => {
    const stats = computeWritingStatistics('---\ntitle: Hidden\ntags: test\n---\n\nVisible text')

    expect(stats.words).toBe(2)
    expect(stats.charactersWithoutSpaces).toBe(11)
  })

  it('returns zero reading time for an empty document', () => {
    expect(computeWritingStatistics('')).toMatchObject({
      words: 0,
      lines: 0,
      paragraphs: 0,
      readingMinutes: 0,
    })
  })
})
