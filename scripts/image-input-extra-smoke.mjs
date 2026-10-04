import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { _electron as electron } from 'playwright'

// Prepared only; run serially after the product merge/build and other GUI runs.
let root = path.dirname(fileURLToPath(import.meta.url))
while (!existsSync(path.join(root, 'package.json'))) { const parent = path.dirname(root); assert.notEqual(parent, root, 'Cannot find repository package.json'); root = parent }
const packaged = process.env.TTYPORA_PACKAGED_EXE
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v${version}-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'), 'Invalid artifact prefix')
const artifacts = path.join(root, 'artifacts'), artifact = (suffix) => path.join(artifacts, `image-input-extra-${prefix}-${suffix}`)
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-image-input-extra-'))
const workspace = path.join(temporary, 'notes'), documents = path.join(workspace, 'docs'), inputs = path.join(temporary, 'inputs')
const assetsA = path.join(workspace, 'assetsA'), assetsEmpty = path.join(workspace, 'assetsEmpty')
const savedPath = path.join(documents, 'saved-upload.md'), firstSavePath = path.join(documents, 'first-save-upload.md')
const orderPath = path.join(documents, 'ordered-upload.md'), reattachPath = path.join(documents, 'reattach.md')
const uploadFiles = Object.fromEntries(['saved', 'first-save', 'order-A', 'order-B'].map((name) => [name, path.join(inputs, `extra-${name}.png`)]))
const sourceA = 'extra-reattach-A.png', sourceB = 'extra-reattach-B.png'
const imageA = path.join(assetsA, sourceA), imageB = path.join(assetsA, sourceB)
const blank = (name) => `# ${name}\n\nBody stays **bold** with \`literal code\` and [a link](https://example.invalid/).\n\n![]()\n\nTail remains unchanged.\n`
const savedMarkdown = blank('Saved upload'), firstSaveMarkdown = blank('First save upload'), orderMarkdown = blank('Ordered upload')
const reattachMarkdown = `---\ntypora-root-url: ../assetsA\n---\n\n# Reattach\n\nBody stays **bold** with \`literal code\` and [a link](https://example.invalid/).\n\n![Reattach alt](${sourceA})\n\nTail remains unchanged.\n`
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const url = (file) => pathToFileURL(file).href
const physical = (value) => { try { const parsed = new URL(value); parsed.search = ''; parsed.hash = ''; return parsed.href } catch { return '' } }
const imageIn = (model) => { const all = []; const visit = (node) => { if (node.type === 'image-block') all.push(node); node.content?.forEach(visit) }; visit(model); assert.equal(all.length, 1); return all[0] }
const onlySource = (baseline, raw) => { const expected = structuredClone(baseline); imageIn(expected).attrs.src = raw; return expected }

function png(width, height, red, green, blue) {
  const crc = (bytes) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0) }; return (value ^ 0xffffffff) >>> 0 }
  const chunk = (name, bytes) => { const type = Buffer.from(name), result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); type.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc(Buffer.concat([type, bytes])), result.length - 4); return result }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) { row[1 + x * 3] = red; row[2 + x * 3] = green; row[3 + x * 3] = blue }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

let application, page, phase = 'fixtures', activePath = null, report = null
const checks = [], errors = [], consoleMessages = [], imageRequests = []
const check = (name, details) => { checks.push({ name, ...details }); console.log(`PASS ${name}`) }
const exclusions = [
  'The original registered file:save-as, file:save, image:save and image:resolve-url handlers perform the actual authorization, filesystem writes/copies and resolution. Holds only delay delivery after genuine successful handler results.',
  'Owned file inputs use Playwright setInputFiles with real isolated PNG paths. This verifies the browser File and App upload pipeline, not native operating-system file-picker UI.',
  'For first Save As only, the existing smoke dialog mechanism supplies one isolated destination through dialog.showSaveDialog. The original registered save handler still executes and writes the actual file; the native operating-system save dialog UI is not verified.',
  'A copied-but-superseded upload A is intentionally retained. App may show its existing document-changed error after A delivery; that handled message is not an uncaught page error.',
  'The detached proof retains a previously attached public native DOM host and adds a read-only standard load listener. No Vue props, DOM factory prototypes, src setter, load event, PM transaction or input value is fabricated.',
  'Actual native input Undo restores one atomic keyboard insertion, matching Chromium input history. It does not claim that per-character typing always forms one native undo unit.',
  'No source snapshot runs until DOM, ownership, load and history assertions for its case have finished. Switching to source mode legitimately destroys/recreates image NodeViews.',
  'Readonly, IME, upload cancellation, system dialog appearance, remote/network upload and platform-specific paths are outside these four groups.',
]
const cleanup = { fixtureDirectory: temporary, handlerIdentities: null, dialogIdentity: null, nativeObserverRemoved: null, domLoadObserverRemoved: null, applicationClosed: null, processExited: null, fixtureRemoved: false }

try {
  for (const directory of [documents, inputs, assetsA, assetsEmpty, artifacts]) await mkdir(directory, { recursive: true })
  for (const [index, file] of Object.values(uploadFiles).entries()) await writeFile(file, png(2, 2, 40 + index * 35, 65, 175 - index * 30))
  await writeFile(imageA, png(200, 120, 180, 45, 35)); await writeFile(imageB, png(2, 2, 30, 65, 185))
  await writeFile(savedPath, savedMarkdown); await writeFile(orderPath, orderMarkdown); await writeFile(reattachPath, reattachMarkdown)
  const flags = ['--disable-gpu', '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  phase = 'launch'
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? flags : [...flags, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text(), at: Date.now() }) })
  page.on('request', (request) => { if (request.resourceType() === 'image') imageRequests.push({ url: request.url(), at: Date.now() }) })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  const menu = (name) => application.evaluate(({ Menu, BrowserWindow }, name) => {
    const spec = {
      workspace: { labels: ['打开文件夹…', 'Open folder…'] }, new: { accelerator: 'CmdOrCtrl+N', labels: ['新建', 'New'] },
      source: { accelerator: 'CmdOrCtrl+/', labels: ['源码模式', 'Source mode'] }, save: { accelerator: 'CmdOrCtrl+S', labels: ['保存', 'Save'] },
      undo: { accelerator: 'CmdOrCtrl+Z', labels: ['撤销', 'Undo'] }, redo: { accelerator: 'CmdOrCtrl+Y', labels: ['重做', 'Redo'] },
    }[name]
    const items = []; const visit = (menu) => menu?.items.forEach((item) => { items.push(item); if (item.submenu) visit(item.submenu) }); visit(Menu.getApplicationMenu())
    const item = items.find((item) => item.visible && item.enabled && (spec.accelerator && item.accelerator === spec.accelerator || spec.labels.includes(item.label.replace(/&/g, ''))))
    if (!item || typeof item.click !== 'function') throw new Error(`Missing genuine menu ${name}`)
    item.click(item, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], {}); return { label: item.label, accelerator: item.accelerator }
  }, name)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').first().waitFor() }
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const model = () => page.evaluate(() => document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON())
  const fileInput = () => page.locator('.ttypora-image-link-input input[type=file]')
  const linkInput = () => page.locator('.ttypora-image-link-input .link-input-area')
  const nativeImage = () => page.locator('.ttypora-authorized-image-host img[data-type="image-block"]')
  const open = async (file) => { await page.locator('.file-tree').getByTitle(file, { exact: true }).click(); await page.waitForFunction((name) => document.title.includes(name), path.basename(file)); await ready(); activePath = file }
  const waitImage = (file, width = 2, height = 2) => page.waitForFunction(({ expected, width, height }) => {
    const image = document.querySelector('.ttypora-authorized-image-host img[data-type="image-block"]')
    const physical = (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href } catch { return '' } }
    return image && image.isConnected && image.complete && physical(image.getAttribute('src')) === expected && physical(image.currentSrc) === expected && image.naturalWidth === width && image.naturalHeight === height
  }, { expected: url(file), width, height })
  const sourceSnapshot = async () => {
    await menu('source'); await page.locator('.source-editor .cm-content').waitFor(); await ready()
    const markdown = await page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString())
    await menu('source'); await page.locator('.ProseMirror').waitFor(); await ready(); return markdown
  }
  const bodyFocus = async () => { await page.locator('.ProseMirror p').filter({ hasText: 'Body stays bold with literal code and a link.' }).first().click(); assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ProseMirror')), true) }
  const rememberInput = (key) => page.evaluate((key) => {
    const file = document.querySelector('.ttypora-image-link-input input[type=file]'), input = document.querySelector('.ttypora-image-link-input .link-input-area'), outer = input.closest('.ttypora-localized-image-view'), prose = document.querySelector('.ProseMirror')
    window.__extraInputIdentities ??= {}; window.__extraInputIdentities[key] = { file, input, outer, prose, outerDesc: outer.pmViewDesc, proseDesc: prose.pmViewDesc }
  }, key)
  const sameInput = (key) => page.evaluate((key) => { const saved = window.__extraInputIdentities[key]; return { file: saved.file.isConnected && saved.file === document.querySelector('.ttypora-image-link-input input[type=file]'), input: saved.input.isConnected && saved.input === document.querySelector('.ttypora-image-link-input .link-input-area'), outer: saved.outer.isConnected && saved.outer === document.querySelector('.ttypora-localized-image-view') && saved.outerDesc === saved.outer.pmViewDesc, prose: saved.prose === document.querySelector('.ProseMirror') && saved.proseDesc === saved.prose.pmViewDesc } }, key)
  const assertInputIdentity = async (key) => { const identity = await sameInput(key); assert.deepEqual(identity, { file: true, input: true, outer: true, prose: true }); return identity }

  await ready()
  await application.evaluate(({ ipcMain, dialog }) => {
    const control = { originals: new Map(), originalDialog: dialog.showSaveDialog, dialogCalls: [], pickerPath: null, pending: [], hold: null, records: [], nativeCommands: [], restored: false }
    globalThis.__imageExtraControl = control
    control.nativeObserver = (_event, direction) => control.nativeCommands.push({ direction, at: Date.now() }); ipcMain.on('edit:native-history', control.nativeObserver)
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1), chosen = control.pickerPath
      control.dialogCalls.push({ title: options?.title, defaultPath: options?.defaultPath, filters: options?.filters, chosen, at: Date.now(), harnessSelected: Boolean(chosen) })
      if (!chosen) return Reflect.apply(control.originalDialog, dialog, args)
      control.pickerPath = null; return { canceled: false, filePath: chosen }
    }
    for (const channel of ['file:save-as', 'file:save', 'image:save', 'image:resolve-url']) {
      const original = ipcMain._invokeHandlers?.get(channel); if (typeof original !== 'function') throw new Error(`Missing genuine main handler ${channel}`)
      control.originals.set(channel, original); ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        const request = args[0], input = args[1]
        const record = { index: control.records.length, channel, snapshot: request && typeof request === 'object' ? { ...request } : request, source: typeof input === 'string' ? input : undefined, fileName: typeof input === 'object' ? input?.fileName : undefined, byteLength: input?.bytes?.byteLength, startedAt: Date.now(), completed: false, delivered: false, held: false }
        control.records.push(record); let result
        try { result = await original(event, ...args); record.result = result; record.completed = true; record.completedAt = Date.now() }
        catch (error) { record.error = String(error); record.completed = record.delivered = true; record.completedAt = record.deliveredAt = Date.now(); throw error }
        const hold = control.hold
        if (hold && hold.channel === channel && (!hold.fileName || hold.fileName === record.fileName) && (!hold.source || hold.source === record.source) && (!hold.documentPath || hold.documentPath === request?.documentPath) && (!hold.rootLine || request?.markdown?.includes(hold.rootLine))) {
          record.held = true; await new Promise((resolve) => control.pending.push({ index: record.index, resolve }))
        }
        record.delivered = true; record.deliveredAt = Date.now(); return result
      })
    }
  })
  const records = () => application.evaluate(() => globalThis.__imageExtraControl.records)
  const nativeCommands = () => application.evaluate(() => globalThis.__imageExtraControl.nativeCommands)
  const arm = (hold) => application.evaluate((_electron, hold) => { globalThis.__imageExtraControl.hold = hold }, hold)
  const release = () => application.evaluate(() => { const control = globalThis.__imageExtraControl; control.hold = null; control.pending.splice(0).forEach(({ resolve }) => resolve()) })
  const waitMain = async (predicate, message) => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const entries = await records(); if (predicate(entries)) return entries; await frames() }; throw new Error(message) }
  const waitUpload = async (first, fileName, documentPath) => {
    const entries = await waitMain((entries) => entries.slice(first).some((entry) => entry.channel === 'image:save' && entry.fileName === fileName && entry.snapshot?.documentPath === documentPath && entry.completed && entry.delivered && !entry.error), 'Genuine owned upload never completed')
    return entries.slice(first).find((entry) => entry.channel === 'image:save' && entry.fileName === fileName && entry.snapshot?.documentPath === documentPath && entry.completed && entry.delivered && !entry.error)
  }
  const verifyCopy = async (entry, originalFile, documentPath) => {
    assert.equal(entry.channel, 'image:save'); assert.equal(entry.snapshot.documentPath, documentPath)
    const asset = entry.result; assert.equal(typeof asset?.path, 'string'); assert.equal(typeof asset?.markdownUrl, 'string'); assert.ok(asset.markdownUrl)
    const actual = await realpath(asset.path), expectedDirectory = await realpath(path.join(path.dirname(documentPath), `${path.basename(documentPath, '.md')}.assets`))
    assert.equal(path.dirname(actual).toLocaleLowerCase(), expectedDirectory.toLocaleLowerCase(), 'Upload copies to the actual document asset folder')
    const originalBytes = await readFile(originalFile), copiedBytes = await readFile(actual)
    assert.deepEqual(copiedBytes, originalBytes); assert.equal(entry.byteLength, originalBytes.length)
    return { path: actual, markdownUrl: asset.markdownUrl, bytes: copiedBytes.length, sha256: sha(copiedBytes), sourceSHA256: sha(originalBytes) }
  }
  const verifyUploadHistory = async (documentPath, baselineMarkdown, baselineModel, entry, originalFile) => {
    const raw = entry.result.markdownUrl, expected = onlySource(baselineModel, raw), markdown = baselineMarkdown.replace('![]()', `![](${raw})`)
    await waitImage(entry.result.path); assert.deepEqual(await model(), expected)
    assert.equal(await sourceSnapshot(), markdown)
    await menu('save'); await page.waitForFunction(() => !document.title.startsWith('●')); assert.equal(await readFile(documentPath, 'utf8'), markdown)
    await bodyFocus(); const nativeBefore = (await nativeCommands()).length; const undo = await menu('undo')
    await page.waitForFunction(() => { let src; document.querySelector('.ProseMirror')?.pmViewDesc?.node.descendants((node) => { if (node.type.name === 'image-block') src = node.attrs.src }); return src === '' })
    assert.deepEqual(await model(), baselineModel); assert.equal((await nativeCommands()).length, nativeBefore)
    assert.equal(await sourceSnapshot(), baselineMarkdown); await menu('save'); await page.waitForFunction(() => !document.title.startsWith('●')); assert.equal(await readFile(documentPath, 'utf8'), baselineMarkdown)
    const copyAfterUndo = await verifyCopy(entry, originalFile, documentPath)
    await bodyFocus(); const redo = await menu('redo'); await waitImage(entry.result.path)
    assert.deepEqual(await model(), expected); assert.equal((await nativeCommands()).length, nativeBefore)
    assert.equal(await sourceSnapshot(), markdown); await menu('save'); await page.waitForFunction(() => !document.title.startsWith('●')); assert.equal(await readFile(documentPath, 'utf8'), markdown)
    const copyAfterRedo = await verifyCopy(entry, originalFile, documentPath); assert.deepEqual(copyAfterRedo, copyAfterUndo)
    return { raw, markdown, undo, redo, completePMRestored: true, physicalBytesRestored: true, copyAfterUndo, copyAfterRedo, copiedAssetStillPresent: true, undoScope: 'shared document history after real body focus' }
  }
  await menu('workspace')

  phase = '1: saved blank owned file input actually copies and commits with complete shared Undo/Redo'
  {
    await open(savedPath); await fileInput().waitFor({ state: 'attached' }); const baseline = await model(), first = (await records()).length
    assert.equal(imageIn(baseline).attrs.src, ''); await rememberInput('saved')
    await fileInput().setInputFiles(uploadFiles.saved)
    const entry = await waitUpload(first, path.basename(uploadFiles.saved), savedPath), copy = await verifyCopy(entry, uploadFiles.saved, savedPath)
    await waitImage(entry.result.path); const identity = await assertInputIdentity('saved')
    assert.deepEqual(await model(), onlySource(baseline, entry.result.markdownUrl)); assert.equal(await readFile(savedPath, 'utf8'), savedMarkdown)
    const history = await verifyUploadHistory(savedPath, savedMarkdown, baseline, entry, uploadFiles.saved)
    check('Saved blank owned file input performs real copy, commits its actual raw URL and supports full shared PM/source/file Undo/Redo', { copy, identity, history, ipc: (await records()).slice(first) })
  }

  phase = '2: unsaved owned file input performs genuine first Save As before real asset save'
  {
    assert.equal(existsSync(firstSavePath), false)
    await menu('new'); await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent === ''); await ready(); activePath = null
    await menu('source'); await page.locator('.source-editor .cm-content').waitFor(); await ready()
    const source = page.locator('.source-editor .cm-content'); await source.click(); await source.press('Control+a'); await page.keyboard.insertText(firstSaveMarkdown)
    assert.equal(await source.evaluate((element) => element.cmTile.root.view.state.doc.toString()), firstSaveMarkdown)
    await menu('source'); await page.locator('.ProseMirror').waitFor(); await ready(); await fileInput().waitFor({ state: 'attached' })
    const baseline = await model(), first = (await records()).length; assert.equal(imageIn(baseline).attrs.src, ''); await rememberInput('first-save')
    await application.evaluate((_electron, file) => { globalThis.__imageExtraControl.pickerPath = file }, firstSavePath)
    await fileInput().setInputFiles(uploadFiles['first-save'])
    const entry = await waitUpload(first, path.basename(uploadFiles['first-save']), firstSavePath)
    await page.waitForFunction((name) => document.title.includes(name), path.basename(firstSavePath)); activePath = firstSavePath
    const saveAs = (await records()).slice(first).find((entry) => entry.channel === 'file:save-as' && entry.completed && entry.delivered && !entry.error && entry.result?.status === 'saved' && entry.result.snapshot?.path === firstSavePath)
    assert.ok(saveAs, 'Original registered first Save As handler must return an actual saved snapshot')
    assert.equal(saveAs.snapshot.markdown, firstSaveMarkdown); assert.equal(saveAs.result.snapshot.markdown, firstSaveMarkdown)
    assert.equal(entry.snapshot.markdown, firstSaveMarkdown); assert.ok(entry.startedAt >= saveAs.completedAt, 'Asset save must begin after real first Save As completes')
    assert.equal(await readFile(firstSavePath, 'utf8'), firstSaveMarkdown, 'First Save As physically writes the insertion-before body snapshot')
    const copy = await verifyCopy(entry, uploadFiles['first-save'], firstSavePath)
    await waitImage(entry.result.path); const identity = await assertInputIdentity('first-save')
    assert.deepEqual(await model(), onlySource(baseline, entry.result.markdownUrl))
    const dialogCalls = await application.evaluate(() => globalThis.__imageExtraControl.dialogCalls)
    assert.equal(dialogCalls.filter((entry) => entry.harnessSelected && entry.chosen === firstSavePath).length, 1)
    const history = await verifyUploadHistory(firstSavePath, firstSaveMarkdown, baseline, entry, uploadFiles['first-save'])
    check('Unsaved owned upload runs real first Save As using one controlled picker destination, then copies with the saved snapshot and complete shared Undo/Redo', { copy, identity, saveAs, dialogCalls, nativeSystemDialogUITested: false, history, ipc: (await records()).slice(first) })
  }

  phase = '3: genuine copied upload A held while same visible file input selects B'
  {
    await open(orderPath); await fileInput().waitFor({ state: 'attached' }); const baseline = await model(), first = (await records()).length, requestFirst = imageRequests.length
    await rememberInput('order'); await arm({ channel: 'image:save', fileName: path.basename(uploadFiles['order-A']), documentPath: orderPath })
    await fileInput().setInputFiles(uploadFiles['order-A'])
    const entries = await waitMain((entries) => entries.slice(first).some((entry) => entry.channel === 'image:save' && entry.fileName === path.basename(uploadFiles['order-A']) && entry.completed && entry.held && !entry.delivered && !entry.error), 'Actual A copy never reached the result-delivery hold')
    const heldA = entries.slice(first).find((entry) => entry.channel === 'image:save' && entry.fileName === path.basename(uploadFiles['order-A']) && entry.held)
    const copyA = await verifyCopy(heldA, uploadFiles['order-A'], orderPath)
    assert.deepEqual(await model(), baseline); await assertInputIdentity('order')
    assert.equal(await page.locator('.ttypora-image-link-input').isVisible(), true)
    assert.equal(await fileInput().isEnabled(), true); assert.equal(await linkInput().inputValue(), '')
    await fileInput().setInputFiles(uploadFiles['order-B'])
    const entryB = await waitUpload(first, path.basename(uploadFiles['order-B']), orderPath), copyB = await verifyCopy(entryB, uploadFiles['order-B'], orderPath)
    await waitImage(entryB.result.path); await assertInputIdentity('order'); assert.deepEqual(await model(), onlySource(baseline, entryB.result.markdownUrl))
    await release(); await waitMain((entries) => entries[heldA.index]?.delivered, 'Actual held A result did not release'); await page.waitForTimeout(350); await frames()
    await waitImage(entryB.result.path); const identity = await assertInputIdentity('order'); assert.deepEqual(await model(), onlySource(baseline, entryB.result.markdownUrl))
    assert.equal(imageRequests.slice(requestFirst).some((entry) => physical(entry.url) === url(entryB.result.path) && entry.at >= entryB.deliveredAt), true)
    assert.equal(imageRequests.slice(requestFirst).some((entry) => physical(entry.url) === url(heldA.result.path)), false, 'Superseded real copied A must never become a browser image')
    assert.equal(await sourceSnapshot(), orderMarkdown.replace('![]()', `![](${entryB.result.markdownUrl})`)); assert.equal(await readFile(orderPath, 'utf8'), orderMarkdown)
    const retainedA = await verifyCopy(heldA, uploadFiles['order-A'], orderPath), retainedB = await verifyCopy(entryB, uploadFiles['order-B'], orderPath)
    assert.deepEqual(retainedA, copyA); assert.deepEqual(retainedB, copyB)
    check('Same visible owned file controller selects B after real A copy completed; late A delivery retains both real copies and cannot change B PM/source/viewer', { copyA, copyB, retainedA, retainedB, identity, copiedButSupersededARetained: true, ipc: (await records()).slice(first) })
  }

  phase = '4: newly decoded detached native image reattaches and supports actual resize plus shared Undo'
  {
    await open(reattachPath); await waitImage(imageA, 200, 120)
    await page.waitForFunction(() => Number(document.querySelector('.ttypora-authorized-image-host img[data-type="image-block"]')?.dataset.origin) > 0)
    const baseline = await model(), first = (await records()).length
    await rememberInput('reattach')
    await page.evaluate((expected) => {
      const native = document.querySelector('.ttypora-authorized-image-host > .milkdown-image-block'), initialImage = native.querySelector('img[data-type="image-block"]'), outer = native.closest('.ttypora-localized-image-view')
      const saved = { native, initialImage, outer, outerDesc: outer.pmViewDesc, events: [], freshImage: null }
      const observe = (event) => {
        const image = event.target
        if (!(image instanceof HTMLImageElement) || image.dataset.type !== 'image-block') return
        const physical = (value) => { try { const parsed = new URL(value); parsed.search = ''; parsed.hash = ''; return parsed.href } catch { return '' } }
        if (physical(image.getAttribute('src')) !== expected) return
        saved.events.push({ trusted: event.isTrusted, imageConnected: image.isConnected, hostConnected: native.isConnected, hostWidth: native.getBoundingClientRect().width, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, origin: image.dataset.origin ?? null, height: image.dataset.height ?? null, at: performance.now() })
        if (event.isTrusted && !image.isConnected && image !== initialImage) saved.freshImage = image
      }
      native.addEventListener('load', observe, true); saved.remove = () => native.removeEventListener('load', observe, true); window.__extraReattach = saved
    }, url(imageA))
    const setRoot = async (next) => {
      const yaml = page.locator('.front-matter-source'), text = await yaml.textContent(), match = text.match(/^typora-root-url: ([^\r\n]+)$/m)
      assert.ok(match); const suffixEnd = match.index + match[0].length, previous = match[1]
      const caret = () => yaml.evaluate((pre) => { const selection = window.getSelection(), anchor = selection?.anchorNode, inPre = Boolean(anchor && pre.contains(anchor)); let offset = -1; if (inPre && selection.isCollapsed) { const range = document.createRange(); range.selectNodeContents(pre); range.setEnd(anchor, selection.anchorOffset); offset = range.toString().length }; return { inPre, offset } })
      await yaml.click(); await page.keyboard.press('Control+Home'); let position = await caret()
      for (let step = 0; !position.inPre && step < 8; step++) { await page.keyboard.press('ArrowRight'); position = await caret() }
      if (!position.inPre) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); position = await caret(); for (let step = 0; !position.inPre && step < 8; step++) { await page.keyboard.press('ArrowRight'); position = await caret() } }
      assert.ok(position.inPre && position.offset >= 0 && position.offset <= suffixEnd)
      for (let step = 0; position.offset < suffixEnd && step < text.length + 16; step++) { await page.keyboard.press('ArrowRight'); position = await caret() }
      assert.equal(position.offset, suffixEnd); for (let step = 0; step < previous.length; step++) await page.keyboard.press('Shift+ArrowLeft')
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), previous)
      await page.keyboard.insertText(next); await page.waitForFunction((next) => document.querySelector('.front-matter-source')?.textContent?.includes(`typora-root-url: ${next}`), next)
    }
    await setRoot('../assetsEmpty')
    await waitMain((entries) => entries.slice(first).some((entry) => entry.channel === 'image:resolve-url' && entry.source === sourceA && entry.snapshot?.markdown?.includes('typora-root-url: ../assetsEmpty') && entry.completed && entry.error), 'Empty root must really fail in the original authorized resolver')
    await page.waitForFunction(() => { const saved = window.__extraReattach; return !saved.native.isConnected && !saved.native.querySelector('img[data-type="image-block"]') })
    await linkInput().waitFor({ state: 'visible' }); await assertInputIdentity('reattach')
    assert.equal(imageIn(await model()).attrs.src, sourceA)
    await arm({ channel: 'image:resolve-url', source: sourceA, documentPath: reattachPath, rootLine: 'typora-root-url: ../assetsA' })
    await setRoot('../assetsA')
    const held = await waitMain((entries) => entries.slice(first).some((entry) => entry.channel === 'image:resolve-url' && entry.source === sourceA && entry.snapshot?.markdown === reattachMarkdown && entry.completed && entry.held && !entry.delivered && !entry.error), 'Restored A must genuinely authorize and wait for delivery')
    const heldA = held.slice(first).filter((entry) => entry.channel === 'image:resolve-url' && entry.source === sourceA && entry.completed && entry.held && !entry.delivered)
    await linkInput().click(); assert.equal(await linkInput().evaluate((input) => input.ownerDocument.activeElement === input), true)
    await linkInput().press('Control+a'); await page.keyboard.insertText(sourceB)
    await page.waitForFunction((expected) => { const image = document.querySelector('.ttypora-image-link-input .image-preview img'); if (!image?.complete || image.naturalWidth !== 2) return false; const parsed = new URL(image.currentSrc); parsed.search = ''; parsed.hash = ''; return parsed.href === expected }, url(imageB))
    assert.deepEqual(await model(), baseline); await assertInputIdentity('reattach')
    assert.equal(await page.evaluate(() => window.__extraReattach.native.querySelector('img[data-type="image-block"]') === null), true)
    await release(); await waitMain((entries) => heldA.every((entry) => entries[entry.index]?.delivered), 'Restored A delivery never released')
    await page.waitForFunction(() => { const saved = window.__extraReattach, image = saved.freshImage; return image && image !== saved.initialImage && !image.isConnected && !saved.native.isConnected && image.complete && image.naturalWidth === 200 && image.naturalHeight === 120 && saved.events.some((entry) => entry.trusted && !entry.imageConnected && entry.hostWidth === 0) })
    await frames()
    const detached = await page.evaluate(() => { const saved = window.__extraReattach, image = saved.freshImage; return { newImage: image !== saved.initialImage, imageConnected: image.isConnected, hostConnected: saved.native.isConnected, hostWidth: saved.native.getBoundingClientRect().width, origin: image.dataset.origin ?? null, height: image.dataset.height ?? null, events: saved.events.slice() } })
    assert.equal(detached.newImage, true); assert.equal(detached.imageConnected, false); assert.equal(detached.hostConnected, false); assert.equal(detached.hostWidth, 0); assert.equal(detached.origin, null)
    assert.equal(await linkInput().inputValue(), sourceB); assert.deepEqual(await model(), baseline)
    await linkInput().press('Control+z')
    await page.waitForFunction((expected) => { const saved = window.__extraReattach, image = saved.freshImage; return document.querySelector('.ttypora-image-link-input .link-input-area')?.value === expected && image.isConnected && saved.native.isConnected && image === document.querySelector('.ttypora-authorized-image-host img[data-type="image-block"]') && Number(image.dataset.origin) > 0 && Number(image.dataset.height) > 0 && saved.events.some((entry) => !entry.trusted && entry.imageConnected && entry.hostWidth > 0) }, sourceA)
    await frames(); await waitImage(imageA, 200, 120); await assertInputIdentity('reattach'); assert.deepEqual(await model(), baseline)
    const connected = await page.evaluate(() => { const saved = window.__extraReattach, image = saved.freshImage; return { sameNativeHost: saved.native === document.querySelector('.ttypora-authorized-image-host > .milkdown-image-block'), sameOuter: saved.outer === document.querySelector('.ttypora-localized-image-view') && saved.outerDesc === saved.outer.pmViewDesc, sameFreshImage: image === saved.native.querySelector('img[data-type="image-block"]'), width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, origin: image.dataset.origin, storedHeight: image.dataset.height, events: saved.events.slice() } })
    assert.equal(connected.sameNativeHost, true); assert.equal(connected.sameOuter, true); assert.equal(connected.sameFreshImage, true); assert.ok(connected.width > 0); assert.ok(connected.height > 0)
    await nativeImage().scrollIntoViewIfNeeded(); await nativeImage().hover()
    const handle = nativeImage().locator('..').locator('.image-resize-handle'), handleBox = await handle.boundingBox(), imageBox = await nativeImage().boundingBox()
    assert.ok(handleBox && imageBox); const origin = await nativeImage().evaluate((image) => Number(image.dataset.origin)), beforeResize = await model()
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2); await page.mouse.down(); await page.mouse.move(handleBox.x + handleBox.width / 2, imageBox.y + origin * 1.5, { steps: 8 }); await page.mouse.up()
    await page.waitForFunction(() => { let attrs; document.querySelector('.ProseMirror')?.pmViewDesc?.node.descendants((node) => { if (node.type.name === 'image-block') attrs = node.attrs }); return Number(attrs?.ratio) > 1 && Number(attrs?.resizeWidth) > 0 })
    const resized = await model(), resizedImage = imageIn(resized), expectedResize = structuredClone(beforeResize)
    assert.equal(resizedImage.attrs.src, sourceA); assert.ok(Number.isFinite(resizedImage.attrs.ratio)); assert.ok(resizedImage.attrs.resizeWidth > 0)
    imageIn(expectedResize).attrs = { ...imageIn(expectedResize).attrs, ratio: resizedImage.attrs.ratio, resizeWidth: resizedImage.attrs.resizeWidth }
    assert.deepEqual(resized, expectedResize, 'Actual pointer resize may change only ratio and pixel width')
    await bodyFocus(); const nativeBefore = (await nativeCommands()).length; const undo = await menu('undo')
    await page.waitForFunction((expected) => { let attrs; document.querySelector('.ProseMirror')?.pmViewDesc?.node.descendants((node) => { if (node.type.name === 'image-block') attrs = node.attrs }); return attrs?.ratio === expected.ratio && attrs?.resizeWidth === expected.resizeWidth }, { ratio: imageIn(beforeResize).attrs.ratio, resizeWidth: imageIn(beforeResize).attrs.resizeWidth })
    assert.deepEqual(await model(), beforeResize); assert.equal((await nativeCommands()).length, nativeBefore)
    assert.equal(await sourceSnapshot(), reattachMarkdown); assert.equal(await readFile(reattachPath, 'utf8'), reattachMarkdown)
    check('Fresh A truly decodes detached while draft B remains unconfirmed; atomic native input Undo reconnects the same image, product load replay initializes dimensions, and real resize/shared Undo work', { detached, connected, resizedAttrs: resizedImage.attrs, undo, originalMarkdownRestored: true, ipc: (await records()).slice(first) })
  }

  phase = 'genuine IPC and public DOM observer restoration'
  assert.equal(checks.length, 4); assert.deepEqual(errors, [])
  const ipc = await waitMain((entries) => entries.every((entry) => entry.completed && entry.delivered), 'Every genuine main request must settle before restoration')
  await frames(); assert.deepEqual(errors, [])
  const picker = await application.evaluate(() => globalThis.__imageExtraControl.dialogCalls)
  const nativeHistory = await nativeCommands()
  const loadObserverRemoved = await page.evaluate(() => { if (!window.__extraReattach) return true; window.__extraReattach.remove(); return true })
  cleanup.domLoadObserverRemoved = loadObserverRemoved
  const restored = await application.evaluate(({ ipcMain, dialog }) => {
    const control = globalThis.__imageExtraControl; control.hold = null; control.pending.splice(0).forEach(({ resolve }) => resolve())
    for (const [channel, original] of control.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
    dialog.showSaveDialog = control.originalDialog; ipcMain.removeListener('edit:native-history', control.nativeObserver); control.restored = true
    return { handlers: Object.fromEntries([...control.originals].map(([channel, original]) => [channel, ipcMain._invokeHandlers?.get(channel) === original])), dialog: dialog.showSaveDialog === control.originalDialog, observerRemoved: !ipcMain.listeners('edit:native-history').includes(control.nativeObserver) }
  })
  assert.ok(Object.values(restored.handlers).every(Boolean)); assert.equal(restored.dialog, true); assert.equal(restored.observerRemoved, true)
  cleanup.handlerIdentities = restored.handlers; cleanup.dialogIdentity = restored.dialog; cleanup.nativeObserverRemoved = restored.observerRemoved
  report = { variant: packaged ? 'packaged' : 'source', prefix, version: await application.evaluate(({ app }) => app.getVersion()), completedAt: new Date().toISOString(), checks, exclusions, nativeSystemDialogUITested: false, chooserMechanism: 'Existing smoke controlled one Save As destination; original registered save and asset handlers perform all authorization/writes', restored, picker, nativeHistory, errors, consoleMessages, imageRequests, ipc }
} catch (error) {
  let diagnostic = { unavailable: true }
  if (page && !page.isClosed()) {
    diagnostic = await page.evaluate(() => { const saved = window.__extraReattach; return { body: document.body.innerText, title: document.title, model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(), inputs: [...document.querySelectorAll('.ttypora-image-link-input input')].map((input) => ({ type: input.type, value: input.value, connected: input.isConnected, active: document.activeElement === input })), images: [...document.querySelectorAll('.ttypora-localized-image-view img')].map((image) => ({ src: image.getAttribute('src'), currentSrc: image.currentSrc, complete: image.complete, naturalWidth: image.naturalWidth, origin: image.dataset.origin, height: image.dataset.height })), detached: saved ? { nativeConnected: saved.native.isConnected, freshImageConnected: saved.freshImage?.isConnected, freshOrigin: saved.freshImage?.dataset.origin, events: saved.events } : null } }).catch(() => diagnostic)
    await page.screenshot({ path: artifact('failure.png'), animations: 'disabled', timeout: 60000 }).catch(() => undefined)
  }
  await mkdir(artifacts, { recursive: true }); await writeFile(artifact('failure.json'), JSON.stringify({ phase, activePath, prefix, error: String(error), stack: error?.stack, checks, exclusions, diagnostic, errors, consoleMessages, imageRequests, ipc: application ? await application.evaluate(() => globalThis.__imageExtraControl?.records ?? []).catch(() => []) : [] }, null, 2) + '\n'); process.exitCode = 1
} finally {
  if (page && !page.isClosed()) cleanup.domLoadObserverRemoved = await page.evaluate(() => { window.__extraReattach?.remove(); return true }).catch((error) => String(error))
  if (application) {
    const restored = await application.evaluate(({ ipcMain, dialog }) => {
      const control = globalThis.__imageExtraControl; if (!control) return { handlers: null, dialog: null, observerRemoved: null }
      control.hold = null; control.pending.splice(0).forEach(({ resolve }) => resolve())
      if (!control.restored) { for (const [channel, original] of control.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }; dialog.showSaveDialog = control.originalDialog; control.restored = true }
      ipcMain.removeListener('edit:native-history', control.nativeObserver)
      return { handlers: Object.fromEntries([...control.originals].map(([channel, original]) => [channel, ipcMain._invokeHandlers?.get(channel) === original])), dialog: dialog.showSaveDialog === control.originalDialog, observerRemoved: !ipcMain.listeners('edit:native-history').includes(control.nativeObserver) }
    }).catch((error) => ({ handlers: null, dialog: String(error), observerRemoved: false }))
    cleanup.handlerIdentities = restored.handlers; cleanup.dialogIdentity = restored.dialog; cleanup.nativeObserverRemoved = restored.observerRemoved
    if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
    const child = application.process(); let timer
    cleanup.applicationClosed = await Promise.race([application.close().then(() => true, (error) => String(error)), new Promise((resolve) => { timer = setTimeout(() => resolve('Application close exceeded 15 seconds'), 15000) })]); clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise((resolve) => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve() }) }) }
    cleanup.processExited = Boolean(child && (child.exitCode !== null || child.signalCode !== null))
  }
  try {
    if (application) assert.equal(cleanup.processExited, true, 'Refusing fixture cleanup while isolated app may still run')
    const actual = await realpath(temporary), parent = await realpath(tmpdir()), relative = path.relative(parent, actual)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.' && path.basename(actual).startsWith('ttypora-image-input-extra-'), 'Refusing cleanup outside exact newly created fixture directory')
    await rm(actual, { recursive: true, force: true }); cleanup.fixtureRemoved = !existsSync(actual); assert.equal(cleanup.fixtureRemoved, true)
  } catch (error) { cleanup.fixtureError = String(error); process.exitCode = 1 }
  if (application && (!cleanup.handlerIdentities || !Object.values(cleanup.handlerIdentities).every(Boolean) || cleanup.dialogIdentity !== true || cleanup.nativeObserverRemoved !== true || cleanup.applicationClosed !== true || cleanup.processExited !== true)) process.exitCode = 1
  if (report && cleanup.domLoadObserverRemoved !== true) process.exitCode = 1
  await mkdir(artifacts, { recursive: true }); await writeFile(artifact('cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n')
}
if (report && errors.length) { process.exitCode = 1; await writeFile(artifact('failure.json'), JSON.stringify({ phase: 'Late renderer error after genuine requests settled', prefix, checks, exclusions, errors, consoleMessages, imageRequests, ipc: report.ipc, cleanup }, null, 2) + '\n') }
if (report && process.exitCode !== 1) { await writeFile(artifact('verification.json'), JSON.stringify({ ...report, cleanup }, null, 2) + '\n'); console.log('PASS all four independent image input extra groups after handler/dialog restoration, process exit and precise fixture cleanup') }
