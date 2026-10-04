import { showFormattingToolbar, cycleAppearance } from './smoke-ui.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-image-library-ui-'))
const workspace = path.join(temporary, 'notes'), artifacts = path.join(root, 'artifacts')
const documentPath = path.join(workspace, 'main.md'), draftPath = path.join(workspace, 'draft.md'), assets = path.join(workspace, 'main.assets')
const outside = path.join(temporary, 'outside.md'), outsideImage = path.join(temporary, 'outside.png')
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const original = '# 图片资源验收\n\n![Inline](photo%20name.png)\n\n![Reference][photo]\n\n[ordinary link][photo]\n\n[photo]: photo%20name.png "Sample"\n\n<img src="photo%20name.png" alt="HTML source">\n\n![missing](missing.png)\n\n![remote](https://example.com/photo.png)\n'
await mkdir(assets, { recursive: true }); await mkdir(artifacts, { recursive: true })
await writeFile(documentPath, original); await writeFile(draftPath, '# Draft\n')
await writeFile(path.join(workspace, 'unopened.md'), '# Shared asset\n\n![shared](main.assets/protected.png)\n')
await writeFile(path.join(workspace, 'photo name.png'), bytes)
for (const name of ['protected.png', 'draft-protected.png', 'audit.png']) await writeFile(path.join(assets, name), bytes)
await writeFile(outside, '# Unauthorized'); await writeFile(outsideImage, bytes)
let application, page
const pageErrors = []
try {
  const packaged = process.env.TTYPORA_PACKAGED_EXE
  const browserArgs = ['--disable-gpu', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  application = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: packaged ? browserArgs : [...browserArgs, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); await showFormattingToolbar(application, page); await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', (error) => { pageErrors.push(String(error)); console.error('Page error:', error.stack) })
  const command = (value) => application.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', command), value)
  const source = () => page.locator('.source-editor .cm-content')
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const open = async (name) => { await page.locator('.file-tree .tree-entry--file').filter({ hasText: name }).click(); await page.waitForFunction((name) => document.title.includes(name), name); await ready() }
  const tabs = page.getByRole('tablist', { name: '打开的文档' })
  const switchTab = async (name) => { await tabs.getByRole('tab', { name }).click(); await page.waitForFunction((name) => document.title.includes(name), name); await ready() }
  const dialog = () => page.getByRole('dialog', { name: '图片资源管理', exact: true })
  const openLibrary = async () => { await command('image-library'); await dialog().waitFor(); await dialog().getByRole('button', { name: '刷新检查', exact: true }).waitFor(); await dialog().getByRole('button', { name: '刷新检查', exact: true }).isEnabled(); await page.waitForFunction(() => document.querySelector('.image-library')?.getAttribute('aria-busy') === 'false') }
  const closeLibrary = async () => { await dialog().getByRole('button', { name: '完成', exact: true }).click(); await dialog().waitFor({ state: 'detached' }); await ready() }
  const selectImage = async (name) => { await dialog().locator('.image-library__row').filter({ has: page.locator('strong', { hasText: name }) }).click() }
  const save = async () => { await command('save-document'); await page.waitForFunction(() => !document.title.startsWith('●')); return readFile(documentPath, 'utf8') }
  const resultNotice = async (text) => { await dialog().getByRole('status').filter({ hasText: text }).waitFor(); await page.waitForFunction(() => document.querySelector('.image-library')?.getAttribute('aria-busy') === 'false') }
  const undo = async () => { await page.getByRole('button', { name: '撤销', exact: true }).click() }
  const redo = async () => { await page.getByRole('button', { name: '重做', exact: true }).click() }
  const orphanRow = (name) => dialog().locator('.image-library__resource').filter({ has: page.locator('strong').filter({ hasText: name }) })
  const snapshot = (markdown, relatedDocuments = []) => page.evaluate((request) => window.ttypora.listImages(request), { documentPath, markdown, relatedDocuments })
  const capture = async (name) => {
    // Parallel desktop checks have independent profiles but share the compositor.
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
    await page.screenshot({ path: path.join(artifacts, name), animations: 'disabled', timeout: 60000 })
  }

  await ready(); await command('open-workspace'); await open('main.md'); await command('toggle-source-mode'); await source().waitFor()
  await openLibrary()
  assert.equal(await dialog().locator('.image-library__row').count(), 3)
  assert.match(await dialog().locator('.image-library__row').filter({ hasText: 'photo name.png' }).innerText(), /3 处引用/)
  assert.match(await dialog().locator('.image-library__row').filter({ hasText: 'missing.png' }).innerText(), /文件缺失/)
  assert.match(await dialog().locator('.image-library__row').filter({ hasText: 'remote' }).innerText(), /远程图片/)
  await selectImage('photo name.png')
  await page.waitForFunction(() => { const image = document.querySelector('.image-library__detail img'); return image?.complete && image.naturalWidth === 1 })
  await capture('image-library-light.png')
  console.log('Image library lists grouped Markdown/reference/HTML images, local previews, missing files and remote URLs.')

  await dialog().getByRole('button', { name: '复制到文档资源目录', exact: true }).click(); await resultNotice('已复制到文档资源目录')
  await closeLibrary()
  const copied = await save()
  assert.match(copied, /!\[Inline\]\(main\.assets\/photo%20name\.png\)/)
  assert.match(copied, /!\[Reference\]\(main\.assets\/photo%20name\.png "Sample"\)/)
  assert.match(copied, /src="main\.assets\/photo%20name\.png"/)
  assert.match(copied, /\[ordinary link\]\[photo\]/)
  assert.match(copied, /\[photo\]: photo%20name\.png "Sample"/)
  assert.deepEqual(await readFile(path.join(assets, 'photo name.png')), bytes)
  assert.deepEqual(await readFile(path.join(workspace, 'photo name.png')), bytes)
  await undo(); assert.equal(await save(), original)
  await redo(); assert.equal(await save(), copied)
  console.log('Copy rewrites all image uses, preserves the shared ordinary link, retains the original and participates in document undo/redo.')

  await openLibrary(); await selectImage('photo name.png')
  await dialog().getByLabel('图片文件名', { exact: true }).fill('renamed photo.png')
  await dialog().getByRole('button', { name: '重命名引用', exact: true }).click(); await resultNotice('已将引用更新为 renamed photo.png')
  await closeLibrary()
  const renamed = await save()
  assert.equal((await snapshot(renamed)).items.find((item) => item.name === 'renamed photo.png').references, 3)
  assert.deepEqual(await readFile(path.join(assets, 'renamed photo.png')), bytes)
  assert.deepEqual(await readFile(path.join(assets, 'photo name.png')), bytes)
  await command('toggle-source-mode'); await page.locator('.ProseMirror').waitFor(); await ready()
  await undo(); assert.equal(await save(), copied)
  await command('toggle-source-mode'); await source().waitFor(); await ready()
  await redo(); assert.equal(await save(), renamed)
  console.log('Rename creates an exclusive new resource, retains the previous resource and undo/redo survives a visual/source mode switch.')

  await openLibrary(); await selectImage('renamed photo.png')
  await dialog().getByRole('button', { name: '移除全部图片引用', exact: true }).click(); await resultNotice('已移除 3 处图片引用')
  await closeLibrary()
  const removed = await save()
  assert.match(removed, /Inline/); assert.match(removed, /Reference/); assert.match(removed, /HTML source/)
  assert.equal((await snapshot(removed)).items.some((item) => item.name === 'renamed photo.png'), false)
  assert.match(removed, /\[ordinary link\]\[photo\]/)
  assert.deepEqual(await readFile(path.join(assets, 'renamed photo.png')), bytes)
  await undo(); assert.equal(await save(), renamed)
  await redo(); assert.equal(await save(), removed)
  console.log('Removing references preserves descriptions and files, changes only image uses and is one reversible document action.')

  // The saved sibling is never opened. The unsaved sibling is a separate active tab.
  await open('draft.md'); await source().click(); await source().press('Control+End'); await page.keyboard.insertText('\n![draft](main.assets/draft-protected.png)\n')
  await switchTab('main.md'); await openLibrary(); await dialog().getByRole('tab', { name: /^未使用资源/ }).click()
  assert.equal(await orphanRow('protected.png').filter({ hasNotText: 'draft-protected.png' }).count(), 0)
  assert.equal(await orphanRow('draft-protected.png').count(), 0)
  assert.equal(await orphanRow('renamed photo.png').count(), 1)
  await closeLibrary(); await switchTab('draft.md'); await undo(); await switchTab('main.md')
  await openLibrary(); await dialog().getByRole('tab', { name: /^未使用资源/ }).click()
  assert.equal(await orphanRow('draft-protected.png').count(), 1)
  assert.equal(await orphanRow('protected.png').filter({ hasNotText: 'draft-protected.png' }).count(), 0)
  await orphanRow('renamed photo.png').getByRole('button', { name: '移入恢复区', exact: true }).click(); await resultNotice('移入恢复区')
  await assert.rejects(stat(path.join(assets, 'renamed photo.png')), { code: 'ENOENT' })
  await dialog().getByRole('tab', { name: /^恢复区/ }).click()
  assert.equal(await orphanRow('renamed photo.png').count(), 1)
  await capture('image-library-recovery.png')
  const recoveryFiles = await readdir(path.join(assets, '.ttypora-recovery'))
  assert.ok(recoveryFiles.some((name) => name.endsWith('.asset')))
  assert.ok(recoveryFiles.some((name) => name.endsWith('.json')))
  await orphanRow('renamed photo.png').getByRole('button', { name: '恢复图片', exact: true }).click(); await resultNotice('已恢复 renamed photo.png')
  assert.deepEqual(await readFile(path.join(assets, 'renamed photo.png')), bytes)
  assert.equal(await orphanRow('renamed photo.png').count(), 0)
  await closeLibrary()
  console.log('Unopened saved and unsaved sibling references protect shared assets; a saved orphan can be moved to recovery and restored without changing Markdown.')

  // Invoke the public bridge with malicious requests; no service or IPC handler is stubbed.
  const authorizationFailures = await page.evaluate(async ({ documentPath, outside, outsideImage }) => {
    const reject = async (callback) => { try { await callback(); return 'ACCEPTED' } catch (error) { return String(error) } }
    return [
      await reject(() => window.ttypora.listImages({ documentPath: outside, markdown: '' })),
      await reject(() => window.ttypora.listImages({ documentPath, markdown: '', relatedDocuments: [{ path: outside, markdown: '' }] })),
      await reject(() => window.ttypora.mutateImages({ documentPath, markdown: '', mutation: { action: 'quarantine', path: outsideImage, expectedVersion: { path: outsideImage, size: 1, mtimeMs: 0, sha256: '0'.repeat(64) } } })),
      await reject(() => window.ttypora.mutateImages({ documentPath, markdown: '', mutation: { action: 'restore', recoveryId: '../outside' } })),
    ]
  }, { documentPath, outside, outsideImage })
  assert.ok(authorizationFailures.every((message) => message !== 'ACCEPTED'))
  assert.match(authorizationFailures[0], /未获授权/); assert.match(authorizationFailures[1], /未获授权/)
  const blocked = await snapshot(`![external](<${outsideImage.replace(/\\/g, '/')}> )`)
  assert.equal(blocked.items[0].status, 'blocked'); assert.equal(blocked.items[0].previewUrl, null)
  assert.deepEqual(await readFile(outsideImage), bytes)
  assert.deepEqual(await readFile(path.join(assets, 'protected.png')), bytes)
  console.log('Public IPC rejects unauthorized documents, related buffers, outside assets and invalid recovery identifiers; no external file changes.')

  // A separately opened, authorized document may live outside the workspace.
  // Its buffer protects this workspace's image without extending disk scanning.
  const externalMarkdown = '# External reference\n\n![external](notes/main.assets/audit.png)\n'
  const audit = (await snapshot(removed)).orphans.find((item) => item.name === 'audit.png')
  assert.ok(audit)
  await writeFile(outside, externalMarkdown)
  await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, outside)
  await command('open-document'); await page.waitForFunction(() => document.title.includes('outside.md')); await ready()
  await switchTab('main.md'); await openLibrary(); await dialog().getByRole('tab', { name: /^未使用资源/ }).click()
  assert.equal(await orphanRow('audit.png').count(), 0)
  await closeLibrary()
  const externalProtection = await page.evaluate(async (request) => { try { await window.ttypora.mutateImages(request); return 'ACCEPTED' } catch (error) { return String(error) } }, { documentPath, markdown: removed, relatedDocuments: [{ path: outside, markdown: externalMarkdown }], mutation: { action: 'quarantine', path: audit.path, expectedVersion: audit.version } })
  assert.match(externalProtection, /仍被文档引用/)
  assert.deepEqual(await readFile(audit.path), bytes)
  console.log('An authorized document outside the workspace keeps image management usable and protects assets referenced by its live buffer.')

  await cycleAppearance(page); await cycleAppearance(page)
  await openLibrary(); await selectImage('missing.png')
  const darkTitle = await page.evaluate(() => ({ title: getComputedStyle(document.querySelector('.modal__header h2')).color, content: getComputedStyle(document.querySelector('.image-library')).color }))
  assert.equal(darkTitle.title, darkTitle.content, 'Dark image-library title must use the readable theme text color.')
  await capture('image-library-dark.png')
  // Exercise the responsive layout below the normal desktop window minimum.
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(640, 560); window.setSize(680, 650) })
  await page.waitForFunction(() => innerWidth <= 680)
  await page.waitForFunction(() => { const library = document.querySelector('.image-library'), rect = library.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && library.scrollWidth <= library.clientWidth })
  const compactBounds = await page.evaluate(() => { const library = document.querySelector('.image-library'), rect = library.getBoundingClientRect(); return { left: rect.left, right: rect.right, viewport: innerWidth, scrollWidth: library.scrollWidth, clientWidth: library.clientWidth } })
  assert.ok(compactBounds.left >= 0 && compactBounds.right <= compactBounds.viewport && compactBounds.scrollWidth <= compactBounds.clientWidth)
  await capture('image-library-compact.png')
  await closeLibrary(); assert.equal(await readFile(documentPath, 'utf8'), removed)
  assert.deepEqual(pageErrors, [])
  console.log(`Image library desktop acceptance passed (${packaged ? 'packaged' : 'source'}).`)
} catch (error) {
  if (page && !page.isClosed()) { console.error(await page.locator('body').innerText().catch(() => 'unavailable')); await page.screenshot({ path: path.join(artifacts, 'image-library-failure.png') }).catch(() => undefined) }
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
