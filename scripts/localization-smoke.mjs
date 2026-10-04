import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

// Run after the root build. This script never builds or writes dist.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-localization-'))
const workspace = path.join(temporary, '中文笔记'), artifacts = path.join(root, 'artifacts/localization')
const note = path.join(workspace, '保存-我的正文.md'), image = path.join(workspace, '中文图片.png')
const original = '# 中文正文保持原样\n\n保存、文件、视图都是正文，不应被界面翻译改变。\n\n![图片说明保持原样](中文图片.png)\n\n## English and 中文\n\nA paragraph with **bold** text.\n'
const customCss = '/* 用户自定义 CSS 保留 */\n#write h1 { color: #43765e; }'
const themeName = '用户保留主题-中文', themeCss = '#write h1 { color: #4b7251; }'
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
await writeFile(note, original); await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
let application, page
const pageErrors = []
const nativeChecks = []
try {
  const packaged = process.env.TTYPORA_PACKAGED_EXE
  const args = ['--disable-gpu', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? args : [...args, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow({ timeout: 15000 })
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const command = (value) => application.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', command), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const nativeLabels = () => application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((item) => ({ label: item.label, items: item.submenu?.items.map((child) => child.label) ?? [] })))
  const waitMenu = async (label) => { for (let attempt = 0; attempt < 100; attempt++) { if ((await nativeLabels())[0]?.label === label) return; await new Promise((resolve) => setTimeout(resolve, 50)) } throw new Error(`Native menu did not switch to ${label}`) }
  const preferences = async (locale) => { await command('preferences'); const dialog = page.getByRole('dialog', { name: locale === 'en' ? 'Preferences' : '偏好设置', exact: true }); await dialog.waitFor(); return dialog }
  const closeDialog = async (dialog, locale) => { await dialog.getByRole('button', { name: locale === 'en' ? 'Done' : '完成', exact: true }).click(); await dialog.waitFor({ state: 'detached' }) }

  await ready()
  const initialTitle = await page.title()
  assert.match(initialTitle, /^未命名/)
  await page.evaluate(() => { window.localizationEditorNode = document.querySelector('.ProseMirror') })
  let prefs = await preferences('zh-CN')
  await prefs.getByLabel('界面语言', { exact: true }).selectOption('en')
  prefs = page.getByRole('dialog', { name: 'Preferences', exact: true })
  await prefs.waitFor(); await waitMenu('File')
  await page.waitForFunction(() => document.title === 'Untitled document — Penlume')
  assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  assert.equal(await page.evaluate(() => document.querySelector('.ProseMirror') === window.localizationEditorNode), true)
  assert.equal(await page.evaluate(() => localStorage.getItem('ttypora.interface-language')), 'en')
  await prefs.getByLabel('Custom CSS', { exact: true }).fill(customCss)
  // Session restoration is opt-in; enable it explicitly for the reload assertion below.
  await prefs.getByRole('checkbox', { name: 'Restore the last documents and folder on startup', exact: true }).check()
  await closeDialog(prefs, 'en')
  assert.equal(await page.getByRole('button', { name: 'Layout and size', exact: true }).getAttribute('title'), 'Layout and size')
  let menus = await nativeLabels()
  assert.deepEqual(menus.slice(0, 4).map((item) => item.label), ['File', 'Edit', 'Format', 'View'])
  assert.ok(menus.flatMap((item) => item.items).includes('Upload document images…'))
  assert.ok(menus.flatMap((item) => item.items).includes('Insert audio / video…'))

  await application.evaluate(({ dialog }) => {
    globalThis.localeOriginalOpen = dialog.showOpenDialog; globalThis.localeOriginalMessage = dialog.showMessageBox
    dialog.showOpenDialog = async (_window, options) => { globalThis.localeOpenOptions = options; return { canceled: true, filePaths: [] } }
    dialog.showMessageBox = async (_window, options) => { globalThis.localeMessageOptions = options; return { response: 2, checkboxChecked: false } }
  })
  await page.evaluate(() => window.ttypora.openDocument())
  let options = await application.evaluate(() => globalThis.localeOpenOptions)
  assert.equal(options.title, 'Open Markdown file'); assert.equal(options.filters[0].name, 'Markdown and text'); nativeChecks.push(options.title)
  await page.evaluate(() => window.ttypora.confirmUnsaved('保存-我的正文.md'))
  options = await application.evaluate(() => globalThis.localeMessageOptions)
  assert.equal(options.message, '保存-我的正文.md has unsaved changes.')
  assert.deepEqual(options.buttons, ['Save', 'Discard changes', 'Cancel']); nativeChecks.push(options.message)
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.localeOriginalOpen; dialog.showMessageBox = globalThis.localeOriginalMessage })

  await command('show-files'); await command('open-workspace')
  await page.locator('.file-tree').getByTitle(note, { exact: true }).click()
  await page.waitForFunction((name) => document.title.includes(name), path.basename(note)); await ready()
  const writingText = await page.locator('.ProseMirror').innerText()
  assert.ok(writingText.includes('保存、文件、视图都是正文'))
  assert.equal(await page.locator('.statusbar__path').innerText(), note)
  assert.equal(await readFile(note, 'utf8'), original)

  await command('command-palette')
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  await palette.getByLabel('Search commands').fill('upload')
  await palette.getByRole('option', { name: /Upload document images/ }).waitFor()
  await palette.getByLabel('Close', { exact: true }).click()
  await command('theme-library')
  let themes = page.getByRole('dialog', { name: 'Theme studio', exact: true })
  await themes.waitFor(); await themes.getByText('Clear Blue', { exact: true }).first().waitFor()
  await themes.getByRole('button', { name: 'New theme', exact: true }).click()
  await themes.getByLabel('Theme name', { exact: true }).fill(themeName)
  await themes.getByLabel('Theme description', { exact: true }).fill('用户主题描述也应保留')
  await themes.getByLabel('Theme CSS', { exact: true }).fill(themeCss)
  await themes.getByRole('button', { name: 'Save theme', exact: true }).click()
  await themes.getByRole('button', { name: `Preview theme ${themeName}`, exact: true }).waitFor()
  await closeDialog(themes, 'en')

  await command('image-library')
  const library = page.getByRole('dialog', { name: 'Image resource manager', exact: true })
  await library.waitFor(); await page.waitForFunction(() => document.querySelector('.image-library')?.getAttribute('aria-busy') === 'false')
  const imageRow = library.locator('.image-library__row').filter({ hasText: '中文图片.png' })
  assert.match(await imageRow.innerText(), /Local image.*1 references/)
  await library.getByRole('button', { name: 'Upload images…', exact: true }).click()
  const uploader = page.getByRole('dialog', { name: 'Image upload', exact: true })
  await uploader.waitFor(); await library.waitFor({ state: 'detached' })
  await uploader.getByText('中文图片.png', { exact: true }).waitFor()
  assert.equal(await uploader.getByRole('button', { name: 'Upload selected images', exact: true }).isDisabled(), true)
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async (_window, options) => { globalThis.localeOpenOptions = options; return { canceled: true, filePaths: [] } } })
  await uploader.getByRole('button', { name: 'Choose upload program…', exact: true }).click()
  options = await application.evaluate(() => globalThis.localeOpenOptions)
  assert.equal(options.title, 'Choose image upload program'); nativeChecks.push(options.title)
  await page.evaluate((snapshot) => window.ttypora.chooseMediaAsset(snapshot), { documentPath: note, markdown: original })
  options = await application.evaluate(() => globalThis.localeOpenOptions)
  assert.equal(options.title, 'Insert local audio / video'); nativeChecks.push(options.title)
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.localeOriginalOpen })
  await closeDialog(uploader, 'en')

  await command('document-conversion')
  const conversion = page.getByRole('dialog', { name: 'Document conversion', exact: true })
  await conversion.waitFor(); await conversion.getByLabel('Output format', { exact: true }).waitFor()
  await conversion.getByRole('button', { name: 'Close', exact: true }).last().click()
  assert.equal(await page.locator('.ProseMirror').innerText(), writingText)
  const beforeReload = await page.evaluate(() => ({ css: JSON.parse(localStorage.getItem('ttypora.preferences')).customCss, themes: JSON.parse(localStorage.getItem('ttypora.theme-library.v1')).userThemes }))
  assert.equal(beforeReload.css, customCss)
  assert.ok(beforeReload.themes.some((theme) => theme.name === themeName && theme.css === themeCss))

  await page.reload(); await page.waitForFunction((name) => document.title.includes(name), path.basename(note)); await ready()
  assert.equal(await page.locator('html').getAttribute('lang'), 'en'); await waitMenu('File')
  assert.equal(await page.locator('.ProseMirror').innerText(), writingText)
  assert.equal(await page.locator('.statusbar__path').innerText(), note)
  await page.evaluate(() => { window.localizationEditorNode = document.querySelector('.ProseMirror') })
  prefs = await preferences('en')
  assert.equal(await prefs.getByLabel('Custom CSS', { exact: true }).inputValue(), customCss)
  await prefs.getByLabel('Interface language', { exact: true }).selectOption('zh-CN')
  prefs = page.getByRole('dialog', { name: '偏好设置', exact: true })
  await prefs.waitFor(); await waitMenu('文件')
  assert.equal(await page.evaluate(() => document.querySelector('.ProseMirror') === window.localizationEditorNode), true)
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  await closeDialog(prefs, 'zh-CN')
  await command('theme-library'); themes = page.getByRole('dialog', { name: '主题工坊', exact: true })
  await themes.getByRole('button', { name: `预览主题 ${themeName}`, exact: true }).waitFor()
  await closeDialog(themes, 'zh-CN')
  assert.equal(await page.locator('.ProseMirror').innerText(), writingText)
  assert.equal(await page.locator('.statusbar__path').innerText(), note)
  assert.equal(await readFile(note, 'utf8'), original)
  assert.deepEqual(pageErrors, [])
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  await page.screenshot({ path: path.join(artifacts, 'app-localization.png'), animations: 'disabled', timeout: 60000 })
  await writeFile(path.join(artifacts, 'app-verification.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), immediateEnglishSwitch: true, nativeMenusAndDialogs: nativeChecks, untitledDisplayTranslated: true, editorNodePreserved: true, bodyAndFilenameAndCssAndThemeNamePreserved: true, persistedAfterReload: true, switchedBackToChinese: true, panels: ['preferences', 'command palette', 'theme library', 'image library', 'image uploader', 'conversion'], pageErrors }, null, 2))
  console.log('Actual Electron UI, menus and dialogs switch to English and back, persist after reload, and keep the editor, Chinese body, paths, custom CSS and user theme names intact.')
} finally {
  await application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy())).catch(() => {})
  await application?.close().catch(() => {})
  if (pageErrors.length) await writeFile(path.join(artifacts, 'app-errors.json'), JSON.stringify(pageErrors, null, 2))
  if (path.dirname(path.resolve(temporary)) === path.resolve(tmpdir()) && path.basename(temporary).startsWith('ttypora-localization-')) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
}
