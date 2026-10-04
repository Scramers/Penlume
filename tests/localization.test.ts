import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { englishMessages } from '../src/shared/localization-en'
import { englishMessageKeys, hasEnglishTranslation, localized, localizedDocumentName, localizedThemeName, normalizeInterfaceLanguage, parseLocalizedMessage, translate, translateMessage, type InterfaceLanguage } from '../src/shared/localization'
import { LocalizationProvider, readInterfaceLanguage } from '../src/renderer/localization'
import { PreferencesPanel } from '../src/renderer/components/PreferencesPanel'
import { Sidebar } from '../src/renderer/components/Sidebar'
import { DocumentTabs } from '../src/renderer/components/DocumentTabs'
import { ImageLibrary } from '../src/renderer/components/ImageLibrary'
import { ImageUploader } from '../src/renderer/components/ImageUploader'
import { themePreviewHtml } from '../src/renderer/components/ThemeLibrary'
import { defaultPreferences } from '../src/shared/preferences'
import { newDocument } from '../src/shared/document-session'
import { BUILT_IN_THEMES } from '../src/shared/theme-library'
import { imageUploaderSettingsSchema } from '../src/shared/image-uploader'

function render(locale: InterfaceLanguage, children: ReactNode) { return renderToStaticMarkup(createElement(LocalizationProvider, { initialLocale: locale, children })) }
const noop = () => {}
afterEach(() => vi.unstubAllGlobals())

describe('explicit interface localization', () => {
  it('defaults to Simplified Chinese and accepts only supported persisted values', () => {
    for (const value of [undefined, null, 'en-US', 'fr', '', {}, 'zh-CN']) expect(normalizeInterfaceLanguage(value)).toBe('zh-CN')
    expect(normalizeInterfaceLanguage('en')).toBe('en')
    vi.stubGlobal('localStorage', { getItem: () => 'en' }); expect(readInterfaceLanguage()).toBe('en')
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') } }); expect(readInterfaceLanguage()).toBe('zh-CN')
  })
  it('keeps default labels and interpolates user values without translating them', () => {
    const name = '保存 <script> {count}.md'
    expect(translate('zh-CN', '{name} 有未保存的修改。', { name })).toBe(`${name} 有未保存的修改。`)
    expect(translate('en', '{name} 有未保存的修改。', { name })).toBe(`${name} has unsaved changes.`)
    expect(translate('en', '导出 {format}', { format: 'PDF' })).toBe('Export PDF')
    expect(translate('en', '{count} 个文档有未保存的修改。', { count: 0 })).toBe('0 documents have unsaved changes.')
    expect(translate('en', '参数数组必须包含 {file} 占位符。')).toContain('{file}')
  })
  it('does not treat prototype properties or unknown user text as catalog entries', () => {
    for (const key of ['constructor', 'toString', '__proto__', '我的随笔.md', 'A 未翻译的用户标题']) expect(translate('en', key)).toBe(key)
    expect(hasEnglishTranslation('toString')).toBe(false)
  })
  it('supports deliberately localized nested labels without translating raw names', () => {
    expect(translate('en', '已应用「{value1}」。', { value1: '暖纸' })).toBe('Applied “暖纸”.')
    expect(translate('en', '已应用「{value1}」。', { value1: localized('暖纸') })).toBe('Applied “Warm Paper”.')
  })
  it('reconstructs IPC feedback keys in either language while preserving filenames and diagnostic text', () => {
    const name = '保存-图像.png', source = `正在上传 ${name}…`
    const parsed = parseLocalizedMessage(source)
    expect(parsed.params).toEqual({ value1: name })
    const english = translateMessage('en', source)
    expect(english).toBe(`Uploading ${name}…`)
    expect(translateMessage('zh-CN', english)).toBe(source)
    const diagnostic = 'engine diagnostic: 标题、路径\nUnexpected token <script>'
    expect(translateMessage('en', `Pandoc 转换失败（1）：${diagnostic}`)).toBe(`Pandoc conversion failed (1): ${diagnostic}`)
    expect(translateMessage('en', diagnostic)).toBe(diagnostic)
    expect(translateMessage('en', '已保存：中文文件.md')).toBe('Saved: 中文文件.md')
  })
  it('translates only auto-unnamed display labels and built-in theme identities', () => {
    expect(localizedDocumentName('en', '未命名.md', null)).toBe('Untitled document')
    expect(localizedDocumentName('zh-CN', '未命名.md', null)).toBe('未命名.md')
    expect(localizedDocumentName('en', '未命名.md', 'G:/notes/未命名.md')).toBe('未命名.md')
    expect(localizedDocumentName('en', '我的随笔', null)).toBe('我的随笔')
    expect(localizedThemeName('en', BUILT_IN_THEMES[1])).toBe('Warm Paper')
    expect(localizedThemeName('en', { id: 'user-own', builtIn: false, name: '暖纸' })).toBe('暖纸')
  })
  it('renders preferences and their aria labels in both languages while preserving custom text', () => {
    const props = { value: { ...defaultPreferences, customCss: '/* 我的 CSS */' }, onChange: noop, onClose: noop }
    const chinese = render('zh-CN', createElement(PreferencesPanel, props)), english = render('en', createElement(PreferencesPanel, props))
    expect(chinese).toContain('aria-label="界面语言"'); expect(chinese).toContain('偏好设置')
    expect(english).toContain('aria-label="Interface language"'); expect(english).toContain('Preferences'); expect(english).toContain('Custom theme CSS')
    expect(english).toContain('/* 我的 CSS */'); expect(english).not.toContain('恢复默认设置')
  })
  it('localizes tabs and sidebar controls without altering headings or filesystem paths', () => {
    const saved = { ...newDocument(), id: 'saved', path: 'G:/笔记/未命名.md', displayName: '未命名.md' }, unnamed = newDocument()
    const tabs = render('en', createElement(DocumentTabs, { session: { documents: [saved, unnamed], activeId: unnamed.id }, onActivate: noop, onClose: noop, onNew: noop }))
    expect(tabs).toContain('Untitled document'); expect(tabs).toContain('G:/笔记/未命名.md'); expect(tabs).toContain('>未命名.md<')
    const sidebar = render('en', createElement(Sidebar, { activePath: null, outlineDocumentId: 'localization-fixture', onOutlineControlAction: noop, headings: [{ text: '我的正文标题', level: 1, line: 4 }], mode: 'outline', workspace: null, onClose: noop, onHeadingClick: noop, onModeChange: noop, onOpenFile: noop, onOpenWorkspace: noop, onRefreshWorkspace: noop, onManage: noop }))
    expect(sidebar).toContain('Heading depth'); expect(sidebar).toContain('title="Line 4"'); expect(sidebar).toContain('我的正文标题')
  })
  it('renders image management and uploader controls in English and preserves document names', () => {
    const images = render('en', createElement(ImageLibrary, { documentName: '我的文档.md', onRefresh: async () => { throw new Error('unused') }, onMutate: async () => { throw new Error('unused') }, onUpload: noop, onClose: noop }))
    expect(images).toContain('Image resource manager'); expect(images).toContain('Upload images…'); expect(images).toContain('我的文档.md'); expect(images).not.toContain('图片资源分类')
    const uploader = render('en', createElement(ImageUploader, { documentName: '我的文档.md', documentPath: 'G:/notes/我的文档.md', images: [], onReadSettings: async () => imageUploaderSettingsSchema.parse({}), onChooseExecutable: async () => null, onSaveSettings: async () => imageUploaderSettingsSchema.parse({}), onUpload: async () => { throw new Error('unused') }, onCancel: noop, onGetTask: async () => null, onProgress: () => noop, onApply: async () => { throw new Error('unused') }, onClose: noop }))
    expect(uploader).toContain('Upload selected images'); expect(uploader).toContain('Arguments (JSON array)'); expect(uploader).toContain('{file}'); expect(uploader).toContain('我的文档.md'); expect(uploader).not.toContain('shell:false')
  })
  it('localizes theme preview samples without weakening their network and script restrictions', () => {
    const css = BUILT_IN_THEMES[0].css
    const preview = themePreviewHtml(css, false, 'light', 'en')
    expect(preview).toContain('A place for your words'); expect(preview).not.toContain('给文字一处风景')
    expect(preview).toContain("default-src 'none'"); expect(preview).not.toContain('<script')
    expect(themePreviewHtml(css)).toContain('给文字一处风景')
  })
})

describe('catalog coverage review', () => {
  it('keeps placeholders compatible and all English catalog entries free of untranslated Chinese', () => {
    for (const [key, value] of Object.entries(englishMessages)) {
      expect(value, key).not.toMatch(/[\u4e00-\u9fff]/)
      expect([...value.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort(), key).toEqual([...key.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort())
    }
    expect(englishMessageKeys.length).toBeGreaterThan(500)
  })
  it('audits renderer chrome, shared display labels, native menus/dialogs and service diagnostics', () => {
    const root = path.resolve(__dirname, '..')
    const files = ['src/renderer/App.tsx', ...readdirSync(path.join(root, 'src/renderer/components')).filter((file) => file.endsWith('.tsx') && file !== 'Icon.tsx').map((file) => `src/renderer/components/${file}`), ...readdirSync(path.join(root, 'src/main')).filter((file) => file.endsWith('.ts')).map((file) => `src/main/${file}`), 'src/shared/formatting.ts', 'src/shared/pandoc.ts', 'src/shared/theme-library.ts', 'src/shared/image-uploader.ts', 'src/renderer/theme-library.ts']
    const preservedData: Record<string, Set<string>> = {
      'src/renderer/App.tsx': new Set(['（恢复副本）']),
      'src/renderer/components/FileActionsPanel.tsx': new Set(['新文档.md']),
      'src/shared/theme-library.ts': new Set(['{value1} 副本', '{value1} 副本 {value2}']),
    }
    const missing: string[] = [], rawJsx: string[] = []
    for (const file of files) {
      const ast = parse(readFileSync(path.join(root, file), 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] })
      const review = (key: string, line: number) => { if (/[\u4e00-\u9fff]/.test(key) && !key.includes('\n') && !hasEnglishTranslation(key) && !preservedData[file]?.has(key)) missing.push(`${file}:${line}: ${key}`) }
      function walk(node: unknown) {
        if (!node || typeof node !== 'object') return
        const value = node as { type?: string; value?: string; loc?: { start: { line: number } }; quasis?: { value: { cooked: string } }[]; expressions?: unknown[] }
        if (value.type === 'StringLiteral') review(value.value ?? '', value.loc?.start.line ?? 0)
        if (value.type === 'JSXText' && /[\u4e00-\u9fff]/.test(value.value ?? '')) rawJsx.push(`${file}:${value.loc?.start.line}: ${value.value?.trim()}`)
        if (value.type === 'TemplateLiteral' && value.expressions?.length && !value.quasis?.some((part) => part.value.cooked.includes('<'))) { let key = value.quasis![0].value.cooked; value.expressions.forEach((_, index) => { key += `{value${index + 1}}${value.quasis![index + 1].value.cooked}` }); review(key, value.loc?.start.line ?? 0) }
        for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child)
      }
      walk(ast)
    }
    expect(missing).toEqual([]); expect(rawJsx).toEqual([])
  })
})
