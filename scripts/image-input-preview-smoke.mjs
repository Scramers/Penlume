import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { _electron as electron } from 'playwright'

// Prepared in staging only. The runner must merge the image-input delta and
// build separately before running this real desktop suite, serially.
let root = path.dirname(fileURLToPath(import.meta.url))
while (!existsSync(path.join(root, 'package.json'))) {
  const parent = path.dirname(root)
  assert.notEqual(parent, root, 'Cannot locate repository package.json')
  root = parent
}
const packaged = process.env.TTYPORA_PACKAGED_EXE
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v${version}-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'), 'Invalid artifact prefix')
const artifacts = path.join(root, 'artifacts')
const artifact = (suffix) => path.join(artifacts, `image-input-preview-${prefix}-${suffix}`)
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-image-input-smoke-'))
const workspace = path.join(temporary, 'notes'), documents = path.join(workspace, 'docs')
const assetsA = path.join(workspace, 'assetsA'), assetsC = path.join(workspace, 'assetsC')
const outside = path.join(temporary, 'outside'), outsideImage = path.join(outside, 'preview-outside.png')
const fixtureURL = (file) => pathToFileURL(file).href
const physicalURL = (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href } catch { return '' } }
const markdownFor = (name, inline = false) => `---\ntypora-root-url: ../assetsA\n---\n\n# ${name}\n\nBody stays **bold** with \`literal code\` and [a link](https://example.invalid/).\n\n${inline ? 'Inline ![]() suffix.' : '![]()'}\n\nTail remains unchanged.\n`
const notes = Object.fromEntries([
  'authorized-block', 'authorized-inline', 'outside-file-url', 'missing-relative',
  'input-history', 'confirm-undo', 'preview-order', 'confirm-order',
  'root-order', 'disposed-preview', 'disposal-target',
].map((name) => [name, { path: path.join(documents, `${name}.md`), markdown: markdownFor(name, name === 'authorized-inline') }]))
const caseImages = Object.fromEntries(Object.keys(notes).map((name) => [name, { single: `preview-${name}.png`, a: `preview-${name}-A.png`, b: `preview-${name}-B.png` }]))
const fixtureOwners = new Map()

function png(red, green, blue) {
  const crc32 = (bytes) => {
    let value = 0xffffffff
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0) }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), result = Buffer.alloc(bytes.length + 12)
    result.writeUInt32BE(bytes.length); type.copy(result, 4); bytes.copy(result, 8)
    result.writeUInt32BE(crc32(Buffer.concat([type, bytes])), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2
  const row = Buffer.from([0, red, green, blue, red, green, blue])
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))])
}
const imagesInModel = (node) => [
  ...(['image', 'image-block'].includes(node.type) ? [node] : []),
  ...(node.content ?? []).flatMap(imagesInModel),
]
const changeOnlySource = (baseline, source) => {
  const expected = structuredClone(baseline), images = imagesInModel(expected)
  assert.equal(images.length, 1); images[0].attrs.src = source
  return expected
}

let application, page, phase = 'fixtures', activePath = null, report = null
let originalHandlerRestored = null, observedIPC = [], observedNativeCommands = []
const checks = [], pageErrors = [], consoleMessages = [], imageRequests = [], imageFailures = []
const rawCandidates = new Set()
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`) }
const exclusions = [
  'The main observer calls the genuine registered image:resolve-url handler with the original event and arguments. Delivery holds apply only after real successful authorization. No URL, snapshot, result, failure or PM transaction is fabricated.',
  'Outside file URLs are entered deliberately into the visible owned input. PNG decoding is tested, not arbitrary file content access or document-triggered automatic resource reading.',
  'Source snapshots use the installed source-mode menu and existing CodeMirror document. Mode changes destroy unconfirmed inputs, so snapshots run after all identity, history and held-result assertions for each case.',
  'Preview staleness after switching documents is tested separately from authorization snapshot invalidation: the old document remains open, making the destroyed NodeView guard necessary.',
  'File chooser uploads, unsaved-document first Save As, upload ordering and caption/resize history are not exercised by this URL-preview suite. Run the existing image/resource suites for App upload/history regression coverage, and verify the owned file control separately.',
  'No private Vue props/hooks, dependency code, CSP, protocol or filesystem authorization policy is changed. IPC registration and the additive native-history observer are restored before a successful report is written.',
  'The detached-image-already-decoded sizing branch, readonly UI, IME, external network content and platform-specific file dialogs need separate verification. Ordinary native sizing after real Enter confirmation is checked here.',
]

const cleanup = { fixtureDirectory: temporary, mainHandlerRestored: null, nativeObserverRemoved: null, applicationClosed: null, processExited: null, fixtureRemoved: false }

try {
  for (const directory of [documents, assetsA, assetsC, outside, artifacts]) await mkdir(directory, { recursive: true })
  for (const [owner, variant, directory, color] of [
    ['authorized-block', 'single', assetsA, [185, 40, 35]], ['authorized-inline', 'single', assetsA, [185, 40, 35]],
    ['input-history', 'a', assetsA, [185, 40, 35]], ['input-history', 'b', assetsA, [30, 65, 185]],
    ['confirm-undo', 'single', assetsA, [185, 40, 35]],
    ['preview-order', 'a', assetsA, [185, 40, 35]], ['preview-order', 'b', assetsA, [30, 65, 185]],
    ['confirm-order', 'a', assetsA, [185, 40, 35]], ['confirm-order', 'b', assetsA, [30, 65, 185]],
    ['root-order', 'a', assetsA, [185, 40, 35]], ['root-order', 'a', assetsC, [30, 160, 75]],
    ['disposed-preview', 'a', assetsA, [185, 40, 35]],
  ]) {
    const file = path.join(directory, caseImages[owner][variant])
    await writeFile(file, png(...color)); fixtureOwners.set(fixtureURL(file), owner)
  }
  await writeFile(outsideImage, png(170, 45, 140))
  for (const note of Object.values(notes)) await writeFile(note.path, note.markdown)
  phase = 'launch'
  const flags = ['--disable-gpu', '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? flags : [...flags, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text(), at: Date.now() }) })
  page.on('request', (request) => { if (request.resourceType() === 'image') imageRequests.push({ url: request.url(), at: Date.now() }) })
  page.on('requestfailed', (request) => { if (request.resourceType() === 'image') imageFailures.push({ url: request.url(), error: request.failure()?.errorText, at: Date.now() }) })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  const menu = (name) => application.evaluate(({ Menu, BrowserWindow }, name) => {
    const spec = {
      workspace: { labels: ['打开文件夹…', 'Open folder…'] },
      source: { accelerator: 'CmdOrCtrl+/', labels: ['源码模式', 'Source mode'] },
      preferences: { accelerator: 'CmdOrCtrl+,', labels: ['偏好设置…', 'Preferences…'] },
      undo: { accelerator: 'CmdOrCtrl+Z', labels: ['撤销', 'Undo'] },
      redo: { accelerator: 'CmdOrCtrl+Y', labels: ['重做', 'Redo'] },
    }[name]
    const items = []
    const visit = (menu) => menu?.items.forEach((item) => { items.push(item); if (item.submenu) visit(item.submenu) })
    visit(Menu.getApplicationMenu())
    const item = items.find((item) => item.visible && item.enabled && (spec.accelerator && item.accelerator === spec.accelerator || spec.labels.includes(item.label.replace(/&/g, ''))))
    if (!item || typeof item.click !== 'function') throw new Error(`Missing genuine installed menu: ${name}`)
    item.click(item, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], {})
    return { label: item.label, accelerator: item.accelerator }
  }, name)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').first().waitFor() }
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const model = () => page.evaluate(() => document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON())
  const input = () => page.locator('.ttypora-image-link-input .link-input-area')
  const open = async (name) => {
    const note = notes[name]
    await page.locator('.file-tree').getByTitle(note.path, { exact: true }).click()
    await page.waitForFunction((name) => document.title.includes(name), path.basename(note.path))
    await ready(); await input().waitFor({ state: 'visible' }); activePath = note.path
    assert.equal(imagesInModel(await model()).length, 1, 'Each case starts with one real image schema node')
  }
  const sourceSnapshot = async () => {
    await menu('source'); await page.locator('.source-editor .cm-content').waitFor(); await ready()
    const markdown = await page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString())
    await menu('source'); await page.locator('.ProseMirror').waitFor(); await ready()
    return markdown
  }
  const assertSourceAndFile = async (name, expected = notes[name].markdown) => {
    assert.equal(await sourceSnapshot(), expected, 'Actual App source Markdown must match the expected raw snapshot')
    assert.equal(await readFile(notes[name].path, 'utf8'), notes[name].markdown, 'Typing and preview must not change physical Markdown bytes')
  }
  const previewState = () => page.evaluate(() => {
    const input = document.querySelector('.ttypora-image-link-input .link-input-area')
    const image = document.querySelector('.ttypora-image-link-input .image-preview img')
    return { value: input?.value, focused: document.activeElement === input, from: input?.selectionStart, to: input?.selectionEnd, status: document.querySelector('.image-link-status')?.textContent,
      image: image ? { src: image.getAttribute('src'), currentSrc: image.currentSrc, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight } : null }
  })
  const waitPreview = (file) => page.waitForFunction((expected) => {
    const image = document.querySelector('.ttypora-image-link-input .image-preview img')
    const physical = (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href } catch { return '' } }
    return image && physical(image.getAttribute('src')) === expected && physical(image.currentSrc) === expected && image.complete && image.naturalWidth === 2 && image.naturalHeight === 2
  }, fixtureURL(file))
  const waitViewer = (file) => page.waitForFunction((expected) => {
    const image = document.querySelector('.ttypora-authorized-image-host img[data-type="image-block"]')
    const physical = (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href } catch { return '' } }
    return image && physical(image.getAttribute('src')) === expected && physical(image.currentSrc) === expected && image.complete && image.naturalWidth === 2 && image.naturalHeight === 2
  }, fixtureURL(file))
  const captureIdentity = (key) => page.evaluate((key) => {
    const input = document.querySelector('.ttypora-image-link-input .link-input-area'), outer = input?.closest('.ttypora-localized-image-view'), prose = document.querySelector('.ProseMirror')
    if (!input || !outer?.pmViewDesc || !prose?.pmViewDesc) throw new Error('Missing real owned input and PM NodeView descriptors')
    window.__imagePreviewSmokeIdentities ??= {}
    window.__imagePreviewSmokeIdentities[key] = { input, outer, prose, outerDesc: outer.pmViewDesc, proseDesc: prose.pmViewDesc, preview: outer.querySelector('.image-preview img') }
  }, key)
  const identity = (key) => page.evaluate((key) => {
    const saved = window.__imagePreviewSmokeIdentities[key]
    return { sameInput: saved.input === document.querySelector('.ttypora-image-link-input .link-input-area') && saved.input.isConnected,
      sameOuter: saved.outer === document.querySelector('.ttypora-localized-image-view') && saved.outer.isConnected && saved.outerDesc === saved.outer.pmViewDesc,
      sameProse: saved.prose === document.querySelector('.ProseMirror') && saved.proseDesc === saved.prose.pmViewDesc,
      from: saved.input.selectionStart, to: saved.input.selectionEnd, value: saved.input.value, inputConnected: saved.input.isConnected, outerConnected: saved.outer.isConnected }
  }, key)
  const assertIdentity = async (key) => { const value = await identity(key); assert.equal(value.sameInput, true); assert.equal(value.sameOuter, true); assert.equal(value.sameProse, true); return value }
  const typeLink = async (raw, atomic = false) => {
    const eventFirst = await page.evaluate(() => window.__imagePreviewSmokeEvents.length)
    // Individual real keystrokes also expose accidental raw requests for partial
    // URL values. Collect their browser resolutions without fetching any URL.
    for (const candidate of await page.evaluate((raw) => {
      const values = []
      for (let length = 1; length <= raw.length; length++) { try { values.push(new URL(raw.slice(0, length), document.baseURI).href) } catch { /* Invalid URL prefixes cannot request an image. */ } }
      return values
    }, raw)) rawCandidates.add(candidate)
    if (!await input().inputValue()) await page.locator('.ttypora-image-link-input .placeholder .text').click()
    else await input().click()
    assert.equal(await input().evaluate((element) => element.ownerDocument.activeElement === element), true, 'The visible link hint must focus its actual input')
    await input().press('Control+a')
    // Atomic insertion is used only for history's two replacement operations.
    // Ordinary per-character typing has native character-level undo boundaries.
    if (atomic) await page.keyboard.insertText(raw)
    else await page.keyboard.type(raw, { delay: 1 })
    await frames()
    assert.equal(await input().inputValue(), raw)
    assert.ok(await page.evaluate(({ raw, eventFirst }) => window.__imagePreviewSmokeEvents.slice(eventFirst).some((event) => event.type === 'input' && event.trusted && event.value === raw), { raw, eventFirst }), 'Link value must come from a fresh genuine browser input event')
  }
  const assertNoRawRequests = () => {
    const raw = imageRequests.filter((request) => rawCandidates.has(request.url))
    const forbidden = imageRequests.filter((request) => physicalURL(request.url) === fixtureURL(outsideImage))
    assert.deepEqual(raw, [], 'No raw user URL or renderer-relative image request may occur')
    assert.deepEqual(forbidden, [], 'The deliberately entered outside PNG must never reach the browser image loader')
  }
  const clickBody = () => page.locator('.ProseMirror p').filter({ hasText: 'Body stays bold with literal code and a link.' }).first().click()

  await ready()
  await application.evaluate(({ ipcMain }) => {
    const channel = 'image:resolve-url', original = ipcMain._invokeHandlers?.get(channel)
    if (typeof original !== 'function') throw new Error('Missing genuine registered image resolver')
    const control = { channel, original, records: [], pending: [], hold: null, nativeCommands: [], restored: false }
    control.observeNative = (_event, direction) => control.nativeCommands.push({ direction, at: Date.now() })
    ipcMain.on('edit:native-history', control.observeNative)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      const [snapshot, source] = args
      const record = { index: control.records.length, source, snapshot: snapshot && typeof snapshot === 'object' ? { ...snapshot } : snapshot, startedAt: Date.now(), completed: false, delivered: false, held: false }
      control.records.push(record)
      let result
      try { result = await original(event, ...args); record.result = result; record.completed = true; record.completedAt = Date.now() }
      catch (error) { record.error = String(error); record.completed = record.delivered = true; record.completedAt = record.deliveredAt = Date.now(); throw error }
      const hold = control.hold
      if (hold && hold.source === source && (!hold.documentPath || hold.documentPath === snapshot?.documentPath) && (!hold.rootLine || snapshot?.markdown?.includes(hold.rootLine))) {
        record.held = true
        await new Promise((resolve) => control.pending.push({ index: record.index, resolve }))
      }
      record.delivered = true; record.deliveredAt = Date.now()
      return result
    })
    globalThis.__imagePreviewSmokeControl = control
  })
  await page.evaluate(() => {
    window.__imagePreviewSmokeEvents = []
    const observe = (event) => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.matches('.ttypora-image-link-input .link-input-area')) return
      window.__imagePreviewSmokeEvents.push({ type: event.type, key: event.key, ctrlKey: event.ctrlKey, trusted: event.isTrusted, value: event.target.value, from: event.target.selectionStart, to: event.target.selectionEnd, at: performance.now() })
    }
    document.addEventListener('input', observe, true); document.addEventListener('keydown', observe, true)
    window.__removeImagePreviewSmokeObserver = () => { document.removeEventListener('input', observe, true); document.removeEventListener('keydown', observe, true) }
  })
  const records = () => application.evaluate(() => globalThis.__imagePreviewSmokeControl.records)
  const nativeCommands = () => application.evaluate(() => globalThis.__imagePreviewSmokeControl.nativeCommands)
  const arm = (hold) => application.evaluate((_electron, hold) => { globalThis.__imagePreviewSmokeControl.hold = hold }, hold)
  const release = () => application.evaluate(() => { const control = globalThis.__imagePreviewSmokeControl; control.hold = null; control.pending.splice(0).forEach(({ resolve }) => resolve()) })
  const waitMain = async (predicate, message) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) { const entries = await records(); if (predicate(entries)) return entries; await frames() }
    throw new Error(message)
  }
  const waitHeld = async (first, source, documentPath, rootLine) => {
    const entries = await waitMain((entries) => entries.slice(first).some((entry) => entry.source === source && entry.snapshot?.documentPath === documentPath && (!rootLine || entry.snapshot?.markdown?.includes(rootLine)) && entry.completed && !entry.error && entry.held && !entry.delivered), 'Real successful main result never reached the delivery hold')
    return entries.slice(first).filter((entry) => entry.source === source && entry.completed && entry.held && !entry.delivered)
  }
  const releaseAndDrain = async (held) => {
    await release()
    await waitMain((entries) => held.every((entry) => entries[entry.index]?.delivered), 'Previously held genuine results did not release')
    // This is observation time, not a changed product timer or fake completion.
    await page.waitForTimeout(350); await frames()
  }
  const requireResult = (entries, first, source, note, expectedFile, expectedMarkdown = notes[note].markdown) => {
    const matching = entries.slice(first).filter((entry) => entry.source === source && entry.snapshot?.documentPath === notes[note].path && entry.snapshot?.markdown === expectedMarkdown && entry.completed && entry.delivered && !entry.error && physicalURL(entry.result) === fixtureURL(expectedFile))
    assert.ok(matching.length, 'Preview must use a genuine successful resolver result and the actual raw document snapshot')
    return matching
  }

  await menu('workspace')
  phase = '1: authorized root relative preview before confirmation'
  {
    const authorized = []
    for (const name of ['authorized-block', 'authorized-inline']) {
      const cover = caseImages[name].single
      await open(name); const baseline = await model(), first = (await records()).length
      assert.equal(imagesInModel(baseline)[0].attrs.src, '')
      assert.equal(imagesInModel(baseline)[0].type, name === 'authorized-inline' ? 'image' : 'image-block')
      await typeLink(cover); await waitPreview(path.join(assetsA, cover))
      const state = await previewState(), entries = await records()
      const ipc = requireResult(entries, first, cover, name, path.join(assetsA, cover))
      assert.deepEqual(await model(), baseline); assertNoRawRequests()
      assert.equal(await page.locator('.ttypora-authorized-image-host img').count(), 0, 'Native blank ImageInput must stay detached before confirmation')
      await assertSourceAndFile(name)
      authorized.push({ kind: name, state, ipc, unchangedPM: true, unchangedSource: true, unchangedFile: true })
    }
    check('Block and inline relative previews decode only authorized root PNGs through real main IPC before confirmation, preserving PM/source/file', { cases: authorized })
  }

  phase = '2: explicit outside file URL and missing relative URL'
  {
    const denied = []
    for (const [name, raw] of [['outside-file-url', fixtureURL(outsideImage)], ['missing-relative', 'preview-missing.png']]) {
      await open(name); const baseline = await model(), first = (await records()).length
      await typeLink(raw)
      const entries = await waitMain((entries) => entries.slice(first).some((entry) => entry.source === raw && entry.completed && entry.error), 'The genuine registered main resolver must reject the fixture')
      await page.waitForFunction(() => /not authorized|没有得到授权/.test(document.querySelector('.image-link-status')?.textContent ?? ''))
      const state = await previewState()
      assert.equal(state.image.src, null); assert.equal(state.image.naturalWidth, 0)
      assert.deepEqual(await model(), baseline); assertNoRawRequests()
      assert.equal(await page.locator('.ttypora-authorized-image-host img').count(), 0)
      await assertSourceAndFile(name)
      denied.push({ source: raw, state, ipc: entries.slice(first), actualRejection: true })
    }
    check('Deliberately typed outside file URL and missing relative URL really reject in main without a raw browser image request or document edit', { cases: denied })
  }

  phase = '3: actual input Ctrl+Z, locale identity/selection and focused native menu history'
  {
    const coverA = caseImages['input-history'].a, coverB = caseImages['input-history'].b
    await open('input-history'); const historyBaseline = await model()
    await captureIdentity('history')
    await typeLink(coverA, true); await waitPreview(path.join(assetsA, coverA))
    await typeLink(coverB, true); await waitPreview(path.join(assetsA, coverB))
    await input().press('Control+z'); await page.waitForFunction((expected) => document.querySelector('.ttypora-image-link-input .link-input-area')?.value === expected, coverA)
    await waitPreview(path.join(assetsA, coverA)); await assertIdentity('history'); assert.deepEqual(await model(), historyBaseline)
    await input().press('Control+y'); await page.waitForFunction((expected) => document.querySelector('.ttypora-image-link-input .link-input-area')?.value === expected, coverB)
    await waitPreview(path.join(assetsA, coverB))
    await input().press('Home'); for (let step = 0; step < 5; step++) await input().press('Shift+ArrowRight')
    const beforeLocale = await assertIdentity('history')
    assert.equal(beforeLocale.from, 0); assert.equal(beforeLocale.to, 5)
    const fromLocale = await page.evaluate(() => document.documentElement.lang), toLocale = fromLocale === 'en' ? 'zh-CN' : 'en'
    await menu('preferences'); await page.locator('.preferences fieldset').first().locator('select').selectOption(toLocale)
    await page.waitForFunction((locale) => document.documentElement.lang === locale, toLocale)
    await page.getByRole('dialog').getByRole('button', { name: toLocale === 'en' ? 'Done' : '完成', exact: true }).click()
    const afterLocale = await assertIdentity('history')
    assert.equal(afterLocale.value, coverB); assert.equal(afterLocale.from, 0); assert.equal(afterLocale.to, 5)
    assert.equal(await page.locator('.ttypora-image-link-input .confirm').textContent(), toLocale === 'en' ? 'Confirm' : '确认')
    await input().click(); const nativeFirst = (await nativeCommands()).length
    const nativeUndo = await menu('undo')
    await page.waitForFunction((expected) => document.querySelector('.ttypora-image-link-input .link-input-area')?.value === expected, coverA)
    await waitPreview(path.join(assetsA, coverA)); assert.deepEqual(await model(), historyBaseline)
    const nativeRedo = await menu('redo')
    await page.waitForFunction((expected) => document.querySelector('.ttypora-image-link-input .link-input-area')?.value === expected, coverB)
    await waitPreview(path.join(assetsA, coverB)); await assertIdentity('history'); assert.deepEqual(await model(), historyBaseline)
    assert.deepEqual((await nativeCommands()).slice(nativeFirst).map((entry) => entry.direction), ['undo', 'redo'])
    assert.ok(await page.evaluate(() => window.__imagePreviewSmokeEvents.some((event) => event.type === 'keydown' && event.trusted && event.ctrlKey && event.key.toLowerCase() === 'z')))
    assertNoRawRequests(); await assertSourceAndFile('input-history')
    check('Real keyboard Undo/Redo and focused native menu Undo/Redo preserve two atomic owned input replacements through actual Preferences locale change, with same DOM/selection and unchanged PM', { fromLocale, toLocale, beforeLocale, afterLocale, nativeUndo, nativeRedo, nativeDirections: ['undo', 'redo'], historyInput: 'Two browser insertText replacement operations with genuine input events; not per-character typing undo grouping' })
  }

  phase = '4: real Enter confirmation and shared document Undo'
  {
    const cover = caseImages['confirm-undo'].single
    await open('confirm-undo'); const confirmBaseline = await model()
    await typeLink(cover); await waitPreview(path.join(assetsA, cover)); assert.deepEqual(await model(), confirmBaseline)
    await input().press('Enter'); await waitViewer(path.join(assetsA, cover))
    assert.deepEqual(await model(), changeOnlySource(confirmBaseline, cover))
    await page.waitForFunction(() => { const image = document.querySelector('.ttypora-authorized-image-host img[data-type="image-block"]'); return Number(image?.dataset.origin) > 0 && Number(image?.dataset.height) > 0 })
    const nativeDisplay = await page.evaluate(() => { const image = document.querySelector('.ttypora-authorized-image-host img[data-type="image-block"]'); return { src: image.getAttribute('src'), currentSrc: image.currentSrc, connected: image.isConnected, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, origin: image.dataset.origin, height: image.dataset.height, styleHeight: image.style.height } })
    const confirmedMarkdown = notes['confirm-undo'].markdown.replace('![]()', `![](${cover})`)
    await assertSourceAndFile('confirm-undo', confirmedMarkdown)
    await clickBody(); const beforeSharedUndo = (await nativeCommands()).length
    const sharedUndo = await menu('undo')
    await page.waitForFunction(() => { const root = document.querySelector('.ProseMirror'); let source; root?.pmViewDesc?.node.descendants((node) => { if (node.type.name === 'image-block') source = node.attrs.src }); return source === '' })
    assert.deepEqual(await model(), confirmBaseline); assert.equal((await nativeCommands()).length, beforeSharedUndo, 'Body-focused Undo must use shared document history')
    await assertSourceAndFile('confirm-undo'); assertNoRawRequests()
    check('Actual Enter changes only Markdown raw src and connects/sizes the genuine native viewer; genuine body-focused menu Undo restores the complete PM/source snapshot', { confirmedMarkdown, nativeDisplay, sharedUndo, undoScope: 'shared document history' })
  }

  phase = '5: genuine A preview result held while B preview wins'
  {
    const coverA = caseImages['preview-order'].a, coverB = caseImages['preview-order'].b
    await open('preview-order'); const previewBaseline = await model(), previewFirst = (await records()).length
    const requestFirst = imageRequests.length
    await captureIdentity('preview-order'); await arm({ source: coverA, documentPath: notes['preview-order'].path })
    await typeLink(coverA); const previewHeld = await waitHeld(previewFirst, coverA, notes['preview-order'].path)
    await typeLink(coverB); await waitPreview(path.join(assetsA, coverB)); await assertIdentity('preview-order')
    requireResult(await records(), previewFirst, coverB, 'preview-order', path.join(assetsA, coverB))
    assert.deepEqual(await model(), previewBaseline)
    await releaseAndDrain(previewHeld); await waitPreview(path.join(assetsA, coverB)); const previewIdentity = await assertIdentity('preview-order')
    assert.equal(previewIdentity.value, coverB); assert.deepEqual(await model(), previewBaseline)
    assert.equal(imageRequests.slice(requestFirst).some((entry) => physicalURL(entry.url) === fixtureURL(path.join(assetsA, coverA))), false, 'Held unconfirmed A result must never reach an image setter after B')
    assertNoRawRequests(); await assertSourceAndFile('preview-order')
    check('A really authorizes before its delivery is held; later B preview decodes in the same owned input and released A cannot replace it or write PM/Markdown', { held: previewHeld, finalIdentity: previewIdentity, ipc: (await records()).slice(previewFirst) })
  }

  phase = '6: same outer NodeView confirms held A then visible B'
  {
    const coverA = caseImages['confirm-order'].a, coverB = caseImages['confirm-order'].b
    await open('confirm-order'); const orderBaseline = await model(), orderFirst = (await records()).length
    const requestFirst = imageRequests.length
    await captureIdentity('confirm-order'); await arm({ source: coverA, documentPath: notes['confirm-order'].path })
    await typeLink(coverA); await page.locator('.ttypora-image-link-input .confirm').click()
    const orderHeld = await waitHeld(orderFirst, coverA, notes['confirm-order'].path)
    assert.deepEqual(await model(), changeOnlySource(orderBaseline, coverA)); await assertIdentity('confirm-order')
    assert.equal(await input().isVisible(), true, 'Held A must retain the same visible editable owned controller')
    await typeLink(coverB); await page.locator('.ttypora-image-link-input .confirm').click(); await waitViewer(path.join(assetsA, coverB))
    assert.deepEqual(await model(), changeOnlySource(orderBaseline, coverB)); await assertIdentity('confirm-order')
    await page.evaluate(() => { window.__imagePreviewSmokeNativeB = document.querySelector('.ttypora-authorized-image-host > .milkdown-image-block') })
    const beforeOrderRelease = await records()
    assert.ok(beforeOrderRelease.slice(orderFirst).some((entry) => entry.source === coverB && entry.delivered && !entry.error && physicalURL(entry.result) === fixtureURL(path.join(assetsA, coverB))))
    await releaseAndDrain(orderHeld); await waitViewer(path.join(assetsA, coverB)); await assertIdentity('confirm-order')
    assert.equal(await page.evaluate(() => window.__imagePreviewSmokeNativeB?.isConnected && window.__imagePreviewSmokeNativeB === document.querySelector('.ttypora-authorized-image-host > .milkdown-image-block')), true)
    assert.deepEqual(await model(), changeOnlySource(orderBaseline, coverB))
    assert.equal(imageRequests.slice(requestFirst).some((entry) => physicalURL(entry.url) === fixtureURL(path.join(assetsA, coverA))), false, 'Late held confirmed A must never issue even a transient image request after B wins')
    await assertSourceAndFile('confirm-order', notes['confirm-order'].markdown.replace('![]()', `![](${coverB})`)); assertNoRawRequests()
    check('The same owned controller/outer PM NodeView really confirms A then B; genuine native B viewer remains identical after late real A delivery', { held: orderHeld, nativeIdentityScope: 'B viewer identity from its first authorized attachment through late A delivery', ipc: (await records()).slice(orderFirst) })
  }

  phase = '7: unconfirmed draft survives native YAML root change while old root A is held'
  {
    const coverA = caseImages['root-order'].a
    await open('root-order'); const rootBaseline = await model(), rootFirst = (await records()).length
    const requestFirst = imageRequests.length
    await captureIdentity('root-order'); await arm({ source: coverA, documentPath: notes['root-order'].path, rootLine: 'typora-root-url: ../assetsA' })
    await typeLink(coverA); const rootHeld = await waitHeld(rootFirst, coverA, notes['root-order'].path, 'typora-root-url: ../assetsA')
    const yaml = page.locator('.front-matter-source'), text = await yaml.textContent(), match = text.match(/^typora-root-url: ([^\r\n]+)$/m)
    assert.ok(match); const suffixEnd = match.index + match[0].length, previous = match[1]
    assert.match(text.slice(0, suffixEnd), /^[\x00-\x7f]*$/)
    const caret = () => yaml.evaluate((pre) => {
      const selection = window.getSelection(), anchor = selection?.anchorNode, inPre = Boolean(anchor && pre.contains(anchor))
      let offset = -1
      if (inPre && selection.isCollapsed) { const range = document.createRange(); range.selectNodeContents(pre); range.setEnd(anchor, selection.anchorOffset); offset = range.toString().length }
      return { inPre, offset }
    })
    await yaml.click(); await page.keyboard.press('Control+Home'); let position = await caret()
    for (let step = 0; !position.inPre && step < 8; step++) { await page.keyboard.press('ArrowRight'); position = await caret() }
    if (!position.inPre) {
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); position = await caret()
      for (let step = 0; !position.inPre && step < 8; step++) { await page.keyboard.press('ArrowRight'); position = await caret() }
    }
    assert.ok(position.inPre && position.offset >= 0 && position.offset <= suffixEnd, 'Native keys must enter the real YAML before the root suffix')
    for (let step = 0; position.offset < suffixEnd && step < text.length + 16; step++) { await page.keyboard.press('ArrowRight'); position = await caret() }
    assert.equal(position.offset, suffixEnd)
    for (let step = 0; step < previous.length; step++) await page.keyboard.press('Shift+ArrowLeft')
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), previous)
    await page.keyboard.insertText('../assetsC')
    await page.waitForFunction(() => document.querySelector('.front-matter-source')?.textContent?.includes('typora-root-url: ../assetsC'))
    await waitPreview(path.join(assetsC, coverA)); await assertIdentity('root-order')
    const rootMarkdown = notes['root-order'].markdown.replace('../assetsA', '../assetsC')
    requireResult(await records(), rootFirst, coverA, 'root-order', path.join(assetsC, coverA), rootMarkdown)
    await releaseAndDrain(rootHeld); await waitPreview(path.join(assetsC, coverA)); const rootIdentity = await assertIdentity('root-order')
    assert.equal(rootIdentity.value, coverA)
    assert.deepEqual((await model()).content.filter((node) => node.type !== 'front_matter'), rootBaseline.content.filter((node) => node.type !== 'front_matter'))
    assert.equal(imageRequests.slice(requestFirst).some((entry) => physicalURL(entry.url) === fixtureURL(path.join(assetsA, coverA))), false)
    assertNoRawRequests(); await assertSourceAndFile('root-order', rootMarkdown)
    check('Real YAML resource-root edit keeps the unconfirmed input/body; genuine new-root preview wins and late old-root success cannot assign an image URL', { held: rootHeld, rootIdentity, rootMarkdown, ipc: (await records()).slice(rootFirst) })
  }

  phase = '8: release genuine preview after its NodeView is disposed by switching document'
  {
    const coverA = caseImages['disposed-preview'].a
    await open('disposed-preview'); const disposedBaseline = await model(), disposedFirst = (await records()).length
    const requestFirst = imageRequests.length
    await captureIdentity('disposed'); await arm({ source: coverA, documentPath: notes['disposed-preview'].path })
    await typeLink(coverA); const disposedHeld = await waitHeld(disposedFirst, coverA, notes['disposed-preview'].path)
    assert.deepEqual(await model(), disposedBaseline)
    await open('disposal-target'); const targetBaseline = await model()
    const beforeDisposeRelease = await identity('disposed')
    assert.equal(beforeDisposeRelease.inputConnected, false); assert.equal(beforeDisposeRelease.outerConnected, false)
    await releaseAndDrain(disposedHeld)
    assert.deepEqual(await model(), targetBaseline); assert.equal(await input().inputValue(), '')
    const oldState = await page.evaluate(() => { const old = window.__imagePreviewSmokeIdentities.disposed; return { connected: old.input.isConnected, src: old.preview.getAttribute('src'), naturalWidth: old.preview.naturalWidth } })
    assert.equal(oldState.connected, false); assert.equal(oldState.src, null); assert.equal(oldState.naturalWidth, 0)
    assert.equal(imageRequests.slice(requestFirst).some((entry) => physicalURL(entry.url) === fixtureURL(path.join(assetsA, coverA))), false)
    await assertSourceAndFile('disposal-target'); await open('disposed-preview')
    assert.deepEqual(await model(), disposedBaseline); await assertSourceAndFile('disposed-preview'); assertNoRawRequests()
    check('Switching to another real document disposes the pending preview; late successful old result changes neither detached image nor new document, and old raw draft was never committed', { held: disposedHeld, beforeDisposeRelease, oldState, ipc: (await records()).slice(disposedFirst) })
  }

  phase = 'final genuine-result audit and original IPC handler restoration'
  assert.equal(checks.length, 8); assert.deepEqual(pageErrors, []); assertNoRawRequests()
  observedIPC = await waitMain((entries) => entries.every((entry) => entry.completed && entry.delivered), 'All real resolver requests must settle before handler restoration')
  observedNativeCommands = await nativeCommands()
  const fixtureRequests = imageRequests.filter((entry) => fixtureOwners.has(physicalURL(entry.url)))
  for (const request of fixtureRequests) {
    const owner = fixtureOwners.get(physicalURL(request.url))
    assert.ok(observedIPC.some((entry) => entry.snapshot?.documentPath === notes[owner].path && entry.completed && entry.delivered && !entry.error && entry.result === request.url && entry.deliveredAt <= request.at), 'Each browser fixture request must follow its case document genuine successful main result')
  }
  assert.ok(fixtureRequests.length, 'Actual browser image requests must be observed; an empty request log cannot prove raw-request prevention')
  originalHandlerRestored = await application.evaluate(({ ipcMain }) => {
    const control = globalThis.__imagePreviewSmokeControl
    control.hold = null; control.pending.splice(0).forEach(({ resolve }) => resolve())
    ipcMain.removeHandler(control.channel); ipcMain.handle(control.channel, control.original)
    ipcMain.removeListener('edit:native-history', control.observeNative); control.restored = true
    return { sameIdentity: ipcMain._invokeHandlers?.get(control.channel) === control.original, nativeObserverRemoved: !ipcMain.listeners('edit:native-history').includes(control.observeNative) }
  })
  assert.equal(originalHandlerRestored.sameIdentity, true); assert.equal(originalHandlerRestored.nativeObserverRemoved, true)
  cleanup.mainHandlerRestored = true; cleanup.nativeObserverRemoved = true
  report = { variant: packaged ? 'packaged' : 'source', prefix, version: await application.evaluate(({ app }) => app.getVersion()), completedAt: new Date().toISOString(),
    interaction: 'Genuine native keyboard and owned inputs, installed Electron source/preferences/undo/redo menu callbacks, actual PM and CodeMirror read-only inspection, real YAML keyboard edit, original main resolver observed with successful-result delivery holds',
    checks, exclusions, originalHandlerRestored, imageRequests, imageFailures, rawCandidates: [...rawCandidates], rawBrowserRequestCount: 0, pageErrors, consoleMessages, inputEvents: await page.evaluate(() => window.__imagePreviewSmokeEvents), nativeHistoryCommands: observedNativeCommands, ipc: observedIPC }
} catch (error) {
  let diagnostic = { unavailable: true }
  if (page && !page.isClosed()) {
    diagnostic = await page.evaluate(() => ({ body: document.body.innerText, lang: document.documentElement.lang, baseURI: document.baseURI, model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(),
      images: [...document.querySelectorAll('.ttypora-localized-image-view img')].map((image) => ({ src: image.getAttribute('src'), currentSrc: image.currentSrc, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, origin: image.dataset.origin, height: image.dataset.height })),
      inputs: [...document.querySelectorAll('.ttypora-localized-image-view input')].map((input) => ({ className: input.className, value: input.value, focused: document.activeElement === input, from: input.selectionStart, to: input.selectionEnd })), events: window.__imagePreviewSmokeEvents ?? [], yaml: document.querySelector('.front-matter-source')?.textContent, selection: window.getSelection()?.toString() })).catch(() => diagnostic)
    await page.screenshot({ path: artifact('failure.png'), animations: 'disabled', timeout: 60000 }).catch(() => undefined)
  }
  await mkdir(artifacts, { recursive: true })
  await writeFile(artifact('failure.json'), JSON.stringify({ phase, activePath, error: String(error), stack: error?.stack, prefix, checks, exclusions, diagnostic, pageErrors, consoleMessages, imageRequests, imageFailures, rawCandidates: [...rawCandidates], ipc: application ? await application.evaluate(() => globalThis.__imagePreviewSmokeControl?.records ?? []).catch(() => []) : [] }, null, 2) + '\n')
  process.exitCode = 1
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.__removeImagePreviewSmokeObserver?.()).catch(() => undefined)
  if (application) {
    const restore = await application.evaluate(({ ipcMain }) => {
      const control = globalThis.__imagePreviewSmokeControl
      if (!control) return { sameIdentity: null, nativeObserverRemoved: null }
      control.hold = null; control.pending.splice(0).forEach(({ resolve }) => resolve())
      if (!control.restored) { ipcMain.removeHandler(control.channel); ipcMain.handle(control.channel, control.original); control.restored = true }
      ipcMain.removeListener('edit:native-history', control.observeNative)
      return { sameIdentity: ipcMain._invokeHandlers?.get(control.channel) === control.original, nativeObserverRemoved: !ipcMain.listeners('edit:native-history').includes(control.observeNative) }
    }).catch((error) => ({ sameIdentity: String(error), nativeObserverRemoved: false }))
    cleanup.mainHandlerRestored = restore.sameIdentity; cleanup.nativeObserverRemoved = restore.nativeObserverRemoved
    if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
    const child = application.process()
    let closeTimer
    cleanup.applicationClosed = await Promise.race([
      application.close().then(() => true, (error) => String(error)),
      new Promise((resolve) => { closeTimer = setTimeout(() => resolve('Application close exceeded 15 seconds'), 15000) }),
    ])
    clearTimeout(closeTimer)
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await new Promise((resolve) => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
    cleanup.processExited = Boolean(child && (child.exitCode !== null || child.signalCode !== null))
  }
  try {
    if (application) assert.equal(cleanup.processExited, true, 'Refusing fixture cleanup while the isolated application process may still be running')
    const actualTemporary = await realpath(temporary), actualParent = await realpath(tmpdir())
    const relative = path.relative(actualParent, actualTemporary)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.' && path.basename(actualTemporary).startsWith('ttypora-image-input-smoke-'), 'Refusing cleanup outside the exact newly created fixture directory')
    await rm(actualTemporary, { recursive: true, force: true }); cleanup.fixtureRemoved = !existsSync(actualTemporary)
    assert.equal(cleanup.fixtureRemoved, true)
  } catch (error) { cleanup.fixtureError = String(error); process.exitCode = 1 }
  if (application && (cleanup.mainHandlerRestored !== true || cleanup.nativeObserverRemoved !== true || cleanup.applicationClosed !== true || cleanup.processExited !== true)) process.exitCode = 1
  await mkdir(artifacts, { recursive: true }); await writeFile(artifact('cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n')
}
// The success report is intentionally last: handler identity, listener removal,
// process exit and exact fixture cleanup must already be verified.
if (report && process.exitCode !== 1) {
  await writeFile(artifact('verification.json'), JSON.stringify({ ...report, cleanup }, null, 2) + '\n')
  console.log(`PASS all ${checks.length} image input preview groups; handler restored and isolated process/fixtures cleaned`)
}
