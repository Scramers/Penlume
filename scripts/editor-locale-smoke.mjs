import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-editor-locale-'))
const workspace = path.join(temporary, 'notes'), artifacts = path.join(root, 'artifacts')
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
const note = path.join(workspace, '中文文件名.md')
const original = '# 用户中文标题\n\nAlpha text remains unchanged.\n\n![用户图片替代描述](pixel.png "用户图片说明")\n\n![]()\n\n```mermaid\ngraph LR\n A-->B\n```\n\n<audio src="https://example.invalid/remote.mp3"></audio>\n\nTail.\n'
await writeFile(note, original)
await writeFile(path.join(workspace, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
let application, page
const errors = []
const consoleMessages = [], imageRequests = []
const inspectImages = async (phase) => {
  if (!page || page.isClosed()) return
  const state = await page.evaluate(async (snapshot) => {
    const nodes = []
    document.querySelector('.ProseMirror')?.pmViewDesc?.node.descendants((node) => { if (node.type.name === 'image-block') nodes.push(node.attrs) })
    let resolved
    try { resolved = { url: await window.ttypora.resolveImageUrl(snapshot, 'pixel.png') } } catch (error) { resolved = { error: String(error) } }
    return {
      title: document.title, nodes, resolved,
      images: [...document.querySelectorAll('.milkdown-image-block img')].map((image) => ({ src: image.getAttribute('src'), currentSrc: image.currentSrc, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, box: image.getBoundingClientRect().toJSON(), height: image.dataset.height, origin: image.dataset.origin, style: image.getAttribute('style'), alt: image.alt })),
      imageBlocks: [...document.querySelectorAll('.milkdown-image-block')].map((block) => ({ text: block.textContent, html: block.innerHTML })),
    }
  }, { documentPath: note, markdown: await readFile(note, 'utf8') })
  console.log(`Image diagnostics ${phase}: ${JSON.stringify({ ...state, consoleMessages: consoleMessages.slice(-20), imageRequests: imageRequests.slice(-20) })}`)
}
try {
  const packaged = process.env.TTYPORA_PACKAGED_EXE
  application = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: packaged ? ['--disable-gpu'] : ['--disable-gpu', '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.on('pageerror', (error) => { errors.push(String(error)); console.error(error.stack) })
  page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') consoleMessages.push({ type: message.type(), text: message.text() }) })
  page.on('request', (request) => { if (/pixel\.png/i.test(request.url())) imageRequests.push({ type: 'request', url: request.url() }) })
  page.on('requestfailed', (request) => { if (/pixel\.png/i.test(request.url())) imageRequests.push({ type: 'failed', url: request.url(), failure: request.failure() }) })
  const command = (value) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror').waitFor() }
  const save = async () => {
    await page.evaluate(() => {
      window.__localeSaveReceived = false
      const remove = window.ttypora.onAppCommand((value) => { if (value === 'save-document') { window.__localeSaveReceived = true; remove() } })
    })
    await command('save-document')
    await page.waitForFunction(() => window.__localeSaveReceived)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForFunction(() => !document.title.startsWith('●') && /已保存：|文档没有需要保存的修改|Saved:|No document changes to save/.test(document.querySelector('.statusbar')?.textContent ?? ''))
    return readFile(note, 'utf8')
  }
  const model = () => page.evaluate(() => JSON.stringify(document.querySelector('.ProseMirror').pmViewDesc.node.toJSON()))
  const waitModel = (expected) => page.waitForFunction((expected) => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()) === expected, expected)
  const waitImageRatio = (expected) => page.waitForFunction((expected) => {
    let ratio
    document.querySelector('.ProseMirror')?.pmViewDesc?.node.descendants((node) => { if (node.type.name === 'image-block' && node.attrs.src === 'pixel.png') ratio = node.attrs.ratio })
    return ratio === expected
  }, expected)
  const switchLanguage = async (locale) => {
    await command('preferences')
    await page.locator('.preferences fieldset').first().locator('select').selectOption(locale)
    await page.waitForFunction((locale) => document.documentElement.lang === locale, locale)
    await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'Done' : '完成', exact: true }).click()
  }
  const rememberDom = () => page.evaluate(() => {
    const prose = document.querySelector('.ProseMirror')
    window.__localeProse = prose; window.__localeDoc = prose.pmViewDesc?.node
    window.__localeCode = prose.querySelector('.cm-editor'); window.__localeParagraph = [...prose.querySelectorAll('p')].find((p) => p.textContent.startsWith('Alpha'))
  })
  const assertDom = async () => assert.equal(await page.evaluate(() => document.querySelector('.ProseMirror') === window.__localeProse && window.__localeCode?.isConnected && window.__localeParagraph?.isConnected && document.querySelector('.ProseMirror').pmViewDesc?.node === window.__localeDoc), true)
  await ready(); await command('open-workspace')
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 160
    const context = canvas.getContext('2d'); context.fillStyle = '#3270aa'; context.fillRect(0, 0, 400, 160)
    context.fillStyle = '#a7d4ef'; context.fillRect(30, 30, 340, 100)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await writeFile(path.join(workspace, 'pixel.png'), Buffer.from(imageData, 'base64'))
  await page.locator('.file-tree').getByTitle(note, { exact: true }).click(); await ready()
  await page.locator('.milkdown-code-block .preview svg').waitFor()
  await page.locator('.milkdown-image-block .uploader').waitFor()
  const nativeImage = page.locator('.milkdown-image-block img[data-type="image-block"]')
  await nativeImage.waitFor()
  assert.equal(await nativeImage.getAttribute('alt'), '用户图片替代描述')
  assert.equal(await nativeImage.getAttribute('title'), '用户图片说明')
  const originalModel = await model()
  assert.equal(await save(), original)
  await page.locator('.ProseMirror p').filter({ hasText: /^Tail\.$/ }).click(); await page.keyboard.press('End'); await page.keyboard.press('Enter')
  await page.locator('[data-placeholder="开始写作…"]').waitFor()
  const baseline = await save(), baselineModel = await model()
  assert.notEqual(baseline, original)
  assert.ok(baseline.includes('![用户图片替代描述](pixel.png "用户图片说明")'))
  console.log(`Saved baseline before language switch: ${JSON.stringify({ bytes: Buffer.byteLength(baseline), modelChanged: baselineModel !== originalModel, imageLiteralPresent: baseline.includes('用户图片说明') })}`)
  await rememberDom(); await switchLanguage('en')
  await page.locator('[data-placeholder="Start writing…"]').waitFor()
  await page.locator('.milkdown-image-block').getByText('Or paste an image link', { exact: true }).waitFor()
  await page.locator('.milkdown-image-block').getByText('Choose image', { exact: true }).waitFor()
  await page.locator('.milkdown-code-block .preview-label').filter({ hasText: 'Diagram preview' }).waitFor()
  await page.locator('.milkdown-code-block .preview-toggle-button').filter({ hasText: 'Hide source' }).waitFor()
  await page.locator('.media-card__load').filter({ hasText: 'Load remote media' }).waitFor()
  assert.equal(await page.locator('[data-html-source-editor]').getAttribute('aria-label'), 'HTML source')
  await assertDom(); assert.equal(await model(), baselineModel); assert.equal(await save(), baseline)
  assert.equal(await nativeImage.getAttribute('alt'), '用户图片替代描述')
  assert.equal(await nativeImage.getAttribute('title'), '用户图片说明')
  assert.equal(await page.locator('.ProseMirror h1').innerText(), '用户中文标题')
  await command('undo-document'); await waitModel(originalModel); assert.equal(await save(), original)
  await command('redo-document'); await page.waitForFunction(() => document.title.startsWith('●')); assert.equal(await save(), baseline)
  // Parsing Markdown restores its exact bytes, while a terminal empty visual
  // paragraph is represented by trailing newlines rather than an AST node.
  const restoredModel = await model()
  console.log('English editor configuration updates existing placeholder, image uploader, Mermaid and media labels without replacing the document or adding an undo step.')

  await page.locator('.ProseMirror p').filter({ hasText: /^Alpha text/ }).click(); await page.keyboard.press('Home')
  for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowRight')
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'Alpha')
  await rememberDom(); await switchLanguage('zh-CN'); await assertDom()
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'Alpha')
  await page.locator('.milkdown-image-block').getByText('或粘贴图片链接', { exact: true }).waitFor()
  await page.locator('.milkdown-code-block .preview-label').filter({ hasText: '图表预览' }).waitFor()
  assert.equal(await model(), restoredModel); assert.equal(await save(), baseline)
  await switchLanguage('en')
  await page.locator('.ProseMirror p').last().click(); await page.keyboard.press('End'); await page.keyboard.type(':smi', { delay: 70 })
  await page.getByRole('listbox', { name: 'Emoji completion' }).waitFor({ state: 'visible' })
  await page.keyboard.press('Escape'); await command('undo-document')
  await page.waitForFunction(() => !document.title.startsWith('●')); assert.equal(await save(), baseline)

  await nativeImage.scrollIntoViewIfNeeded()
  await page.waitForFunction(() => {
    const image = document.querySelector('.milkdown-image-block img[data-type="image-block"]')
    return image?.complete && image.naturalWidth === 400 && Number(image.dataset.origin) > 0
  })
  await nativeImage.hover()
  const handle = nativeImage.locator('..').locator('.image-resize-handle'), handleBox = await handle.boundingBox(), imageBox = await nativeImage.boundingBox()
  assert.ok(handleBox && imageBox)
  const originHeight = await nativeImage.evaluate((image) => Number(image.dataset.origin))
  const beforeHandleModel = await model()
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down(); await page.mouse.up()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await model(), beforeHandleModel); assert.equal(await save(), baseline)
  await nativeImage.hover()
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down(); await page.mouse.move(handleBox.x + handleBox.width / 2, imageBox.y + originHeight * 1.25, { steps: 8 }); await page.mouse.up()
  await waitImageRatio(1.25)
  const nativeImageWidth = await nativeImage.evaluate((image) => image.getBoundingClientRect().width)
  assert.ok(Math.abs(nativeImageWidth - 500) <= 1)
  const resized = await save()
  assert.ok(resized.includes('<img src="pixel.png" alt="用户图片替代描述" title="用户图片说明" width="500" data-ttypora-ratio="1.25">'))
  const exportPath = path.join(artifacts, 'editor-locale-image-export.html')
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, exportPath)
  await command('export-html'); await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('editor-locale-image-export.html'))
  assert.match(await readFile(exportPath, 'utf8'), /<img[^>]+alt="用户图片替代描述"[^>]+width="500"/)
  const exportImageWidth = await application.evaluate(async ({ BrowserWindow }, filePath) => {
    const preview = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try {
      await preview.loadFile(filePath)
      return await preview.webContents.executeJavaScript('(async () => { const image = document.querySelector(\'img[alt="用户图片替代描述"]\'); await image.decode(); return image.getBoundingClientRect().width })()')
    } finally { preview.destroy() }
  }, exportPath)
  assert.ok(Math.abs(exportImageWidth - nativeImageWidth) <= 1)
  await command('toggle-source-mode'); await page.locator('.source-editor .cm-content').waitFor()
  assert.equal(await page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString()), resized)
  await command('toggle-source-mode'); await ready(); await waitImageRatio(1.25); await nativeImage.waitFor()
  assert.equal(await nativeImage.getAttribute('alt'), '用户图片替代描述'); assert.equal(await nativeImage.getAttribute('title'), '用户图片说明')
  await command('undo-document'); await waitImageRatio(1); assert.equal(await save(), baseline)
  await command('redo-document'); await waitImageRatio(1.25); assert.equal(await save(), resized)
  await command('close-document'); await nativeImage.waitFor({ state: 'detached' })
  const replacementImage = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 320
    const context = canvas.getContext('2d'); context.fillStyle = '#2e866c'; context.fillRect(0, 0, 800, 320)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await writeFile(path.join(workspace, 'pixel.png'), Buffer.from(replacementImage, 'base64'))
  await page.locator('.file-tree').getByTitle(note, { exact: true }).click(); await ready(); await waitImageRatio(1.25); await nativeImage.waitFor()
  await inspectImages('reopened after intrinsic size replacement')
  await page.waitForFunction(() => {
    const image = document.querySelector('.milkdown-image-block img[data-type="image-block"]')
    return image?.complete && image.naturalWidth === 800 && Math.abs(image.getBoundingClientRect().width - 500) <= 1
  })
  assert.equal(await nativeImage.getAttribute('alt'), '用户图片替代描述'); assert.equal(await nativeImage.getAttribute('title'), '用户图片说明')
  assert.equal(await save(), resized)
  console.log(`Native pointer resize preserves literal alt/title and exact undo/redo Markdown; native/export widths are ${nativeImageWidth}/${exportImageWidth}px. Replacing the same-path image with 800×320 retains 500px on reopening without Markdown changes.`)
  assert.deepEqual(errors, [])
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  await page.screenshot({ path: path.join(artifacts, 'editor-locale.png'), animations: 'disabled', timeout: 60000 })
  await writeFile(path.join(artifacts, 'editor-locale-verification.json'), JSON.stringify({ variant: packaged ? 'packaged' : 'source', documentDomRetained: true, documentNodeRetained: true, codeMirrorRetained: true, literalContentRetained: true, imageAltTitleRetained: true, imageNativeResizeRatio: 1.25, nativeImageWidthPixels: nativeImageWidth, exportImageWidthPixels: exportImageWidth, imageResizeHandleClickUnchanged: true, imageResizeSourceRoundTrip: true, imageResizeUndoRedo: true, imageResizeReopened: true, imageSizeChangedRetainsPixelWidth: true, selectionRetained: true, unifiedHistoryRetained: true, imageUploaderLocalized: true, mermaidLocalized: true, emojiLocalized: true, pageErrors: errors }, null, 2))
  console.log('Switching back preserves the text selection and literal Chinese content; Emoji completion uses the active locale. No page errors.')
} catch (error) {
  if (page && !page.isClosed()) { await inspectImages('failure').catch((diagnosticError) => console.error(String(diagnosticError))); console.error(await page.locator('body').innerText().catch(() => 'unavailable')); await page.screenshot({ path: path.join(artifacts, 'editor-locale-failure.png'), timeout: 60000 }).catch(() => undefined) }
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
