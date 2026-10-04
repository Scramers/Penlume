export type ThemeAppearance = 'light' | 'dark'
export interface ThemePalette { background: string; surface: string; elevated: string; text: string; muted: string; accent: string; soft: string; border: string }
export interface WritingTheme { id: string; name: string; description: string; appearance: ThemeAppearance; css: string; palette: ThemePalette; builtIn: boolean; createdAt: number; updatedAt: number }
export interface ThemeLibraryState { version: 1; lightId: string; darkId: string; userThemes: WritingTheme[] }
export interface ThemeInput { name: string; appearance: ThemeAppearance; css: string; description?: string; palette?: ThemePalette }
export interface CssSanitization { css: string; removedResources: number }
export const THEME_CSS_MAX_BYTES = 100000
export const THEME_LIBRARY_MAX_THEMES = 40
export const THEME_LIBRARY_STORAGE_KEY = 'ttypora.theme-library.v1'

const palette = (background: string, surface: string, text: string, muted: string, accent: string, soft: string, border: string): ThemePalette => ({ background, surface, elevated: surface, text, muted, accent, soft, border })
const definitions: Array<[string, string, ThemeAppearance, string, ThemePalette, string]> = [
  ['studio', '澄蓝', 'light', '清晰留白与柔和蓝色，适合每天的创作。', palette('#f7f7f7', '#ffffff', '#333333', '#777777', '#526f96', '#edf1f6', '#e5e5e5'), ''],
  ['paper', '暖纸', 'light', '奶油色纸面与棕色墨迹，让长文更舒展。', palette('#eee9df', '#fffcf5', '#403b32', '#827668', '#926a41', '#f2e7d6', '#e4dbcb'), '#write h1, #write h2 { font-family: Georgia, "Songti SC", serif; letter-spacing: .015em; }'],
  ['jade', '苔庭', 'light', '轻盈的绿意、安静的白，给思考留一处花园。', palette('#edf3ee', '#fcfefb', '#283e34', '#6f8275', '#287b62', '#e1f1e8', '#d8e5dc'), '#write h1 { border-bottom-color: var(--accent); }'],
  ['rose', '雾玫', 'light', '克制的玫瑰色细节，适合随笔与阅读。', palette('#f5eef1', '#fffafb', '#49373e', '#8b7481', '#a75d7b', '#f6e4ed', '#eadde3'), '#write blockquote { font-style: italic; border-radius: 0 12px 12px 0; }'],
  ['midnight', '深空', 'dark', '深蓝底色与淡紫高光，照亮夜里的灵感。', palette('#202020', '#262626', '#dedede', '#999999', '#a6bddb', '#333e4c', '#363636'), ''],
  ['graphite', '石墨', 'dark', '低彩度的石墨与银灰，让文字成为主角。', palette('#1b1c1f', '#242529', '#e9e7e3', '#a6a49f', '#d3b383', '#403b32', '#414249'), '#write h1, #write h2 { font-family: Georgia, "Songti SC", serif; }'],
  ['forest', '夜林', 'dark', '深绿色纸面与薄荷色标记，平静而有层次。', palette('#142321', '#1c2e2a', '#dfede5', '#98b5a8', '#7dcbb2', '#2c4940', '#355047'), '#write h1 { border-bottom-color: var(--accent); }'],
  ['dusk', '暮紫', 'dark', '暗梅色与柔和桃色，为夜读添一点温度。', palette('#251e2a', '#302735', '#f0e3ed', '#b5a1b6', '#e3a4c2', '#503749', '#503f53'), '#write blockquote { font-style: italic; border-radius: 0 12px 12px 0; }'],
]

function builtInCss(colors: ThemePalette, appearance: ThemeAppearance, extra: string): string {
  return `:root { color-scheme: ${appearance}; background: ${colors.surface}; color: ${colors.text}; --app-bg: ${colors.background}; --surface: ${colors.surface}; --surface-elevated: ${colors.elevated}; --text: ${colors.text}; --muted: ${colors.muted}; --accent: ${colors.accent}; --accent-soft: ${colors.soft}; --border: ${colors.border}; --border-strong: color-mix(in srgb, ${colors.border} 70%, ${colors.text}); --shadow: 0 24px 80px ${appearance === 'dark' ? '#0006' : '#28355020'}; }
#write { color: var(--text); background: var(--surface); }
#write h1, #write h2, #write h3, #write h4, #write h5, #write h6 { color: var(--text); }
#write h1 { padding-bottom: .32em; border-bottom: 1px solid var(--border); }
#write a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: .16em; }
#write blockquote { color: var(--muted); border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent-soft) 45%, transparent); padding: .25em 1em; margin-inline: 0; }
#write pre, #write :not(pre) > code { background: var(--accent-soft); color: var(--text); border-radius: 7px; }
#write pre { padding: 16px; }
#write table { border-collapse: collapse; }
#write th, #write td { border: 1px solid var(--border); }
#write th { background: var(--accent-soft); }
#write hr { border: 0; border-top: 1px solid var(--border); }
${extra}`
}

export const BUILT_IN_THEMES: readonly WritingTheme[] = definitions.map(([id, name, appearance, description, colors, extra]) => Object.freeze({ id: `builtin-${id}`, name, appearance, description, palette: Object.freeze(colors), css: builtInCss(colors, appearance, extra), builtIn: true, createdAt: 0, updatedAt: 0 }))
export const defaultThemeLibrary = (): ThemeLibraryState => ({ version: 1, lightId: 'builtin-studio', darkId: 'builtin-midnight', userThemes: [] })

function cssEscapeAt(css: string, position: number): { value: string; end: number } {
  const hex = css.slice(position + 1).match(/^[\da-f]{1,6}/i)?.[0]
  if (hex) { const end = position + 1 + hex.length; const point = Number.parseInt(hex, 16); return { value: point && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd', end: end + (/\s/.test(css[end] ?? '') ? 1 : 0) } }
  return { value: css[position + 1] ?? '', end: Math.min(css.length, position + 2) }
}
function decodeCssEscapes(value: string): string {
  let result = ''
  for (let i = 0; i < value.length;) { if (value[i] === '\\') { const escaped = cssEscapeAt(value, i); result += escaped.value; i = escaped.end } else result += value[i++] }
  return result
}
function readString(css: string, start: number): number {
  const quote = css[start]
  for (let i = start + 1; i < css.length; i++) { if (css[i] === '\\') i++; else if (css[i] === quote) return i + 1 }
  return css.length
}
function withoutComments(css: string): string {
  let result = ''
  for (let i = 0; i < css.length;) {
    if (css[i] === '"' || css[i] === "'") { const end = readString(css, i); result += css.slice(i, end); i = end }
    else if (css[i] === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); i = end < 0 ? css.length : end + 2 }
    else result += css[i++]
  }
  return result
}
function readIdentifier(css: string, start: number): { value: string; end: number } {
  let value = '', i = start
  while (i < css.length) { if (css[i] === '\\') { const escaped = cssEscapeAt(css, i); value += escaped.value; i = escaped.end } else if (/[\w-]/.test(css[i])) value += css[i++]; else break }
  return { value: value.toLowerCase(), end: i }
}
function balancedEnd(css: string, opening: number): number {
  let depth = 1
  for (let i = opening + 1; i < css.length; i++) {
    if (css[i] === '"' || css[i] === "'") i = readString(css, i) - 1
    else if (css[i] === '\\') i = cssEscapeAt(css, i).end - 1
    else if (css[i] === '(') depth++
    else if (css[i] === ')' && --depth === 0) return i + 1
  }
  return css.length
}
function atRuleEnd(css: string, start: number): number {
  let depth = 0
  for (let i = start; i < css.length; i++) {
    if (css[i] === '"' || css[i] === "'") i = readString(css, i) - 1
    else if (css[i] === '\\') i = cssEscapeAt(css, i).end - 1
    else if (css[i] === '(') depth++
    else if (css[i] === ')') depth--
    else if (css[i] === ';' && depth <= 0) return i + 1
    else if ((css[i] === '{' || css[i] === '}') && depth <= 0) return i
  }
  return css.length
}

/** Keep CSS local and self-contained. URLs hidden in escaped names are inspected too. */
export function sanitizeThemeCss(input: string): CssSanitization {
  if (new TextEncoder().encode(input).byteLength > THEME_CSS_MAX_BYTES) throw new Error('主题 CSS 不能超过 100 KB。')
  const css = withoutComments(input.replaceAll('\u0000', '\ufffd'))
  let output = '', removedResources = 0
  for (let i = 0; i < css.length;) {
    if (css[i] === '"' || css[i] === "'") { const end = readString(css, i); output += css.slice(i, end); i = end; continue }
    if (css[i] === '@') {
      const name = readIdentifier(css, i + 1)
      if (['import', 'charset', 'namespace'].includes(name.value)) { i = atRuleEnd(css, name.end); removedResources++; continue }
    }
    if (/[\w-]/.test(css[i]) || css[i] === '\\') {
      const name = readIdentifier(css, i)
      let opening = name.end
      while (/\s/.test(css[opening] ?? '') && opening < css.length) opening++
      if (css[opening] === '(' && ['url', 'src', 'image-set', '-webkit-image-set', 'expression'].includes(name.value)) {
        const end = balancedEnd(css, opening)
        const raw = css.slice(opening + 1, end - (css[end - 1] === ')' ? 1 : 0)).trim()
        const decoded = decodeCssEscapes((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw).trim()
        const safe = name.value === 'url' && (/^#[\w:.-]+$/.test(decoded) || /^data:(?:image\/(?:png|jpeg|gif|webp)|font\/(?:woff2?|x-woff)|application\/(?:font-woff|x-font-woff));base64,[\da-z+/=\s]+$/i.test(decoded))
        if (safe) output += `url("${decoded.replaceAll('"', '\\"').replaceAll('\n', '')}")`
        else { output += 'none'; removedResources++ }
        i = end; continue
      }
      output += css.slice(i, name.end); i = name.end; continue
    }
    output += css[i++]
  }
  return { css: output.trim(), removedResources }
}

function validPalette(value: unknown, appearance: ThemeAppearance): ThemePalette {
  const fallback = BUILT_IN_THEMES.find((theme) => theme.appearance === appearance)!.palette
  if (!value || typeof value !== 'object') return { ...fallback }
  const input = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(fallback).map(([key, color]) => [key, typeof input[key] === 'string' && /^#[\da-f]{6}$/i.test(input[key]) ? input[key] : color])) as unknown as ThemePalette
}
function normalizeName(value: string): string { const name = value.trim(); if (!name || name.length > 56) throw new Error('主题名称需为 1–56 个字符。'); return name }
function normalizedSelection(state: ThemeLibraryState): ThemeLibraryState {
  const themes = [...BUILT_IN_THEMES, ...state.userThemes]
  return { ...state, lightId: themes.some((theme) => theme.id === state.lightId && theme.appearance === 'light') ? state.lightId : 'builtin-studio', darkId: themes.some((theme) => theme.id === state.darkId && theme.appearance === 'dark') ? state.darkId : 'builtin-midnight' }
}
export function parseThemeLibrary(value: unknown): ThemeLibraryState {
  const defaults = defaultThemeLibrary()
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return defaults
  const input = value as Partial<ThemeLibraryState>, usedIds = new Set(BUILT_IN_THEMES.map((theme) => theme.id))
  const userThemes: WritingTheme[] = []
  for (const theme of Array.isArray(input.userThemes) ? input.userThemes : []) {
    if (userThemes.length >= THEME_LIBRARY_MAX_THEMES) break
    if (!theme || typeof theme !== 'object' || typeof theme.id !== 'string' || !/^user-[\w-]{1,80}$/.test(theme.id) || usedIds.has(theme.id) || typeof theme.name !== 'string' || typeof theme.css !== 'string' || (theme.appearance !== 'light' && theme.appearance !== 'dark')) continue
    try {
      const css = sanitizeThemeCss(theme.css).css
      userThemes.push({ id: theme.id, name: normalizeName(theme.name), description: typeof theme.description === 'string' ? theme.description.slice(0, 200) : '', appearance: theme.appearance, css, palette: validPalette(theme.palette, theme.appearance), builtIn: false, createdAt: Number.isFinite(theme.createdAt) ? theme.createdAt : 0, updatedAt: Number.isFinite(theme.updatedAt) ? theme.updatedAt : 0 })
      usedIds.add(theme.id)
    } catch { /* A damaged entry must not hide the remaining library. */ }
  }
  return normalizedSelection({ version: 1, userThemes, lightId: typeof input.lightId === 'string' ? input.lightId : defaults.lightId, darkId: typeof input.darkId === 'string' ? input.darkId : defaults.darkId })
}
export function allThemes(state: ThemeLibraryState): readonly WritingTheme[] { return [...BUILT_IN_THEMES, ...state.userThemes] }
export function selectedTheme(state: ThemeLibraryState, appearance: ThemeAppearance): WritingTheme { return allThemes(state).find((theme) => theme.id === (appearance === 'light' ? state.lightId : state.darkId) && theme.appearance === appearance) ?? BUILT_IN_THEMES.find((theme) => theme.appearance === appearance)! }
export function selectTheme(state: ThemeLibraryState, appearance: ThemeAppearance, id: string): ThemeLibraryState {
  if (!allThemes(state).some((theme) => theme.id === id && theme.appearance === appearance)) throw new Error('所选主题与明暗模式不匹配。')
  return { ...state, [appearance === 'light' ? 'lightId' : 'darkId']: id }
}
export function addTheme(state: ThemeLibraryState, input: ThemeInput, id = `user-${crypto.randomUUID()}`, now = Date.now()): { state: ThemeLibraryState; theme: WritingTheme; removedResources: number } {
  if (state.userThemes.length >= THEME_LIBRARY_MAX_THEMES) throw new Error('主题库最多保存 40 个自定义主题。')
  if (!/^user-[\w-]{1,80}$/.test(id) || allThemes(state).some((theme) => theme.id === id)) throw new Error('主题标识无效或重复。')
  if (input.appearance !== 'light' && input.appearance !== 'dark') throw new Error('主题明暗模式无效。')
  const result = sanitizeThemeCss(input.css)
  const theme: WritingTheme = { id, name: normalizeName(input.name), appearance: input.appearance, description: (input.description ?? '').slice(0, 200), css: result.css, palette: validPalette(input.palette, input.appearance), builtIn: false, createdAt: now, updatedAt: now }
  return { state: { ...state, userThemes: [...state.userThemes, theme] }, theme, removedResources: result.removedResources }
}
export function updateTheme(state: ThemeLibraryState, id: string, input: ThemeInput, now = Date.now()): { state: ThemeLibraryState; theme: WritingTheme; removedResources: number } {
  const previous = state.userThemes.find((theme) => theme.id === id)
  if (!previous) throw new Error('内置主题不能编辑，请先复制。')
  const result = addTheme({ ...state, userThemes: state.userThemes.filter((theme) => theme.id !== id) }, { ...input, palette: input.palette ?? (previous.appearance === input.appearance ? previous.palette : undefined) }, id, now)
  const theme = { ...result.theme, createdAt: previous.createdAt }
  return { ...result, theme, state: normalizedSelection({ ...state, userThemes: state.userThemes.map((item) => item.id === id ? theme : item) }) }
}
export function duplicateTheme(state: ThemeLibraryState, id: string, newId?: string, now = Date.now()): ReturnType<typeof addTheme> {
  const source = allThemes(state).find((theme) => theme.id === id)
  if (!source) throw new Error('找不到主题。')
  const names = new Set(allThemes(state).map((theme) => theme.name)); let name = `${source.name.slice(0, 48)} 副本`, number = 2
  while (names.has(name)) name = `${source.name.slice(0, 48)} 副本 ${number++}`
  return addTheme(state, { ...source, name }, newId, now)
}
export function deleteTheme(state: ThemeLibraryState, id: string): ThemeLibraryState {
  if (!state.userThemes.some((theme) => theme.id === id)) throw new Error('内置主题不能删除。')
  return normalizedSelection({ ...state, userThemes: state.userThemes.filter((theme) => theme.id !== id) })
}

/** Translate common Markdown theme selectors for the editor and standalone documents. */
export function adaptThemeCss(input: string, target: 'editor' | 'export'): string {
  const css = sanitizeThemeCss(input).css
  const replacement = target === 'editor' ? '.markdown-editor .milkdown .ProseMirror' : 'body'
  let result = '', start = 0, depth = 0, quote = ''
  // Rewrite only rule headers. Quoted declarations, data URLs and font names remain intact.
  for (let i = 0; i < css.length; i++) {
    const char = css[i]
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(' || char === '[') { depth++; continue }
    if (char === ')' || char === ']') { depth--; continue }
    if (depth !== 0) continue
    if (char === '{') {
      let header = css.slice(start, i)
      if (!header.trim().startsWith('@')) {
        header = header.replace(/\.markdown-editor\s+\.milkdown(?:\s+\.(?:ProseMirror|editor))?\b|\.markdown-editor\s+\.ProseMirror\b|\.milkdown\s+\.(?:ProseMirror|editor)\b|#write\b|\.milkdown\b|\.ProseMirror\b/g, replacement)
        if (target === 'editor') header = header.replace(/:root(?![\w-]|\[)/g, ':root[data-theme]')
        else header = header.replace(/:root\[data-theme\]/g, ':root')
      }
      result += header + '{'; start = i + 1
    } else if (char === '}' || char === ';') { result += css.slice(start, i + 1); start = i + 1 }
  }
  return result + css.slice(start)
}
export function combinedThemeCss(theme: WritingTheme, customCss: string, target: 'editor' | 'export'): string {
  const baseCss = theme.builtIn ? '' : adaptThemeCss(BUILT_IN_THEMES.find((item) => item.appearance === theme.appearance)!.css, target)
  const editorVariables = target === 'editor' ? `
.markdown-editor .milkdown { --crepe-color-background: var(--surface); --crepe-color-on-background: var(--text); --crepe-color-surface: var(--surface-elevated); --crepe-color-surface-low: var(--app-bg); --crepe-color-on-surface: var(--text); --crepe-color-on-surface-variant: var(--muted); --crepe-color-outline: var(--border-strong); --crepe-color-primary: var(--accent); --crepe-color-secondary: var(--accent-soft); --crepe-color-on-secondary: var(--text); --crepe-color-inverse: var(--text); --crepe-color-on-inverse: var(--surface); --crepe-color-inline-code: var(--accent); --crepe-color-hover: var(--accent-soft); --crepe-color-selected: var(--accent-soft); --crepe-color-inline-area: var(--app-bg); }
.brand-mark, .save-button { background: var(--accent); color: var(--surface); } .brand-mark > span { color: var(--accent-soft); }` : ''
  return `${baseCss}\n${adaptThemeCss(theme.css, target)}\n${editorVariables}\n${adaptThemeCss(customCss, target)}`.trim()
}
