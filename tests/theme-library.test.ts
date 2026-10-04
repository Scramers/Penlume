import { describe, expect, it } from 'vitest'
import { adaptThemeCss, addTheme, allThemes, BUILT_IN_THEMES, combinedThemeCss, defaultThemeLibrary, deleteTheme, duplicateTheme, parseThemeLibrary, sanitizeThemeCss, selectTheme, selectedTheme, THEME_CSS_MAX_BYTES, THEME_LIBRARY_MAX_THEMES, updateTheme } from '../src/shared/theme-library'

describe('local writing theme library', () => {
  it('provides eight original themes, with independent light and dark selections', () => {
    const initial = defaultThemeLibrary()
    expect(BUILT_IN_THEMES).toHaveLength(8)
    expect(BUILT_IN_THEMES.filter((theme) => theme.appearance === 'dark')).toHaveLength(4)
    const next = selectTheme(initial, 'light', 'builtin-paper')
    expect(selectedTheme(next, 'light').name).toBe('暖纸')
    expect(selectedTheme(next, 'dark').id).toBe(initial.darkId)
    expect(() => selectTheme(next, 'dark', 'builtin-paper')).toThrow('不匹配')
    expect(initial.lightId).toBe('builtin-studio')
  })

  it('imports, edits and renames user themes while preserving creation time and order', () => {
    const created = addTheme(defaultThemeLibrary(), { name: '  我的绿意  ', appearance: 'light', css: '#write { color: green; }' }, 'user-1', 10)
    const selected = selectTheme(created.state, 'light', created.theme.id)
    const result = updateTheme(selected, created.theme.id, { name: '青林', appearance: 'light', css: '#write { color: teal; }', description: '长文写作' }, 30)
    expect(result.theme).toMatchObject({ name: '青林', createdAt: 10, updatedAt: 30, builtIn: false })
    expect(result.state.lightId).toBe('user-1')
    expect(result.state.userThemes[0].css).toContain('teal')
    expect(created.state.userThemes[0].name).toBe('我的绿意')
  })

  it('duplicates built-ins into editable themes and chooses a unique copy name', () => {
    const copy = duplicateTheme(defaultThemeLibrary(), 'builtin-paper', 'user-copy', 50)
    const copy2 = duplicateTheme(copy.state, 'builtin-paper', 'user-copy2', 60)
    expect(copy.theme).toMatchObject({ name: '暖纸 副本', builtIn: false, appearance: 'light' })
    expect(copy.theme.css).toBe(BUILT_IN_THEMES.find((theme) => theme.id === 'builtin-paper')!.css)
    expect(copy2.theme.name).toBe('暖纸 副本 2')
    expect(() => deleteTheme(copy.state, 'builtin-paper')).toThrow('内置')
    expect(() => updateTheme(copy.state, 'builtin-paper', copy.theme)).toThrow('内置')
  })

  it('falls back safely after deleting or changing the appearance of the selected custom theme', () => {
    const created = addTheme(defaultThemeLibrary(), { name: '本机主题', appearance: 'light', css: '' }, 'user-1')
    const chosen = selectTheme(created.state, 'light', 'user-1')
    expect(deleteTheme(chosen, 'user-1').lightId).toBe('builtin-studio')
    const changed = updateTheme(chosen, 'user-1', { name: '夜间', appearance: 'dark', css: '' })
    expect(changed.state.lightId).toBe('builtin-studio')
    expect(changed.theme.palette).toEqual(selectedTheme(defaultThemeLibrary(), 'dark').palette)
    expect(selectTheme(changed.state, 'dark', 'user-1').darkId).toBe('user-1')
  })

  it('round-trips a persisted library and recovers valid entries around damaged data', () => {
    const created = addTheme(defaultThemeLibrary(), { name: '夜读', appearance: 'dark', css: '#write h1 { color: coral; }' }, 'user-1', 25)
    const selected = selectTheme(created.state, 'dark', 'user-1')
    expect(parseThemeLibrary(JSON.parse(JSON.stringify(selected)))).toEqual(selected)
    const recovered = parseThemeLibrary({ ...selected, lightId: 'missing', userThemes: [{ id: 'builtin-studio' }, null, ...selected.userThemes, { ...created.theme, name: 'duplicate' }, { ...created.theme, id: 'user-bad', css: 'x'.repeat(THEME_CSS_MAX_BYTES + 1) }] })
    expect(recovered.userThemes).toHaveLength(1)
    expect(recovered.lightId).toBe('builtin-studio')
    expect(recovered.darkId).toBe('user-1')
    expect(parseThemeLibrary({ version: 2 })).toEqual(defaultThemeLibrary())
  })

  it('limits UTF-8 bytes and the number of user themes without modifying existing state', () => {
    expect(() => sanitizeThemeCss('字'.repeat(34000))).toThrow('100 KB')
    let state = defaultThemeLibrary()
    for (let i = 0; i < THEME_LIBRARY_MAX_THEMES; i++) state = addTheme(state, { name: `主题${i}`, appearance: 'light', css: '' }, `user-${i}`).state
    expect(() => addTheme(state, { name: '超限', appearance: 'light', css: '' }, 'user-limit')).toThrow('40')
    expect(allThemes(state)).toHaveLength(48)
    expect(() => addTheme(defaultThemeLibrary(), { name: ' ', appearance: 'dark', css: '' })).toThrow('名称')
  })
})

describe('self-contained theme CSS', () => {
  it('removes imports, remote and relative resources, including escaped identifiers', () => {
    const result = sanitizeThemeCss(String.raw`@import "https://example.com/a.css" layer(theme);
@\69 mport u\72l(//example.com/b.css);
#write { color: teal; background-image: u/**/rl(https://example.com/x.png); mask: URL('../local.svg'); border-image: url(\68 ttps://example.com/border.png); }`)
    expect(result.css).not.toMatch(/example\.com|local\.svg|@import/i)
    expect(result.css).toContain('color: teal')
    expect(result.removedResources).toBe(5)
  })

  it('prevents image-set and src functions from loading URL strings, while preserving textual strings', () => {
    const result = sanitizeThemeCss(String.raw`#write { --caption: "url(https://caption.example)"; content: "@import"; background-image: image-set("https://a.example" 1x, url(//b.example) 2x); mask: -webkit-image-set("x.png" 1x); --font: s\72 c("https://font.example"); }`)
    expect(result.css).toContain('--caption: "url(https://caption.example)"')
    expect(result.css).toContain('content: "@import"')
    expect(result.css).not.toMatch(/a\.example|b\.example|x\.png|font\.example/)
    expect(result.removedResources).toBe(3)
  })

  it('retains self-contained raster images, fonts and fragment references but drops SVG data with embedded references', () => {
    const result = sanitizeThemeCss(`#write { background: url(data:image/png;base64,aGVsbG8=); mask: url("#local-mask"); } @font-face { font-family: Local; src: local("Local"), url('data:font/woff2;base64,aGVsbG8='); } .unsafe { background: url("data:image/svg+xml,<svg>external</svg>"); }`)
    expect(result.css).toContain('url("data:image/png;base64,aGVsbG8=")')
    expect(result.css).toContain('url("data:font/woff2;base64,aGVsbG8=")')
    expect(result.css).toContain('url("#local-mask")')
    expect(result.css).not.toContain('svg+xml')
    expect(result.removedResources).toBe(1)
  })

  it('adapts Markdown selectors in nested rules without altering declaration strings or at-rules', () => {
    const css = ':root { --sample: "#write .milkdown"; } @media (max-width: 700px) { #write h1, .milkdown blockquote { color: teal; } } @font-face { font-family: "#write"; src: local("#write"); }'
    const editor = adaptThemeCss(css, 'editor')
    expect(editor).toContain(':root[data-theme] { --sample: "#write .milkdown"; }')
    expect(editor).toContain('.markdown-editor .milkdown .ProseMirror h1, .markdown-editor .milkdown .ProseMirror blockquote')
    const exported = adaptThemeCss(editor, 'export')
    expect(exported).toContain('body h1, body blockquote')
    expect(exported).toContain('font-family: "#write"; src: local("#write")')
  })

  it('combines the selected theme with existing custom CSS in override order for both editing and export', () => {
    const theme = selectedTheme(selectTheme(defaultThemeLibrary(), 'dark', 'builtin-forest'), 'dark')
    const editor = combinedThemeCss(theme, '#write h1 { color: coral; }', 'editor')
    const exported = combinedThemeCss(theme, '#write h1 { color: coral; }', 'export')
    expect(editor).toContain('--crepe-color-background: var(--surface)')
    expect(editor.endsWith('.markdown-editor .milkdown .ProseMirror h1 { color: coral; }')).toBe(true)
    expect(exported).toContain('color-scheme: dark')
    expect(exported).toContain('background: var(--surface)')
    expect(exported.endsWith('body h1 { color: coral; }')).toBe(true)
  })

  it('uses a dark document baseline for a small custom theme and handles editor-root CSS on export', () => {
    const created = addTheme(defaultThemeLibrary(), { name: '夜读微调', appearance: 'dark', css: '.markdown-editor .milkdown .editor h1 { color: coral; }' }, 'user-small')
    const exported = combinedThemeCss(created.theme, '', 'export')
    expect(exported).toContain('color-scheme: dark')
    expect(exported).toContain('body h1 { color: coral; }')
    expect(adaptThemeCss(':root[data-theme] { --text: #123456; }', 'export')).toContain(':root { --text: #123456; }')
  })
})
