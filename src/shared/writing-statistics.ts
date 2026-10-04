export interface WritingStatistics {
  words: number
  characters: number
  charactersWithoutSpaces: number
  lines: number
  paragraphs: number
  readingMinutes: number
}

function readableText(markdown: string): string {
  return markdown
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '')
    .replace(/```[^\r\n]*\r?\n|```/g, '')
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/[*_~`]/g, '')
}

export function computeWritingStatistics(markdown: string): WritingStatistics {
  const text = readableText(markdown)
  const characters = Array.from(text.replace(/\r?\n/g, '')).length
  const charactersWithoutSpaces = Array.from(text.replace(/\s/gu, '')).length
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const words = Array.from(segmenter.segment(text)).filter(
    (segment) => segment.isWordLike,
  ).length
  const lines = markdown.length === 0 ? 0 : markdown.split(/\r?\n/).length
  const paragraphs = text.trim().length === 0
    ? 0
    : text.trim().split(/(?:\r?\n){2,}/).filter((part) => part.trim()).length

  return {
    words,
    characters,
    charactersWithoutSpaces,
    lines,
    paragraphs,
    readingMinutes: words === 0 ? 0 : Math.max(1, Math.ceil(words / 250)),
  }
}
