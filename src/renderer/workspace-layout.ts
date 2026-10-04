export const defaultWorkspaceLayout = { sidebarWidth: 240, splitRatio: 50 }
export const SIDEBAR_MIN = 190
export const SIDEBAR_MAX = 420
export const SIDEBAR_OVERLAY_BELOW = 900
export const SPLIT_STACK_BELOW = 720

export function clampSize(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
}

export function parseWorkspaceLayout(value: unknown): typeof defaultWorkspaceLayout {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    sidebarWidth: typeof input.sidebarWidth === 'number' && Number.isFinite(input.sidebarWidth)
      ? clampSize(input.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX) : defaultWorkspaceLayout.sidebarWidth,
    splitRatio: typeof input.splitRatio === 'number' && Number.isFinite(input.splitRatio)
      ? clampSize(input.splitRatio, 25, 75) : defaultWorkspaceLayout.splitRatio,
  }
}

export function sidebarMaximum(workspaceWidth: number): number {
  return workspaceWidth < SIDEBAR_OVERLAY_BELOW
    ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, workspaceWidth - 56))
    : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, workspaceWidth - 480))
}
