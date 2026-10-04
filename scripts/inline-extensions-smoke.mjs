import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-inline-'))
const workspace = path.join(temporary, 'notes'), artifacts = path.join(root, 'artifacts')
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
const note = path.join(workspace, 'inline.md')
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
await mkdir(path.join(workspace, 'Inline 图片.assets')); await writeFile(path.join(workspace, 'Inline 图片.assets', 'pixel.png'), pixel); await writeFile(path.join(temporary, 'private.png'), pixel)
const original = '# Inline 扩展\n\n==高亮== and **bold**.\n\nH~2~O + x^2^.\n\n<u>underline</u> :smile: :+1: :cn:.\n\n`==literal== ^2^ ~2~ :smile:`\n\n<figure><img src="Inline 图片.assets/pixel.png" srcset="../private.png 2x" alt="HTML local"><img src="../private.png" alt="HTML blocked"><figcaption>保留 HTML 图片</figcaption></figure>\n\nEnd.\n'
await writeFile(note, original)
let app, page
const errors = []
try {
  const packaged = process.env.TTYPORA_PACKAGED_EXE
  app = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: packaged ? ['--disable-gpu'] : ['--disable-gpu', '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await app.firstWindow(); page.on('pageerror', (error) => { errors.push(String(error)); console.error(error.stack) })
  const command = (value) => app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', command), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const visual = () => page.locator('.ProseMirror'), source = () => page.locator('.source-editor .cm-content')
  const selected = () => page.evaluate(() => window.getSelection()?.toString())
  const save = async () => { await command('save-document'); await page.waitForFunction(() => !document.title.startsWith('●')) }
  await ready(); await command('open-workspace'); await page.locator('.file-tree').getByTitle(note, { exact: true }).click(); await ready()
  await visual().locator('mark').first().waitFor()
  assert.equal(await visual().locator('mark').innerText(), '高亮')
  assert.equal(await visual().locator('sub').innerText(), '2')
  assert.equal(await visual().locator('sup').innerText(), '2')
  assert.equal(await visual().locator('u').innerText(), 'underline')
  assert.equal(await visual().locator('[data-emoji]').count(), 3)
  assert.match(await visual().locator('code').innerText(), /==literal== \^2\^ ~2~ :smile:/)
  const localImageUrl = await page.evaluate((snapshot) => window.ttypora.resolveImageUrl(snapshot, 'Inline 图片.assets/pixel.png'), { documentPath: note, markdown: original })
  assert.equal(fileURLToPath(localImageUrl), await realpath(path.join(workspace, 'Inline 图片.assets', 'pixel.png')))
  assert.ok(new URL(localImageUrl).searchParams.get('ttypora-version'))
  await page.waitForFunction((url) => {
    const image = document.querySelector('.ProseMirror img[alt="HTML local"]')
    return image?.src === url && image.currentSrc === url && image.complete && image.naturalWidth === 1 && image.naturalHeight === 1
  }, localImageUrl)
  assert.equal(await visual().locator('img[alt="HTML local"]').getAttribute('src'), localImageUrl)
  assert.equal(await visual().locator('img[alt="HTML local"]').getAttribute('srcset'), null)
  await visual().locator('img[alt="HTML blocked"][data-image-error]').waitFor()
  assert.equal(await visual().locator('img[alt="HTML blocked"]').getAttribute('src'), null)
  await save(); assert.equal(await readFile(note, 'utf8'), original)
  console.log('Visual inline marks and shortcode emoji render; opening/saving retains exact source.')

  await visual().locator('mark').click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight')
  assert.equal(await selected(), '高亮')
  await command('toggle-source-mode'); await source().waitFor(); await ready(); assert.equal(await selected(), '高亮')
  await command('toggle-source-mode'); await visual().waitFor(); await ready(); assert.equal(await selected(), '高亮')
  await page.keyboard.insertText('新版'); await save()
  assert.match(await readFile(note, 'utf8'), /==新版==/)
  assert.match(await readFile(note, 'utf8'), /H~2~O \+ x\^2\^/)
  assert.match(await readFile(note, 'utf8'), /<u>underline<\/u> :smile: :\+1: :cn:/)
  await command('undo-document'); await page.waitForFunction(() => document.querySelector('.ProseMirror mark')?.textContent === '高亮'); await save(); await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('已保存')); assert.equal(await readFile(note, 'utf8'), original)
  console.log('Selection maps across views; editing preserves extension serialization and undo restores exact raw source.')

  await visual().locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.press('Enter')
  await page.keyboard.type(':smi', { delay: 70 })
  await page.getByRole('listbox', { name: 'Emoji 自动补全' }).waitFor({ state: 'visible' })
  await page.keyboard.press('Enter')
  await visual().locator('[data-emoji="smile"]').last().waitFor()
  await command('toggle-source-mode'); await source().waitFor(); await ready()
  assert.match(await source().innerText(), /:smile:/)
  await source().click(); await source().press('Control+End'); await page.keyboard.press('Enter')
  await page.keyboard.type(':thumbs', { delay: 70 })
  await page.locator('.cm-tooltip-autocomplete').waitFor({ state: 'visible' })
  // CodeMirror deliberately delays keyboard acceptance while its suggestion list updates.
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await save(); assert.match(await readFile(note, 'utf8'), /:thumbsup:/)
  await command('toggle-source-mode'); await visual().waitFor(); await ready()
  assert.equal(await visual().locator('[data-emoji="thumbsup"]').count(), 1)
  console.log('Keyboard Emoji completions work in visual and source views and serialize as shortcodes.')

  await visual().locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.insertText(' 最新输入')
  const beforePreferences = await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent)
  await command('preferences'); await page.getByLabel('高亮', { exact: true }).uncheck(); await ready()
  assert.equal(await visual().locator('mark').count(), 0)
  assert.match(await visual().innerText(), /==高亮==/)
  assert.match(await visual().innerText(), /最新输入/)
  await page.getByLabel('高亮', { exact: true }).check(); await ready()
  assert.equal(await visual().locator('mark').count(), 1)
  assert.equal(await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent), beforePreferences)
  await page.getByRole('button', { name: '完成', exact: true }).click(); await save()
  console.log('Extension preference remounts retain unsaved content and restore visual interpretation.')

  for (const [syntax, tag, expected] of [['==typed==', 'mark', 'typed'], ['^hello\\ world^', 'sup', 'hello world'], ['~2~', 'sub', '2'], ['<u>typed underline</u>', 'u', 'typed underline']]) {
    await visual().locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type(syntax, { delay: 30 })
    await visual().locator('p').last().locator(tag).waitFor(); assert.equal(await visual().locator('p').last().locator(tag).innerText(), expected)
  }
  for (const [format, tag] of [['highlight', 'mark'], ['superscript', 'sup'], ['subscript', 'sub'], ['underline', 'u']]) {
    await visual().locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('format'); await page.keyboard.press('Home'); for (let index = 0; index < 6; index++) await page.keyboard.press('Shift+ArrowRight')
    console.log('Format selection:', format, await selected())
    await page.waitForFunction(() => window.getSelection()?.toString() === 'format')
    await command(`format-${format}`); await visual().locator('p').last().locator(tag).waitFor(); assert.equal(await visual().locator('p').last().locator(tag).innerText(), 'format')
  }
  await save()
  console.log('Visual typed syntax and all four native format commands apply the correct marks.')

  await command('toggle-split-mode'); await page.locator('.editor-panes--split').waitFor(); await ready()
  const preview = page.frameLocator('iframe[title="Markdown 实时预览"]')
  await preview.locator('mark').first().waitFor(); assert.equal(await preview.locator('sub').first().innerText(), '2'); assert.equal(await preview.locator('sup').first().innerText(), '2')
  const previewImage = preview.getByRole('img', { name: 'HTML local', exact: true })
  assert.equal(await previewImage.getAttribute('src'), localImageUrl)
  await page.waitForFunction((url) => {
    const image = document.querySelector('iframe[title="Markdown 实时预览"]')?.contentDocument?.querySelector('img[alt="HTML local"]')
    return image?.src === url && image.currentSrc === url && image.complete && image.naturalWidth === 1 && image.naturalHeight === 1
  }, localImageUrl)
  assert.equal(await previewImage.isVisible(), true)
  assert.equal(await previewImage.getAttribute('srcset'), null)
  const blockedPreview = preview.locator('.image-reference-placeholder[data-image-source="../private.png"]')
  await blockedPreview.waitFor()
  assert.match(await blockedPreview.innerText(), /HTML blocked · 图片引用：\.\.\/private\.png/)
  assert.equal(await preview.locator('img[alt="HTML blocked"]').count(), 0)
  assert.equal(await preview.locator('img[src*="private.png"], img[srcset]').count(), 0)
  const destination = path.join(artifacts, 'inline-export.html')
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, destination)
  await command('export-html'); await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('inline-export.html'))
  const html = await readFile(destination, 'utf8')
  for (const expected of ['<mark>高亮</mark>', '<sub>2</sub>', '<sup>2</sup>', '<u>underline</u>', '😄', '👍', '🇨🇳']) assert.ok(html.includes(expected), `HTML lost ${expected}`)
  // Export remains self-contained even though the live preview uses authorized file URLs.
  const exportedImage = html.match(/<img\b[^>]*\balt="HTML local"[^>]*>/)?.[0] ?? ''
  assert.ok(exportedImage.includes(`src="data:image/png;base64,${pixel.toString('base64')}"`))
  assert.doesNotMatch(html, /<img\b[^>]*\balt="HTML blocked"/)
  assert.match(html, /<span\b[^>]*class="image-reference-placeholder"[^>]*data-image-source="\.\.\/private\.png"[^>]*>/)
  assert.doesNotMatch(html, /<img\b[^>]*(?:src|srcset)="[^">]*private\.png/)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(artifacts, 'inline-extensions.png') })
  console.log('Inline extensions smoke passed: rendering, serialization, selection, history, completions, toggles, live preview and HTML export.')
} catch (error) {
  if (page && !page.isClosed()) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: path.join(artifacts, 'inline-failure.png') }).catch(() => undefined) }
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (app) await app.close().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
