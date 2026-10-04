import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { activeHeadingIndexAtPosition, visibleActiveHeadingIndex } from '../src/renderer/active-heading'
import { Sidebar } from '../src/renderer/components/Sidebar'
import { extractMarkdownHeadings, type MarkdownHeading } from '../src/shared/markdown-outline'

describe('active heading positions', () => {
  it.each([
    [0, null], [4, null], [5, 0], [6, 0], [19, 0], [20, 1], [39, 1], [40, 2], [100, 2],
  ] as const)('uses inclusive starts and the current section at position %s', (caret, expected) => {
    expect(activeHeadingIndexAtPosition([5, 20, 40], caret)).toBe(expected)
  })

  it('handles a PM heading starting at position zero without a synthetic preceding section', () => {
    expect(activeHeadingIndexAtPosition([0, 17], 0)).toBe(0)
    expect(activeHeadingIndexAtPosition([0, 17], 16)).toBe(0)
    expect(activeHeadingIndexAtPosition([0, 17], 17)).toBe(1)
    expect(activeHeadingIndexAtPosition([], 0)).toBeNull()
  })

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an unavailable or invalid caret coordinate %s', (caret) => {
    expect(activeHeadingIndexAtPosition([0, 5], caret)).toBeNull()
  })

  it('uses source UTF-16 offsets, including Chinese and astral characters before a heading', () => {
    const markdown = '前言🙂\n\n# 章节🙂\n内容\n\n## 后续\n'
    const positions = [markdown.indexOf('# 章节'), markdown.indexOf('## 后续')]
    expect(positions[0]).toBe(6)
    expect(activeHeadingIndexAtPosition(positions, positions[0] - 1)).toBeNull()
    expect(activeHeadingIndexAtPosition(positions, positions[0])).toBe(0)
    expect(activeHeadingIndexAtPosition(positions, positions[1] - 1)).toBe(0)
    expect(activeHeadingIndexAtPosition(positions, positions[1])).toBe(1)
  })

  it('uses canonical ATX/Setext source positions and ignores front matter and fenced headings', () => {
    const markdown = [
      '---', 'title: Document', '---', 'Preface', '', '# Repeat', 'body',
      'Repeat', '---', 'body', '```md', '# Hidden', '```', '## Child', 'body',
    ].join('\n')
    const headings = extractMarkdownHeadings(markdown)
    expect(headings).toEqual([
      { level: 1, line: 6, text: 'Repeat' },
      { level: 2, line: 7, text: 'body Repeat' },
      { level: 2, line: 14, text: 'Child' },
    ])
    const positions = headings.map((heading) => heading.line)
    expect(activeHeadingIndexAtPosition(positions, 5)).toBeNull()
    expect(activeHeadingIndexAtPosition(positions, 6)).toBe(0)
    expect(activeHeadingIndexAtPosition(positions, 7)).toBe(1)
    expect(activeHeadingIndexAtPosition(positions, 8)).toBe(1)
    expect(activeHeadingIndexAtPosition(positions, 9)).toBe(1)
    expect(activeHeadingIndexAtPosition(positions, 12)).toBe(1)
    expect(activeHeadingIndexAtPosition(positions, 14)).toBe(2)
  })

  it('recomputes snapshot indexes after deletion and reorder rather than identifying repeated titles', () => {
    const original = extractMarkdownHeadings('# First\n\n## Repeat\nA\n\n## Repeat\nB')
    expect(activeHeadingIndexAtPosition(original.map((heading) => heading.line), 7)).toBe(2)
    const deleted = extractMarkdownHeadings('# First\n\n## Repeat\nB')
    expect(activeHeadingIndexAtPosition(deleted.map((heading) => heading.line), 4)).toBe(1)
    expect(visibleActiveHeadingIndex(deleted, 2)).toBeNull()
    const reordered = extractMarkdownHeadings('# Repeat\nB\n\n# First\nA')
    expect(activeHeadingIndexAtPosition(reordered.map((heading) => heading.line), 2)).toBe(0)
    expect(activeHeadingIndexAtPosition(reordered.map((heading) => heading.line), 5)).toBe(1)
    expect(original.map((heading) => heading.line)).toEqual([1, 3, 6])
  })

  it('reads a logarithmic number of cached positions without iterating or changing the snapshot', () => {
    const positions = Object.freeze(Array.from({ length: 4_096 }, (_, index) => index * 3 + 2))
    let positionReads = 0
    const cached = new Proxy(positions, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('The cached position lookup must not iterate the whole document')
        if (typeof property === 'string' && /^\d+$/.test(property)) positionReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    expect(activeHeadingIndexAtPosition(cached, 9_000)).toBe(2_999)
    expect(positionReads).toBeLessThanOrEqual(13)
    expect(positions[0]).toBe(2)
    expect(positions[positions.length - 1]).toBe(12_287)
  })
})

describe('visible active heading hierarchy', () => {
  const levels = (values: number[]) => values.map((level) => Object.freeze({ level }))

  it('retains the exact active index when its level is visible, including repeated sibling levels', () => {
    const headings = Object.freeze(levels([1, 2, 2, 3]))
    expect(visibleActiveHeadingIndex(headings, 2, 2)).toBe(2)
    expect(visibleActiveHeadingIndex(headings, 3)).toBe(3)
  })

  it('chooses the closest visible ancestor across skipped levels and closed sibling branches', () => {
    const headings = Object.freeze(levels([1, 2, 4, 3, 4, 2, 5]))
    expect(visibleActiveHeadingIndex(headings, 4, 3)).toBe(3)
    expect(visibleActiveHeadingIndex(headings, 4, 2)).toBe(1)
    expect(visibleActiveHeadingIndex(headings, 6, 2)).toBe(5)
    expect(visibleActiveHeadingIndex(headings, 6, 1)).toBe(0)
    expect(headings.map((heading) => heading.level)).toEqual([1, 2, 4, 3, 4, 2, 5])
  })

  it('does not turn a hidden sibling into an ancestor or revive an earlier closed branch', () => {
    expect(visibleActiveHeadingIndex(levels([1, 2, 3, 3, 4]), 4, 2)).toBe(1)
    expect(visibleActiveHeadingIndex(levels([1, 2, 3, 1, 4]), 4, 2)).toBe(3)
  })

  it('has no invented ancestor when a document starts at a hidden heading level', () => {
    const headings = levels([3, 4, 3, 5])
    expect(visibleActiveHeadingIndex(headings, 1, 2)).toBeNull()
    expect(visibleActiveHeadingIndex(headings, 3, 2)).toBeNull()
    expect(visibleActiveHeadingIndex(headings, 3, 3)).toBe(2)
  })

  it.each([null, -1, 0.5, 3, NaN, Infinity])('does not assign a location for invalid or absent active index %s', (index) => {
    expect(visibleActiveHeadingIndex(levels([1, 2, 3]), index)).toBeNull()
  })

  it.each([0, 7, 1.5, NaN])('rejects an invalid display level %s', (limit) => {
    expect(visibleActiveHeadingIndex(levels([1, 2]), 1, limit)).toBeNull()
  })

  it('does not inspect heading text or source positions while projecting a cached index', () => {
    const headings = [{ level: 1 }, { level: 3 }].map((heading) => Object.freeze({
      ...heading,
      get text(): string { throw new Error('Title identity is not a hierarchy coordinate') },
      get line(): number { throw new Error('Source lookup is owned by the supplied snapshot') },
    }))
    expect(visibleActiveHeadingIndex(headings, 1, 2)).toBe(0)
  })
})

describe('sidebar active location', () => {
  const headings: MarkdownHeading[] = [
    { level: 1, line: 2, text: 'Repeat' },
    { level: 2, line: 5, text: 'Repeat' },
    { level: 3, line: 8, text: 'Child' },
  ]
  const render = (activeHeadingIndex?: number | null, mode: 'files' | 'outline' = 'outline') => {
    const onHeadingClick = vi.fn()
    const props: ComponentProps<typeof Sidebar> = {
      activePath: null, outlineDocumentId: 'static-test-document', onOutlineControlAction: vi.fn(), activeHeadingIndex, headings, mode, workspace: null,
      onClose: vi.fn(), onHeadingClick, onModeChange: vi.fn(), onOpenFile: vi.fn(),
      onOpenWorkspace: vi.fn(), onRefreshWorkspace: vi.fn(), onManage: vi.fn(),
    }
    return { markup: renderToStaticMarkup(createElement(Sidebar, props)), onHeadingClick }
  }

  it('marks exactly the supplied repeated-title index as the current location without invoking navigation', () => {
    const { markup, onHeadingClick } = render(1)
    expect(markup.match(/aria-current="location"/g)).toHaveLength(1)
    expect(markup).toMatch(/<button aria-current="location" class="outline-navigation outline-heading--active"[^>]*title="第 5 行"[^>]*>Repeat<\/button>/)
    expect(markup).not.toMatch(/<button[^>]*aria-current="location"[^>]*title="第 2 行"/)
    expect(onHeadingClick).not.toHaveBeenCalled()
  })

  it.each([undefined, null, -1, 3])('renders no current location for absent or stale index %s', (index) => {
    const { markup } = render(index)
    expect(markup).not.toContain('aria-current=')
    expect(markup).not.toContain('outline-heading--active')
    expect(markup.match(/>Repeat<\/button>/g)).toHaveLength(2)
  })

  it('does not attach an outline location marker to the file view', () => {
    const { markup } = render(1, 'files')
    expect(markup).not.toContain('aria-current=')
    expect(markup).not.toContain('outline-heading--active')
  })
})
