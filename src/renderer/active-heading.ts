import type { MarkdownHeading } from '../shared/markdown-outline'

/**
 * Return an index in the CURRENT heading snapshot, never an identity derived
 * from a title. positions must be sorted in document order, strictly increasing,
 * nonnegative integer coordinates. The caret uses the same coordinate system:
 * PM node positions, source UTF-16 offsets, or one-based source line numbers.
 * Heading starts are inclusive; content before the first heading has no section.
 * This lookup does not parse Markdown, serialize a document, or mutate a view.
 */
export function activeHeadingIndexAtPosition(positions: readonly number[], caretPosition: number): number | null {
  if (!Number.isSafeInteger(caretPosition) || caretPosition < 0) return null
  let from = 0, to = positions.length
  while (from < to) {
    const middle = from + Math.floor((to - from) / 2)
    const position = positions[middle]
    if (!Number.isSafeInteger(position) || position < 0) return null
    if (position <= caretPosition) from = middle + 1
    else to = middle
  }
  return from === 0 ? null : from - 1
}

/**
 * Project an active index onto the sidebar's H1..HmaxLevel filter. A preceding
 * same-level heading is a sibling, and deeper headings belong to closed branches;
 * neither can become an ancestor. Walk only strictly lower levels. A document
 * beginning at H3 has no invented H1/H2 ancestor when that branch is hidden.
 * Callers must discard an old index when replacing/reordering its heading snapshot.
 */
export function visibleActiveHeadingIndex(
  headings: readonly Pick<MarkdownHeading, 'level'>[],
  activeIndex: number | null,
  maxLevel = 6,
): number | null {
  if (activeIndex === null || !Number.isSafeInteger(activeIndex) || activeIndex < 0 || activeIndex >= headings.length) return null
  if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 6) return null
  let level = headings[activeIndex].level
  if (!Number.isInteger(level) || level < 1 || level > 6) return null
  if (level <= maxLevel) return activeIndex
  for (let index = activeIndex - 1; index >= 0; index--) {
    const precedingLevel = headings[index].level
    if (!Number.isInteger(precedingLevel) || precedingLevel < 1 || precedingLevel > 6) return null
    if (precedingLevel >= level) continue
    level = precedingLevel
    if (level <= maxLevel) return index
  }
  return null
}
