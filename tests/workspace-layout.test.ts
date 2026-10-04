import { describe, expect, it } from 'vitest'
import { defaultWorkspaceLayout, parseWorkspaceLayout, sidebarMaximum } from '../src/renderer/workspace-layout'

describe('workspace layout persistence and available editor space', () => {
  it('recovers independently from corrupt or obsolete persisted values', () => {
    expect(parseWorkspaceLayout(null)).toEqual(defaultWorkspaceLayout)
    expect(parseWorkspaceLayout({ sidebarWidth: NaN, splitRatio: '80' })).toEqual(defaultWorkspaceLayout)
    expect(parseWorkspaceLayout({ sidebarWidth: 800, splitRatio: 0 })).toEqual({ sidebarWidth: 420, splitRatio: 25 })
  })
  it('reserves editing space when docked and uses bounded drawer space in narrow windows', () => {
    for (const width of [900, 980, 1180, 2000]) expect(width - sidebarMaximum(width)).toBeGreaterThanOrEqual(480)
    expect(sidebarMaximum(640)).toBe(420)
    expect(sidebarMaximum(900)).toBe(420)
  })
})
