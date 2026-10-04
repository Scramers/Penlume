import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { _electron as electron } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packaged = process.env.TTYPORA_PACKAGED_EXE
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v${version}-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'), 'Invalid artifact prefix')
const artifacts = path.join(root, 'artifacts'), artifact = (suffix) => path.join(artifacts, `image-binding-${prefix}-${suffix}`)
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-image-binding-'))
const workspace = path.join(temporary, 'notes'), documents = path.join(workspace, 'docs')
const assetsA = path.join(workspace, 'assetsA'), assetsC = path.join(workspace, 'assetsC'), outside = path.join(temporary, 'outside')
const rootNote = path.join(documents, 'root-failure.md'), blankNote = path.join(documents, 'same-node.md')
const captionNotes = [1, 2, 3].map((attempt) => path.join(documents, `caption-deadline-${attempt}.md`))
const body = '# Image binding\n\nBody stays **bold** with `literal code` and [a link](https://example.invalid/).\n\n![Binding alt](cover.png "Original caption")\n\nTail remains unchanged.\n'
const rooted = (value) => `---\ntitle: Image binding\ntypora-root-url: ${value}\n---\n\n${body}`
const originalRoot = rooted('../assetsA')
const originalBlank = '# Same node\n\nBody stays **bold**.\n\n![]()\n\nTail remains unchanged.\n'
const originalCaption = '# Caption lifecycle\n\nBody stays **bold**.\n\n![Caption alt](coverB.png "Original caption")\n\nTail remains unchanged.\n'

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
function png(red, green, blue) {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), result = Buffer.alloc(bytes.length + 12)
    result.writeUInt32BE(bytes.length); type.copy(result, 4); bytes.copy(result, 8)
    result.writeUInt32BE(crc32(Buffer.concat([type, bytes])), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2
  const row = Buffer.from([0, red, green, blue, red, green, blue])
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))])
}
const bytesA = png(195, 40, 30), bytesB = png(30, 65, 195)
for (const directory of [documents, assetsA, assetsC, outside, artifacts]) await mkdir(directory, { recursive: true })
await writeFile(path.join(assetsA, 'cover.png'), bytesA)
await writeFile(path.join(outside, 'cover.png'), bytesA)
await writeFile(path.join(documents, 'coverA.png'), bytesA)
await writeFile(path.join(documents, 'coverB.png'), bytesB)
await writeFile(rootNote, originalRoot); await writeFile(blankNote, originalBlank)
for (const note of captionNotes) await writeFile(note, originalCaption)

let application, page, phase = 'launch', activePath = null
const checks = [], pageErrors = [], consoleMessages = [], imageRequests = [], timingAttempts = []
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`) }
const exclusions = [
  'The resolver wrapper invokes the original registered main IPC handler. It observes failures and delays only delivery of genuine successful coverA.png results; no URL/result is fabricated.',
  'Locale coverage records native input/blur times. Opening Preferences can naturally cancel First through blur; this suite does not claim a cancelled timer actually fired, and never changes the native 1000ms timer.',
  'Timing-only retries use separate fresh documents and are reported as inconclusive attempts. Functional assertion failures are never retried.',
  'Network uploads, image file chooser insertion, Save As/closed-tab races, IME and other platform paths are outside these three cases.',
]

try {
  const flags = ['--disable-gpu', '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? flags : [...flags, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() }) })
  page.on('request', (request) => { if (/cover(?:[AB])?\.png/i.test(request.url())) imageRequests.push({ url: request.url(), at: Date.now() }) })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  // Invoke genuine installed Electron menu callbacks, rather than dispatching
  // editor transactions or manufacturing app-command events in the renderer.
  const menu = (name) => application.evaluate(({ Menu, BrowserWindow }, name) => {
    const spec = {
      workspace: { labels: ['打开文件夹…', 'Open folder…'] },
      preferences: { accelerator: 'CmdOrCtrl+,', labels: ['偏好设置…', 'Preferences…'] },
      undo: { accelerator: 'CmdOrCtrl+Z', labels: ['撤销', 'Undo'] },
    }[name]
    const items = []
    const visit = (menu) => menu?.items.forEach((item) => { items.push(item); if (item.submenu) visit(item.submenu) })
    visit(Menu.getApplicationMenu())
    const item = items.find((item) => item.visible && item.enabled && (spec.accelerator && item.accelerator === spec.accelerator || spec.labels.includes(item.label.replace(/&/g, ''))))
    if (!item || typeof item.click !== 'function') throw new Error(`Missing actual application menu action: ${name}`)
    item.click(item, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], {})
    return { label: item.label, accelerator: item.accelerator }
  }, name)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror').waitFor() }
  const model = () => page.evaluate(() => document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON())
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const open = async (note) => { await page.locator('.file-tree').getByTitle(note, { exact: true }).click(); await page.waitForFunction((name) => document.title.includes(name), path.basename(note)); await ready(); activePath = note }
  const imageURL = (file) => pathToFileURL(file).href
  // The real resolver adds a file-version query for Chromium cache invalidation.
  // Compare the physical file URL while retaining its full returned URL in IPC logs.
  const withoutURLMetadata = (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href } catch { return '' } }
  const waitImage = (file) => page.waitForFunction((expected) => { const physical = (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href } catch { return '' } }; const image = document.querySelector('.milkdown-image-block img[data-type="image-block"]'); return image && physical(image.getAttribute('src')) === expected && physical(image.currentSrc) === expected && image.complete && image.naturalWidth === 2 }, imageURL(file))

  await ready()
  await application.evaluate(({ ipcMain }) => {
    const channel = 'image:resolve-url', original = ipcMain._invokeHandlers?.get(channel)
    if (typeof original !== 'function') throw new Error('Missing real image:resolve-url handler')
    const control = { channel, original, records: [], pending: [], holdSource: null }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, snapshot, source) => {
      const record = { index: control.records.length, source, snapshot: snapshot && typeof snapshot === 'object' ? { ...snapshot } : snapshot, startedAt: Date.now(), completed: false, delivered: false, held: false }
      control.records.push(record)
      let result
      try { result = await original(event, snapshot, source); record.result = result; record.completed = true; record.completedAt = Date.now() }
      catch (error) { record.completed = true; record.delivered = true; record.error = String(error); record.completedAt = record.deliveredAt = Date.now(); throw error }
      if (control.holdSource === source) {
        record.held = true
        await new Promise((resolve) => control.pending.push({ index: record.index, resolve }))
      }
      record.delivered = true; record.deliveredAt = Date.now()
      return result
    })
    globalThis.__imageBindingControl = control
  })
  const records = () => application.evaluate(() => globalThis.__imageBindingControl.records)
  const release = () => application.evaluate(() => { const control = globalThis.__imageBindingControl; control.holdSource = null; control.pending.splice(0).forEach(({ resolve }) => resolve()) })
  const waitMain = async (predicate, message) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) { const entries = await records(); if (predicate(entries)) return entries; await frames() }
    throw new Error(message)
  }

  phase = 'root failure: open genuine root-A image'
  await menu('workspace'); await open(rootNote); await waitImage(path.join(assetsA, 'cover.png'))
  const rootBaseline = await model(), rootBody = JSON.stringify(rootBaseline.content.filter((node) => node.type !== 'front_matter'))
  const replaceRoot = async (next) => {
    const yaml = page.locator('.front-matter-source'), text = await yaml.textContent()
    const match = text.match(/^typora-root-url: ([^\r\n]+)$/m)
    assert.ok(match, 'The actual editable YAML must contain the root literal')
    const suffixEnd = match.index + match[0].length, previous = match[1]
    assert.match(text.slice(0, suffixEnd), /^[\x00-\x7f]*$/, 'Fixture caret movement uses ASCII before the root suffix')
    const caret = () => yaml.evaluate((pre) => {
      const selection = window.getSelection(), anchor = selection?.anchorNode
      const inPre = Boolean(anchor && pre.contains(anchor))
      let offset = -1
      if (inPre && selection.isCollapsed) { const range = document.createRange(); range.selectNodeContents(pre); range.setEnd(anchor, selection.anchorOffset); offset = range.toString().length }
      const result = { offset, inPre, anchorNode: anchor?.nodeName, anchorParent: anchor?.parentElement?.nodeName, anchorOffset: selection?.anchorOffset }
      window.__imageBindingYAMLNavigation ??= []; window.__imageBindingYAMLNavigation.push(result)
      return result
    })
    await yaml.click(); await page.keyboard.press('Control+Home')
    let current = await caret()
    for (let step = 0; !current.inPre && step < 8; step++) { await page.keyboard.press('ArrowRight'); current = await caret() }
    if (!current.inPre) {
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); current = await caret()
      for (let step = 0; !current.inPre && step < 8; step++) { await page.keyboard.press('ArrowRight'); current = await caret() }
    }
    assert.ok(current.inPre && current.offset >= 0 && current.offset <= suffixEnd, `Native keys must enter the actual YAML before its root suffix: ${JSON.stringify(current)}`)
    for (let step = 0; current.offset < suffixEnd && step < text.length + 16; step++) { await page.keyboard.press('ArrowRight'); current = await caret() }
    assert.equal(current.offset, suffixEnd, 'Native caret must reach the exact root value end')
    for (let step = 0; step < previous.length; step++) await page.keyboard.press('Shift+ArrowLeft')
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), previous, 'Native selection must contain only the complete prior root literal')
    await page.keyboard.insertText(next)
    await page.waitForFunction((next) => document.querySelector('.front-matter-source')?.textContent?.includes(`typora-root-url: ${next}`), next)
  }
  const rootFailures = []
  for (const next of ['../assetsC', '../../outside']) {
    phase = `root failure: native YAML changes A to ${next}`
    const before = (await records()).length
    await replaceRoot(next)
    const entries = await waitMain((entries) => entries.slice(before).some((entry) => entry.completed && entry.snapshot?.documentPath === rootNote && entry.snapshot?.markdown?.includes(`typora-root-url: ${next}`) && entry.source === 'cover.png'), `No genuine resolver completion for ${next}`)
    phase = `root failure: ${next} must clear previously displayed A`
    await page.waitForFunction((oldURL) => { const physical = (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href } catch { return '' } }; return [...document.querySelectorAll('.milkdown-image-block img[data-type="image-block"]')].every((image) => physical(image.getAttribute('src')) !== oldURL && physical(image.currentSrc) !== oldURL) }, imageURL(path.join(assetsA, 'cover.png')))
    await frames()
    const failedModel = await model()
    assert.equal(JSON.stringify(failedModel.content.filter((node) => node.type !== 'front_matter')), rootBody, 'Failed URL binding must preserve all image Markdown attributes, caption/title and complete rich body')
    const state = await page.evaluate(() => ({ uploader: Boolean(document.querySelector('.milkdown-image-block .image-edit')), images: [...document.querySelectorAll('.milkdown-image-block img[data-type="image-block"]')].map((image) => ({ src: image.getAttribute('src'), currentSrc: image.currentSrc, complete: image.complete, naturalWidth: image.naturalWidth })) }))
    assert.ok(state.images.every((image) => withoutURLMetadata(image.src) !== imageURL(path.join(assetsA, 'cover.png')) && withoutURLMetadata(image.currentSrc) !== imageURL(path.join(assetsA, 'cover.png'))), 'The old A bitmap/URL must no longer be displayed')
    const completion = entries.slice(before).filter((entry) => entry.completed && entry.source === 'cover.png' && entry.snapshot?.markdown?.includes(`typora-root-url: ${next}`))
    assert.ok(completion.some((entry) => entry.error), 'Missing/outside fixtures must really fail in the registered authorized resolver')
    rootFailures.push({ root: next, state, completions: completion })
    await page.screenshot({ path: artifact(next === '../assetsC' ? 'missing-root.png' : 'outside-root.png'), animations: 'disabled', timeout: 60000 })
    phase = `root failure: genuine menu Undo restores A from ${next}`
    await menu('undo')
    await page.waitForFunction(() => document.querySelector('.front-matter-source')?.textContent?.includes('typora-root-url: ../assetsA'))
    await waitImage(path.join(assetsA, 'cover.png')); assert.deepEqual(await model(), rootBaseline)
    assert.equal(await page.locator('.milkdown-image-block img[data-type="image-block"]').getAttribute('alt'), 'Binding alt')
    assert.equal(await page.locator('.milkdown-image-block img[data-type="image-block"]').getAttribute('title'), 'Original caption')
  }
  assert.equal(await readFile(rootNote, 'utf8'), originalRoot)
  check('Missing in-workspace and out-of-workspace roots clear the old native A image without changing Markdown attrs/title/body; native menu Undo restores authorized A', { roots: rootFailures })

  phase = 'same node: blank owned uploader before first confirmation'
  await open(blankNote); await page.locator('.ttypora-image-link-input .link-input-area').waitFor()
  const blankBaseline = await model()
  await page.evaluate(() => {
    const prose = document.querySelector('.ProseMirror'), native = document.querySelector('.ttypora-image-link-input'), outer = native.closest('.ttypora-localized-image-view')
    if (!prose.pmViewDesc || !outer.pmViewDesc) throw new Error('Actual PM root and image NodeView descriptors must be present for identity verification')
    window.__imageBindingSameNode = { prose, proseDesc: prose.pmViewDesc, outer, viewDesc: outer.pmViewDesc, native, input: native.querySelector('.link-input-area') }
  })
  const assertSameNode = async (withInput = false) => assert.equal(await page.evaluate((withInput) => { const saved = window.__imageBindingSameNode; return saved.prose === document.querySelector('.ProseMirror') && saved.proseDesc === saved.prose.pmViewDesc && saved.outer.isConnected && saved.outer === document.querySelector('.ttypora-localized-image-view') && saved.viewDesc === saved.outer.pmViewDesc && saved.native.isConnected && saved.native === document.querySelector('.ttypora-image-link-input') && (!withInput || saved.input.isConnected && saved.input === saved.native.querySelector('.link-input-area')) }, withInput), true, 'Both confirmations must use the same outer PM NodeView and owned input host; A must keep the original input available')
  await application.evaluate(() => { globalThis.__imageBindingControl.holdSource = 'coverA.png' })
  const beforeConfirmA = (await records()).length
  const link = page.locator('.ttypora-image-link-input .link-input-area')
  await link.click(); await link.press('Control+a'); await page.keyboard.insertText('coverA.png')
  await page.locator('.ttypora-image-link-input .confirm').click()
  await waitMain((entries) => entries.slice(beforeConfirmA).some((entry) => entry.source === 'coverA.png' && entry.completed && entry.held && !entry.delivered), 'Actual coverA handler did not enter its result-delivery hold')
  assert.equal((await model()).content.find((node) => node.type === 'image-block').attrs.src, 'coverA.png', 'First real confirmation must set Markdown src A even while display resolution is held')
  await assertSameNode(true)
  assert.equal(await link.isVisible(), true, 'The same owned uploader must remain visible while A is held')
  phase = 'same node: real second confirmation displays B before held A'
  await link.click(); await link.press('Control+a'); await page.keyboard.insertText('coverB.png')
  await page.locator('.ttypora-image-link-input .confirm').click()
  await waitImage(path.join(documents, 'coverB.png')); await assertSameNode()
  await page.evaluate(() => { window.__imageBindingSameNode.displayedNative = document.querySelector('.ttypora-authorized-image-host > .milkdown-image-block') })
  const expectedB = structuredClone(blankBaseline); expectedB.content.find((node) => node.type === 'image-block').attrs.src = 'coverB.png'
  assert.deepEqual(await model(), expectedB, 'Second confirmation must change only this blank image src to B')
  const beforeRelease = await records()
  assert.ok(beforeRelease.slice(beforeConfirmA).some((entry) => entry.source === 'coverB.png' && entry.delivered && withoutURLMetadata(entry.result) === imageURL(path.join(documents, 'coverB.png'))), 'B must come from its actual successful main handler')
  assert.ok(beforeRelease.slice(beforeConfirmA).some((entry) => entry.source === 'coverA.png' && entry.held && !entry.delivered), 'A must still be held after B becomes the displayed native image')
  phase = 'same node: releasing old real A result cannot replace B'
  await release()
  await waitMain((entries) => entries.slice(beforeConfirmA).filter((entry) => entry.source === 'coverA.png' && entry.held).every((entry) => entry.delivered), 'Held A results did not actually release')
  await frames(); await waitImage(path.join(documents, 'coverB.png')); await assertSameNode(); assert.deepEqual(await model(), expectedB)
  assert.equal(await page.evaluate(() => { const saved = window.__imageBindingSameNode; return saved.displayedNative?.isConnected && saved.displayedNative === document.querySelector('.ttypora-authorized-image-host > .milkdown-image-block') }), true, 'Late A must retain the actual displayed native B host')
  assert.equal(await readFile(blankNote, 'utf8'), originalBlank)
  await page.screenshot({ path: artifact('same-node-B.png'), animations: 'disabled', timeout: 60000 })
  check('The same owned blank-image input and outer PM NodeView confirm A then B; actual B displays first and late genuine A retains the displayed native B host', { sources: ['coverA.png', 'coverB.png'], ipc: (await records()).slice(beforeConfirmA) })

  let timingPass = false
  for (const [index, note] of captionNotes.entries()) {
    phase = `caption locale ${index + 1}: fresh independent document`
    await open(note); await waitImage(path.join(documents, 'coverB.png'))
    const captionBaseline = await model()
    const fromLocale = await page.evaluate(() => document.documentElement.lang), toLocale = fromLocale === 'en' ? 'zh-CN' : 'en'
    const caption = page.locator('.milkdown-image-block .caption-input')
    await caption.waitFor(); await caption.click(); await caption.press('Control+a')
    // Read-only event timestamps use the same renderer clock as the native timer.
    // They neither alter input values nor invoke setAttr/PM transactions.
    await page.evaluate(() => {
      window.__imageBindingCaptionObserver?.remove()
      const prose = document.querySelector('.ProseMirror'), native = document.querySelector('.milkdown-image-block'), outer = native.closest('.ttypora-localized-image-view')
      if (!prose.pmViewDesc || !outer.pmViewDesc) throw new Error('Actual PM root and image NodeView descriptors must be present for locale identity verification')
      const events = [], ids = new WeakMap(); let nextID = 0
      const id = (input) => { if (!ids.has(input)) ids.set(input, ++nextID); return ids.get(input) }
      const pmCaption = () => { let value; prose.pmViewDesc.node.descendants((node) => { if (node.type.name === 'image-block') value = node.attrs.caption }); return value }
      const observe = (event) => { if (event.target instanceof HTMLInputElement && event.target.matches('.caption-input')) events.push({ type: event.type, value: event.target.value, trusted: event.isTrusted, at: performance.now(), inputID: id(event.target), connected: event.target.isConnected, modelCaption: pmCaption() }) }
      document.addEventListener('input', observe, true); document.addEventListener('blur', observe, true)
      window.__imageBindingCaptionObserver = { prose, proseDesc: prose.pmViewDesc, outer, outerDesc: outer.pmViewDesc, native, input: native.querySelector('.caption-input'), events, remove: () => { document.removeEventListener('input', observe, true); document.removeEventListener('blur', observe, true) } }
    })
    phase = `caption locale ${index + 1}: native First draft before menu Preferences`
    await page.keyboard.insertText('First')
    const first = await page.evaluate(() => { const saved = window.__imageBindingCaptionObserver; return { event: saved.events.find((event) => event.type === 'input' && event.trusted && event.value === 'First'), focused: document.activeElement === saved.input, modelCaption: (() => { let value; saved.prose.pmViewDesc.node.descendants((node) => { if (node.type.name === 'image-block') value = node.attrs.caption }); return value })() } })
    assert.ok(first.event, 'First must be a real native input event')
    assert.equal(first.focused, true); assert.equal(first.modelCaption, 'Original caption', 'First must still be pending when Preferences is opened')
    phase = `caption locale ${index + 1}: real Preferences locale rebuild ${fromLocale} to ${toLocale}`
    const preferencesMenu = await menu('preferences')
    await page.locator('.preferences fieldset').first().locator('select').selectOption(toLocale)
    await page.waitForFunction((locale) => document.documentElement.lang === locale, toLocale)
    await page.getByRole('dialog').getByRole('button', { name: toLocale === 'en' ? 'Done' : '完成', exact: true }).click()
    await caption.waitFor()
    phase = `caption locale ${index + 1}: native Second and real body blur commit before First deadline`
    await caption.click(); await caption.press('Control+a'); await page.keyboard.insertText('Second')
    await page.locator('.ProseMirror p').filter({ hasText: /^Body stays bold\.$/ }).click()
    const committed = await page.evaluate(() => {
      const saved = window.__imageBindingCaptionObserver, prose = document.querySelector('.ProseMirror'), native = document.querySelector('.milkdown-image-block'), input = native?.querySelector('.caption-input')
      let caption; prose.pmViewDesc.node.descendants((node) => { if (node.type.name === 'image-block') caption = node.attrs.caption })
      return { at: performance.now(), caption, input: input?.value, focusedBody: document.activeElement === prose, sameProse: prose === saved.prose && saved.proseDesc === prose.pmViewDesc, sameOuterView: saved.outer === native?.closest('.ttypora-localized-image-view') && saved.outerDesc === saved.outer.pmViewDesc, nativeRecreated: saved.native !== native && !saved.native.isConnected, inputRecreated: saved.input !== input && !saved.input.isConnected, events: saved.events.slice() }
    })
    assert.equal(committed.caption, 'Second', 'Body blur must synchronously commit Second to the actual PM model')
    assert.equal(committed.input, 'Second'); assert.equal(committed.focusedBody, true)
    assert.equal(committed.sameProse, true); assert.equal(committed.sameOuterView, true)
    assert.equal(committed.nativeRecreated, true, 'Actual locale change must destroy/replace the native image component')
    assert.equal(committed.inputRecreated, true, 'Second must be edited in the replacement native caption input')
    assert.ok(committed.events.some((event) => event.type === 'input' && event.trusted && event.value === 'Second'), 'Second must be a real native input event')
    assert.ok(committed.events.some((event) => event.type === 'blur' && event.value === 'Second'), 'Second must commit through a real body-click blur')
    const expectedSecond = structuredClone(captionBaseline); expectedSecond.content.find((node) => node.type === 'image-block').attrs.caption = 'Second'
    assert.deepEqual(await model(), expectedSecond, 'Locale/Second edit must preserve the entire document except its caption')
    const firstDeadline = first.event.at + 1000
    const firstEvents = committed.events.filter((event) => event.type === 'input' && event.value === 'First')
    const lastFirstDeadline = Math.max(firstDeadline, ...firstEvents.map((event) => event.at + 1000))
    const withinDeadline = committed.at < firstDeadline
    const attempt = { attempt: index + 1, documentPath: note, fromLocale, toLocale, preferencesMenu, first, committed, firstDeadline, lastFirstDeadline, elapsedToSecondCommitMs: committed.at - first.event.at, marginBeforeFirstDeadlineMs: firstDeadline - committed.at, withinDeadline, outcome: withinDeadline ? 'Required race window reached; awaiting post-deadline assertions' : 'Inconclusive timing only: Second commit missed the required First deadline' }
    timingAttempts.push(attempt)
    phase = `caption locale ${index + 1}: observe past all First input deadlines`
    await page.waitForFunction((deadline) => performance.now() >= deadline + 150, lastFirstDeadline)
    await frames(); assert.deepEqual(await model(), expectedSecond)
    assert.equal(await caption.inputValue(), 'Second', 'Past the old First deadline, PM/native caption must remain exactly Second')
    await waitImage(path.join(documents, 'coverB.png'))
    assert.equal(await readFile(note, 'utf8'), originalCaption)
    attempt.afterDeadline = await page.evaluate(() => ({ at: performance.now(), input: document.querySelector('.caption-input')?.value, events: window.__imageBindingCaptionObserver.events.slice() }))
    if (withinDeadline) {
      attempt.outcome = 'PASS: native Second/body-blur commit preceded First+1000ms and remained Second beyond all observed First deadlines'
      timingPass = true
      await page.screenshot({ path: artifact('caption-locale-Second.png'), animations: 'disabled', timeout: 60000 })
      check('Real Preferences locale rebuild replaces the native image; Second commits by body blur before pending First deadline and remains exact in PM/input after that deadline', { fromLocale, toLocale, successfulAttempt: index + 1, elapsedToSecondCommitMs: attempt.elapsedToSecondCommitMs, marginBeforeFirstDeadlineMs: attempt.marginBeforeFirstDeadlineMs, timingAttempts })
      break
    }
    console.log(`INCONCLUSIVE caption timing attempt ${index + 1}: ${attempt.elapsedToSecondCommitMs.toFixed(1)}ms; retrying only with a fresh independent document`)
  }
  assert.equal(timingPass, true, 'At least one independently recorded locale case must commit Second strictly before the real First input +1000ms deadline; missed timing is not a PASS')
  assert.equal(checks.length, 3); assert.deepEqual(pageErrors, [])
  await writeFile(artifact('verification.json'), JSON.stringify({ variant: packaged ? 'packaged' : 'source', prefix, version: await application.evaluate(({ app }) => app.getVersion()), interaction: 'Native keyboard/YAML/caption/uploader edits, genuine installed Electron menu callbacks, visible Preferences locale select/Done; model and DOM read only. Genuine registered resolver observed and A delivery paused.', checks, exclusions, timingAttempts, pageErrors, consoleMessages, imageRequests, ipc: await records() }, null, 2) + '\n')
} catch (error) {
  let diagnostic = { unavailable: true }
  if (page && !page.isClosed()) {
    diagnostic = await page.evaluate(() => ({ body: document.body.innerText, lang: document.documentElement.lang, model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(), yaml: document.querySelector('.front-matter-source')?.textContent, yamlNavigation: window.__imageBindingYAMLNavigation ?? [], images: [...document.querySelectorAll('.milkdown-image-block img')].map((image) => ({ src: image.getAttribute('src'), currentSrc: image.currentSrc, alt: image.alt, title: image.title, complete: image.complete, naturalWidth: image.naturalWidth })), blocks: [...document.querySelectorAll('.milkdown-image-block')].map((block) => block.outerHTML), inputs: [...document.querySelectorAll('.caption-input,.link-input-area')].map((input) => ({ class: input.className, value: input.value, focused: document.activeElement === input, from: input.selectionStart, to: input.selectionEnd })), captionEvents: window.__imageBindingCaptionObserver?.events ?? [], focusedElement: document.activeElement?.outerHTML, selection: window.getSelection()?.toString() })).catch(() => diagnostic)
    await page.screenshot({ path: artifact('failure.png'), animations: 'disabled', timeout: 60000 }).catch(() => undefined)
  }
  await writeFile(artifact('failure.json'), JSON.stringify({ phase, activePath, error: String(error), stack: error?.stack, prefix, checks, exclusions, timingAttempts, diagnostic, pageErrors, consoleMessages, imageRequests, ipc: application ? await application.evaluate(() => globalThis.__imageBindingControl?.records ?? []).catch(() => []) : [] }, null, 2) + '\n')
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.__imageBindingCaptionObserver?.remove()).catch(() => undefined)
  if (application) await application.evaluate(({ ipcMain }) => { const control = globalThis.__imageBindingControl; if (!control) return; control.holdSource = null; control.pending.splice(0).forEach(({ resolve }) => resolve()); ipcMain.removeHandler(control.channel); ipcMain.handle(control.channel, control.original) }).catch(() => undefined)
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  const actualTemporary = await realpath(temporary), actualParent = await realpath(tmpdir())
  const relative = path.relative(actualParent, actualTemporary)
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.' && path.basename(actualTemporary).startsWith('ttypora-image-binding-'), 'Refusing cleanup outside the exact newly created fixture directory')
  await rm(actualTemporary, { recursive: true, force: true })
}
