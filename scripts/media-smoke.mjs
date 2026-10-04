import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-media-smoke-'))
const workspace = path.join(temporary, 'notes'), artifacts = path.join(root, 'artifacts')
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
const rate = 8000, samples = rate, wave = Buffer.alloc(44 + samples * 2)
wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 2, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40)
for (let i = 0; i < samples; i++) wave.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 220 / rate) * 1500), 44 + i * 2)
const note = path.join(workspace, '媒体笔记.md'), tone = path.join(workspace, 'tone.wav')
await writeFile(tone, wave)
await writeFile(path.join(workspace, 'cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
await writeFile(path.join(temporary, 'private.wav'), wave)
await writeFile(path.join(temporary, 'outside-style.png'), await readFile(path.join(workspace, 'cover.png')))
const forbiddenStyleUrl = pathToFileURL(path.join(temporary, 'outside-style.png')).href
const original = `# 声音与画面\n\nPlacement paragraph.\n\n<audio controls src="tone.wav" autoplay onplay="window.__mediaInjected=true"></audio>\n\n<video controls poster="cover.png"><source src="clip.webm" type="video/webm"></video>\n\n<audio src="https://example.invalid/remote.mp3" autoplay></audio>\n\n<audio src="../private.wav"></audio>\n\n<div style="background-image: url('${forbiddenStyleUrl}')">Style stays in source</div>\n\n![Blocked image](../outside-style.png)\n`
const copiedSource = `${encodeURIComponent('媒体笔记.assets')}/tone.wav`
await writeFile(note, original)
let application, page
const errors = [], requests = []
try {
  const packaged = process.env.TTYPORA_PACKAGED_EXE
  const flags = ['--disable-gpu', '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  application = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: packaged ? flags : [...flags, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.on('pageerror', (error) => errors.push(String(error)))
  page.on('request', (request) => { if (/example\.invalid|outside-style\.png/.test(request.url())) requests.push(request.url()) })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const command = (value) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const modelReference = (reference, present = true) => page.waitForFunction(({ reference, present }) => {
    const document = window.document.querySelector('.ProseMirror')?.pmViewDesc?.node
    return Boolean(document && JSON.stringify(document.toJSON()).includes(reference) === present)
  }, { reference, present })
  const currentMarkdown = async (label) => {
    await command('toggle-source-mode'); await ready()
    const markdown = await page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString())
    console.log(`${label}: ${JSON.stringify({ length: markdown.length, placement: markdown.indexOf('Placement paragraph.'), tone: markdown.indexOf('/tone-1.wav'), pastedAudio: markdown.indexOf('pasted.wav'), pastedImage: markdown.indexOf('pasted.png'), dropped: markdown.indexOf('dropped.wav') })}`)
    await command('toggle-source-mode'); await ready()
    return markdown
  }
  const placeCaret = async (element, end) => {
    await element.scrollIntoViewIfNeeded()
    await element.evaluate((paragraph, end) => {
      paragraph.closest('.ProseMirror').focus()
      const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(!end)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }, end)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await element.evaluate((paragraph, end) => {
      const selection = window.getSelection()
      if (!selection?.isCollapsed || !paragraph.contains(selection.anchorNode)) return false
      const range = document.createRange(); range.selectNodeContents(paragraph); range.setEnd(selection.anchorNode, selection.anchorOffset)
      return range.toString().length === (end ? paragraph.textContent.length : 0)
    }, end), true, end ? 'Caret must be at the full paragraph end' : 'Caret must be at the full paragraph start')
  }
  await ready(); await command('open-workspace'); await page.locator('.file-tree').getByTitle(note, { exact: true }).click(); await ready()
  const webm = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
    const context = canvas.getContext('2d'); context.fillStyle = '#3173a2'; context.fillRect(0, 0, 160, 90)
    const stream = canvas.captureStream(10), chunks = []
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
    const stopped = new Promise((resolve) => { recorder.ondataavailable = (event) => chunks.push(event.data); recorder.onstop = resolve })
    recorder.start(); await new Promise((resolve) => setTimeout(resolve, 350)); recorder.stop(); await stopped
    stream.getTracks().forEach((track) => track.stop())
    return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()))
  })
  await writeFile(path.join(workspace, 'clip.webm'), Buffer.from(webm))
  // Reopen the document through source mode so media generation invalidates the previous missing source.
  await command('toggle-source-mode'); await ready(); await command('toggle-source-mode'); await ready()
  await page.waitForFunction(() => document.querySelector('.html-block audio[src^="file:"]') && document.querySelector('.html-block video source[src^="file:"]'))
  const audio = page.locator('.html-block audio[src^="file:"]').first()
  assert.equal(await audio.getAttribute('preload'), 'none'); assert.equal(await audio.getAttribute('autoplay'), null)
  assert.equal(await audio.getAttribute('onplay'), null); assert.equal(await page.evaluate(() => window.__mediaInjected), undefined)
  assert.equal(await audio.evaluate((node) => node.paused), true)
  await audio.evaluate(async (node) => { node.load(); await node.play(); node.pause() })
  assert.equal(await audio.evaluate((node) => node.duration), 1)
  const video = page.locator('.html-block video').first()
  await video.evaluate(async (node) => { node.load(); await node.play(); node.pause() })
  assert.ok(await video.evaluate((node) => node.videoWidth) > 0)
  assert.ok((await video.getAttribute('poster')).startsWith('file:'))
  assert.deepEqual(requests, []); assert.equal(await readFile(note, 'utf8'), original)
  const rejected = await page.evaluate(async (snapshot) => { try { await window.ttypora.resolveMediaUrl(snapshot, '../private.wav'); return false } catch { return true } }, { documentPath: note, markdown: original })
  assert.equal(rejected, true)
  console.log('Authorized WAV and generated WebM play on explicit action; events/autoplay/out-of-root resources are blocked and remote media stays unloaded.')

  await command('toggle-source-mode'); await ready()
  const source = page.locator('.source-editor .cm-content'); await source.click(); await page.keyboard.press('Control+End')
  await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, tone)
  await command('insert-media')
  await page.waitForFunction((url) => document.querySelector('.source-editor')?.textContent?.includes(url), copiedSource)
  const draft = await page.evaluate(async () => (await window.ttypora.listRecoveryDrafts()).find((item) => item.displayName === '媒体笔记.md')?.markdown)
  await command('undo-document'); await page.waitForFunction((url) => !document.querySelector('.source-editor')?.textContent?.includes(url), copiedSource)
  await command('redo-document'); await page.waitForFunction((url) => document.querySelector('.source-editor')?.textContent?.includes(url), copiedSource)
  assert.deepEqual(await readFile(path.join(workspace, '媒体笔记.assets', 'tone.wav')), wave)
  assert.deepEqual(await readFile(tone), wave)
  await command('toggle-split-mode'); await ready()
  const preview = page.frameLocator('.live-preview iframe')
  await preview.locator('audio[src^="file:"]').first().waitFor()
  assert.equal(await preview.locator('audio').first().getAttribute('autoplay'), null)
  await command('toggle-source-mode'); await ready()
  const placement = page.locator('.ProseMirror p').filter({ hasText: /^Placement paragraph\.$/ })
  const beforeVisualInsert = await currentMarkdown('Before visual menu insertion')
  await placeCaret(placement, false); await command('insert-media')
  const secondSource = `${encodeURIComponent('媒体笔记.assets')}/tone-1.wav`
  await modelReference(secondSource)
  let visualMarkdown = await currentMarkdown('After visual menu insertion')
  assert.ok(visualMarkdown.indexOf(secondSource) < visualMarkdown.indexOf('Placement paragraph.'))
  await command('undo-document'); await modelReference(secondSource, false)
  assert.equal(await currentMarkdown('After visual insertion undo'), beforeVisualInsert)
  await command('redo-document'); await modelReference(secondSource)
  assert.equal(await currentMarkdown('After visual insertion redo'), visualMarkdown)
  assert.deepEqual(await readFile(path.join(workspace, '媒体笔记.assets', 'tone-1.wav')), wave)

  const beforePaste = visualMarkdown
  await placeCaret(placement, true)
  const imageBytes = Array.from(await readFile(path.join(workspace, 'cover.png')))
  await page.evaluate(({ audio, image }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(audio)], 'pasted.wav', { type: 'audio/wav' }))
    transfer.items.add(new File([new Uint8Array(image)], 'pasted.png', { type: 'image/png' }))
    document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, { audio: Array.from(wave), image: imageBytes })
  await modelReference('pasted.wav'); await modelReference('pasted.png')
  visualMarkdown = await currentMarkdown('After mixed paste')
  assert.ok(visualMarkdown.indexOf('pasted.wav') > visualMarkdown.indexOf('Placement paragraph.'))
  assert.deepEqual(await readFile(path.join(workspace, '媒体笔记.assets', 'pasted.wav')), wave)
  assert.deepEqual(await readFile(path.join(workspace, '媒体笔记.assets', 'pasted.png')), Buffer.from(imageBytes))
  await command('undo-document'); await modelReference('pasted.wav', false); await modelReference('pasted.png', false)
  assert.equal(await currentMarkdown('After mixed paste undo'), beforePaste)
  await command('redo-document'); await modelReference('pasted.wav'); await modelReference('pasted.png')
  assert.equal(await currentMarkdown('After mixed paste redo'), visualMarkdown)

  await placement.scrollIntoViewIfNeeded()
  const box = await placement.boundingBox()
  assert.ok(box)
  await placement.evaluate((element, { audio, x, y }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(audio)], 'dropped.wav', { type: 'audio/wav' }))
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: x, clientY: y }))
  }, { audio: Array.from(wave), x: box.x + 2, y: box.y + box.height / 2 })
  const beforeDrop = visualMarkdown
  await modelReference('dropped.wav')
  visualMarkdown = await currentMarkdown('After coordinate drop')
  assert.ok(visualMarkdown.indexOf('dropped.wav') < visualMarkdown.indexOf('Placement paragraph.'))
  assert.deepEqual(await readFile(path.join(workspace, '媒体笔记.assets', 'dropped.wav')), wave)
  await command('undo-document'); await modelReference('dropped.wav', false)
  assert.equal(await currentMarkdown('After drop undo'), beforeDrop)
  await command('redo-document'); await modelReference('dropped.wav')
  assert.equal(await currentMarkdown('After drop redo'), visualMarkdown)
  assert.deepEqual(await readFile(tone), wave)
  console.log('Visual menu insertion, mixed image/audio paste and coordinate-based drop all copy real bytes at the current position and undo/redo as complete transactions.')
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  await page.screenshot({ path: path.join(artifacts, 'media-writing.png'), animations: 'disabled', timeout: 60000 })

  const htmlPath = path.join(artifacts, 'media-export.html'), pdfPath = path.join(artifacts, 'media-export.pdf')
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, htmlPath)
  await command('export-html'); await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('media-export.html'))
  const html = await readFile(htmlPath, 'utf8')
  assert.match(html, /data:audio\/wav;base64,/); assert.match(html, /data:video\/webm;base64,/)
  assert.doesNotMatch(html, /\bautoplay\b|\bonplay\s*=/); assert.doesNotMatch(html, /src="https:\/\/example\.invalid\/remote/)
  assert.match(html, /media-reference-placeholder/)
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, pdfPath)
  await command('export-pdf'); await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('media-export.pdf'))
  assert.equal((await readFile(pdfPath)).subarray(0, 4).toString(), '%PDF')
  assert.equal(await readFile(note, 'utf8'), original); assert.deepEqual(errors, [])
  assert.deepEqual(requests, [])
  await writeFile(path.join(artifacts, 'media-verification.json'), JSON.stringify({ variant: packaged ? 'packaged' : 'source', audioSeconds: 1, generatedVideoBytes: webm.length, nativeInsertUndoRedo: true, visualInsertUndoRedo: true, mixedPasteUndoRedo: true, coordinateDropUndoRedo: true, splitPreview: true, htmlEmbedding: true, pdf: true, remoteRequests: requests, pageErrors: errors, draftAvailable: Boolean(draft) }, null, 2))
  console.log('Media insertion copies originals, participates in undo/redo, appears in split preview and exports portable HTML/print PDF.')
} catch (error) {
  if (page && !page.isClosed()) { console.error(await page.locator('body').innerText().catch(() => 'unavailable')); await page.screenshot({ path: path.join(artifacts, 'media-failure.png'), timeout: 60000 }).catch(() => undefined) }
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
