import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { _electron as electron } from 'playwright'

// This file can run from staging or, after review, from the repository scripts directory.
let root = path.dirname(fileURLToPath(import.meta.url))
while (!existsSync(path.join(root, 'package.json'))) {
  const parent = path.dirname(root)
  assert.notEqual(parent, root, 'Cannot locate the repository package.json')
  root = parent
}
const packaged = process.env.TTYPORA_PACKAGED_EXE
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v0.9-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-resource-root-'))
const workspace = path.join(temporary, 'notes'), documents = path.join(workspace, 'docs')
const artifacts = path.join(root, 'artifacts'), artifact = (suffix) => path.join(artifacts, `resource-root-${prefix}-${suffix}`)
const note = path.join(documents, 'root-note.md'), related = path.join(documents, 'related.md')
const ownAssets = path.join(documents, 'root-note.assets')
const roots = { A: path.join(workspace, 'assetsA'), B: path.join(workspace, 'assetsB') }
const outside = path.join(temporary, 'outside'), chosen = path.join(temporary, 'chosen.png')
const callsPath = path.join(temporary, 'uploader-calls.jsonl'), mockCli = path.join(temporary, 'mock-uploader.cjs')
const body = '# Resource roots\n\nBody stays **bold**.\n\n```js\nconst retained = "CM";\n```\n\n$$\nx + 1\n$$\n\n![Markdown root](/cover.png?from=markdown#root "Original caption")\n\n<div>\n<img src="cover.png?from=html" alt="HTML root">\n<audio controls src="tone.wav?from=audio"></audio>\n<video controls poster="/cover.png?from=poster"><source src="tone.wav?from=source" type="audio/wav"></video>\n</div>\n'
const rooted = (letter, contents = body) => `---\ntitle: Resource roots\ntypora-root-url: ../assets${letter}\n---\n\n${contents}`
const original = rooted('A')
const relatedOriginal = rooted('B', '# Related roots\n\n![Related](cover.png)\n')

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
function wav(frequency) {
  const rate = 8000, result = Buffer.alloc(44 + rate * 2)
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8)
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22)
  result.writeUInt32LE(rate, 24); result.writeUInt32LE(rate * 2, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34)
  result.write('data', 36); result.writeUInt32LE(rate * 2, 40)
  for (let index = 0; index < rate; index++) result.writeInt16LE(Math.round(Math.sin(index * Math.PI * 2 * frequency / rate) * 1200), 44 + index * 2)
  return result
}
const imageBytes = { A: png(190, 50, 35), B: png(35, 75, 190) }
const audioBytes = { A: wav(220), B: wav(330) }
for (const directory of [documents, ownAssets, roots.A, roots.B, outside, artifacts]) await mkdir(directory, { recursive: true })
for (const letter of ['A', 'B']) {
  await writeFile(path.join(roots[letter], 'cover.png'), imageBytes[letter])
  await writeFile(path.join(roots[letter], 'tone.wav'), audioBytes[letter])
}
await writeFile(note, original); await writeFile(related, relatedOriginal)
await writeFile(path.join(documents, 'saved-protector.md'), '---\ntypora-root-url: ./root-note.assets\n---\n\n![Saved protector](protected.png)\n')
for (const name of ['protected.png', 'draft-protected.png', 'unrelated.png']) await writeFile(path.join(ownAssets, name), imageBytes.A)
await writeFile(path.join(outside, 'cover.png'), imageBytes.A); await writeFile(path.join(outside, 'tone.wav'), audioBytes.A)
await writeFile(chosen, png(30, 160, 80)); await writeFile(callsPath, '')
await writeFile(mockCli, `const fs=require('node:fs');const source=process.argv[2];fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({source,bytes:fs.readFileSync(source).toString('base64')})+'\\n');console.log(JSON.stringify({urls:['https://uploads.invalid/resource-root.png']}));\n`)

let application, page, phase = 'launch', activePath = note
const pageErrors = [], blockedRequests = [], checks = []
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`) }
const priorObservations = [{
  scenario: 'Focused native caption input undo after its natural commit',
  artifact: 'resource-root-v0.9-source-resource-root-navigation-failure.json',
  phase: 'caption: focused native input undo',
  command: 'undo-document while caption remains document.activeElement',
  observedValue: 'Pending caption draftOriginal caption',
  interpretation: 'App routes this focus state to Electron webContents.undo. Async resource URL delivery previously reset the controlled caption value before its natural commit, corrupting native input history. Resource delivery now waits for the active draft to commit; this suite repeats focused native menu undo/redo before separately verifying shared document undo.',
  diagnosticArtifactPrefix: 'v0.9-source-caption-held-fixed',
  diagnosticEvidence: 'Independent root diagnostic observed no value setter assignments before native undo and restored Original caption; it is supporting evidence, not a formal GUI suite PASS.',
  formalRegression: 'Pending in this run: focused native menu undo/redo after held URL delivery and natural commit',
}]
const exclusions = [
  'This suite does not exercise foreign-platform paths, symlink/UNC/drive roots, near-limit documents or IME; service/unit tests own those cases.',
  'The source element uses a WAV URL to verify resource location, without claiming video codec/playback compatibility.',
  'PDF/PNG checks prove valid files and identical recorded export snapshots; detailed exported pixel/layout review is separate.',
  'The stale-result case changes YAML roots; closing a tab during asynchronous upload and concurrent Save As during library mutation remain separate lifecycle cases.',
  'The uploader is a local deterministic CLI, not a real network service. Apply rejection is tested through real IPC; this suite does not apply a successful remote URL to the editor.',
]

try {
  const flags = ['--disable-gpu', '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? flags : [...flags, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('request', (request) => { if (request.url().startsWith(pathToFileURL(outside).href + '/')) blockedRequests.push(request.url()) })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  page.setDefaultTimeout(30000)
  const command = (value) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').first().waitFor() }
  const model = () => page.evaluate(() => document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON())
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const sourceText = () => page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString())
  const open = async (filePath) => { await page.locator('.file-tree').getByTitle(filePath, { exact: true }).click(); await page.waitForFunction((name) => document.title.includes(name), path.basename(filePath)); await ready(); activePath = filePath }
  const visualMode = async () => { if (await page.locator('.source-editor').count()) { await command('toggle-source-mode'); await ready() }; await page.locator('.ProseMirror').waitFor() }
  const sourceMode = async () => { if (await page.locator('.ProseMirror').count()) { await command('toggle-source-mode'); await ready() }; await page.locator('.source-editor .cm-content').waitFor() }
  const rawSnapshot = async () => { await sourceMode(); const markdown = await sourceText(); await visualMode(); return { documentPath: activePath, markdown } }
  const rootLetter = () => page.locator('.front-matter-source').textContent().then((text) => text.match(/typora-root-url: \.\.\/assets([AB])/)?.[1])
  const setRoot = async (letter) => {
    const yaml = page.locator('.front-matter-source'), text = await yaml.textContent()
    const rootMatch = text.match(/typora-root-url: \.\.\/assets([AB])/)
    assert.ok(rootMatch, 'The actual editable YAML text must contain the expected root field')
    const suffixEnd = rootMatch.index + rootMatch[0].length
    assert.match(text.slice(0, suffixEnd), /^[\x00-\x7f]*$/, 'This fixture uses ASCII caret steps before the root suffix')
    const readCaret = () => yaml.evaluate((pre) => {
      const selection = window.getSelection()
      const prose = pre.closest('.ProseMirror'), anchor = selection?.anchorNode, parent = anchor?.parentElement
      const inPre = Boolean(anchor && pre.contains(anchor))
      const equivalentEnd = anchor === pre.parentNode && selection.anchorOffset === [...anchor.childNodes].indexOf(pre) + 1
      let offset = -1, mappedPMPosition = null
      if (selection?.isCollapsed && (inPre || equivalentEnd)) {
        const range = document.createRange(); range.selectNodeContents(pre); range.setEnd(anchor, selection.anchorOffset)
        offset = range.toString().length
      }
      if (anchor && prose?.contains(anchor)) mappedPMPosition = prose.pmViewDesc?.posFromDOM(anchor, selection.anchorOffset, 1) ?? null
      const exposedView = prose?.pmViewDesc?.view ?? prose?.editorView
      const result = { offset, inPre, equivalentEnd, collapsed: selection?.isCollapsed, anchorNode: anchor?.nodeName ?? null, anchorParent: parent?.nodeName ?? null, anchorParentClass: parent?.className ?? null, anchorText: anchor?.nodeType === 3 ? anchor.textContent : null, anchorOffset: selection?.anchorOffset ?? null, focusNode: selection?.focusNode?.nodeName ?? null, focusOffset: selection?.focusOffset ?? null, mappedPMPosition, pmSelectionFrom: exposedView?.state?.selection?.from ?? null, pmSelectionNote: exposedView ? 'EditorView.state.selection.from' : 'EditorView is not exposed; mappedPMPosition is the read-only docView DOM mapping' }
      window.__resourceRootYAMLNavigation ??= []
      window.__resourceRootYAMLNavigation.push(result)
      return result
    })
    await yaml.click(); await page.keyboard.press('Control+Home')
    let caret = await readCaret()
    // Ctrl+Home can use the details/summary boundary as an equivalent position
    // before the editable pre. Enter its actual text using native keys, then
    // use the observed offset rather than assuming that position was zero.
    for (let step = 0; !caret.inPre && step < 8; step++) { await page.keyboard.press('ArrowRight'); caret = await readCaret() }
    if (!caret.inPre) {
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); caret = await readCaret()
      for (let step = 0; !caret.inPre && step < 8; step++) { await page.keyboard.press('ArrowRight'); caret = await readCaret() }
    }
    assert.ok(caret.inPre && caret.offset >= 0 && caret.offset <= suffixEnd, `Native keys must enter the YAML pre before its suffix: ${JSON.stringify(caret)}`)
    // The pre contains one PM text node with an actual LF, rather than separate
    // editable line elements. PM vertical navigation does not reliably advance
    // that LF; move through the real text with native horizontal keys instead.
    for (let step = 0; caret.offset < suffixEnd && step < text.length + 16; step++) { await page.keyboard.press('ArrowRight'); caret = await readCaret() }
    assert.equal(caret.offset, suffixEnd, `Native caret movement must reach the exact YAML root suffix: ${JSON.stringify(caret)}`)
    await page.keyboard.press('Shift+ArrowLeft')
    assert.match(await page.evaluate(() => window.getSelection()?.toString() ?? ''), /^[AB]$/, 'Native YAML selection must select only the root suffix')
    await page.keyboard.insertText(letter)
    await page.waitForFunction((letter) => document.querySelector('.front-matter-source')?.textContent?.includes(`typora-root-url: ../assets${letter}`), letter)
  }
  const waitUrls = async (letter, scope = '.ProseMirror') => {
    await page.waitForFunction(({ image, audio, scope }) => {
      const host = document.querySelector(scope), url = (element, attr) => { try { const value = new URL(element?.getAttribute(attr)); value.search = ''; value.hash = ''; return value.href } catch { return '' } }
      const md = host?.querySelector('img[alt="Markdown root"]'), html = host?.querySelector('img[alt="HTML root"]')
      return url(md, 'src') === image && md.complete && md.naturalWidth === 2 && url(html, 'src') === image && html.complete && html.naturalWidth === 2 && url(host?.querySelector('audio'), 'src') === audio && url(host?.querySelector('video source'), 'src') === audio && url(host?.querySelector('video'), 'poster') === image
    }, { image: pathToFileURL(path.join(roots[letter], 'cover.png')).href, audio: pathToFileURL(path.join(roots[letter], 'tone.wav')).href, scope })
  }
  const waitRootModel = (letter) => page.waitForFunction((letter) => document.querySelector('.ProseMirror')?.pmViewDesc?.node.firstChild?.textContent?.includes(`typora-root-url: ../assets${letter}`), letter)

  await ready()
  // Wrap genuine registered handlers. The original handlers still perform authorization,
  // filesystem reads/copies and serialization; only delivery of their results can pause.
  await application.evaluate(({ ipcMain }) => {
    const originals = new Map(), control = { originals, records: [], nativeEdits: [], pending: [], delay: null }
    control.observeNativeEdit = (_event, direction) => control.nativeEdits.push({ direction, timestamp: Date.now() })
    ipcMain.on('edit:native-history', control.observeNativeEdit)
    for (const channel of ['image:resolve-url', 'media:resolve-url', 'image:choose', 'image:save', 'document:prepare-preview', 'export:html', 'export:pdf', 'export:png']) {
      const original = ipcMain._invokeHandlers?.get(channel)
      if (typeof original !== 'function') throw new Error(`Missing registered real IPC handler ${channel}`)
      originals.set(channel, original); ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        const entry = { channel, snapshot: args[0] && typeof args[0] === 'object' ? { ...args[0] } : args[0], source: typeof args[1] === 'string' ? args[1] : undefined, completed: false }
        control.records.push(entry)
        const result = await original(event, ...args)
        const root = entry.snapshot?.markdown?.match(/^typora-root-url:\s*(.+)$/m)?.[1]
        if (control.delay?.channels.includes(channel) && (control.delay.root === null || root === control.delay.root)) await new Promise((resolve) => control.pending.push({ channel, resolve }))
        entry.completed = true; entry.result = typeof result === 'string' ? result : undefined
        return result
      })
    }
    globalThis.__resourceRootControl = control
  })
  const arm = (channels, letter = null) => application.evaluate((_electron, { channels, letter }) => { globalThis.__resourceRootControl.delay = { channels, root: letter === null ? null : `../assets${letter}` } }, { channels, letter })
  const pending = () => application.evaluate(() => globalThis.__resourceRootControl.pending.length)
  const waitPending = async () => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await pending()) return; await frames() }; throw new Error('Genuine IPC result did not enter the deliberate delivery pause') }
  const release = () => application.evaluate(() => { const control = globalThis.__resourceRootControl; control.delay = null; control.pending.splice(0).forEach(({ resolve }) => resolve()) })
  const ipcRecords = () => application.evaluate(() => globalThis.__resourceRootControl.records)
  const nativeHistoryCommands = () => application.evaluate(() => globalThis.__resourceRootControl.nativeEdits)

  phase = 'initial rooted writing views'
  await command('open-workspace'); await open(note); await waitUrls('A')
  const initialModel = await model(), initialBody = JSON.stringify(initialModel.content.filter((node) => node.type !== 'front_matter'))
  check('Markdown image, HTML image, audio, source and poster resolve through root A inside one workspace')

  phase = 'native YAML refresh retains editor instances and body'
  for (const selector of ['.ttypora-code-block .cm-content', '.ttypora-math-block .cm-content']) {
    const embedded = page.locator(selector); await embedded.click(); await embedded.press('Control+Home'); await embedded.press('Shift+ArrowRight')
  }
  await page.evaluate(() => {
    const prose = document.querySelector('.ProseMirror'), code = document.querySelector('.ttypora-code-block .cm-content'), math = document.querySelector('.ttypora-math-block .cm-content')
    window.__resourceRootIdentity = { prose, desc: prose.pmViewDesc, code, codeView: code.cmTile.root.view, codeSelection: code.cmTile.root.view.state.selection.toJSON(), math, mathView: math.cmTile.root.view, mathSelection: math.cmTile.root.view.state.selection.toJSON() }
  })
  const assertIdentity = async () => assert.equal(await page.evaluate(() => {
    const saved = window.__resourceRootIdentity
    return saved.prose === document.querySelector('.ProseMirror') && saved.desc === saved.prose.pmViewDesc && saved.code.isConnected && saved.math.isConnected && saved.codeView === saved.code.cmTile.root.view && saved.mathView === saved.math.cmTile.root.view && JSON.stringify(saved.codeSelection) === JSON.stringify(saved.codeView.state.selection.toJSON()) && JSON.stringify(saved.mathSelection) === JSON.stringify(saved.mathView.state.selection.toJSON())
  }), true, 'Root refresh must retain the PM root/view descriptor, code/math CM instances and their selections')
  await setRoot('B'); await waitUrls('B'); await assertIdentity()
  const changedModel = await model()
  assert.equal(JSON.stringify(changedModel.content.filter((node) => node.type !== 'front_matter')), initialBody)
  assert.equal(await page.evaluate(() => document.querySelector('.front-matter-source')?.contains(window.getSelection()?.anchorNode) && window.getSelection()?.isCollapsed), true, 'Resource completion must retain the YAML caret')
  await command('undo-document'); await waitRootModel('A'); await waitUrls('A'); assert.deepEqual(await model(), initialModel); await assertIdentity()
  await command('redo-document'); await waitRootModel('B'); await waitUrls('B'); assert.deepEqual(await model(), changedModel); await assertIdentity()
  assert.equal(await readFile(note, 'utf8'), original)
  check('One native YAML edit refreshes resources without remount/body/CM selection changes, and undo/redo changes only metadata')

  phase = 'stale real main-process resolver delivery'
  await arm(['image:resolve-url', 'media:resolve-url'], 'A'); await setRoot('A'); await waitPending()
  const heldResults = await pending(); await setRoot('B'); await waitUrls('B'); await release(); await frames(); await waitUrls('B'); await assertIdentity()
  assert.deepEqual(await model(), changedModel)
  check('Delayed actual root-A resolver results cannot replace root-B image/media/poster views', { heldResults })

  phase = 'caption: preparing pending resource URL'
  await arm(['image:resolve-url'], 'A'); await setRoot('A'); await waitPending()
  phase = 'caption: native draft before its natural commit'
  const caption = page.locator('.milkdown-image-block .caption-input').first()
  await caption.waitFor(); await caption.click(); await caption.press('Control+a'); await page.keyboard.insertText('Pending caption draft')
  await page.evaluate(() => { const input = document.querySelector('.milkdown-image-block .caption-input'); window.__resourceCaption = { input, from: input.selectionStart, to: input.selectionEnd } })
  assert.equal((await model()).content.find((node) => node.type === 'image-block').attrs.caption, 'Original caption', 'The native 1000ms caption draft must still be uncommitted when delivery resumes')
  phase = 'caption: pending URL delivery retains draft/input/focus/selection'
  await release(); await frames(); await waitUrls('A')
  assert.equal(await page.evaluate(() => { const saved = window.__resourceCaption; return saved.input.isConnected && saved.input === document.querySelector('.milkdown-image-block .caption-input') && saved.input.value === 'Pending caption draft' && document.activeElement === saved.input && saved.input.selectionStart === saved.from && saved.input.selectionEnd === saved.to }), true, 'Existing native caption input, uncommitted draft and caret must survive new resource URL delivery')
  phase = 'caption: native natural 1000ms commit'
  await page.waitForFunction(() => { let caption; document.querySelector('.ProseMirror').pmViewDesc.node.descendants((node) => { if (node.type.name === 'image-block') caption = node.attrs.caption }); return caption === 'Pending caption draft' })
  assert.equal(await caption.inputValue(), 'Pending caption draft', 'Natural commit must keep the exact draft in the native field')
  const pendingCaptionNodes = JSON.parse(initialBody)
  pendingCaptionNodes.find((node) => node.type === 'image-block').attrs.caption = 'Pending caption draft'
  const pendingCaptionBody = JSON.stringify(pendingCaptionNodes)
  const assertFocusedCaption = async (expected, expectedBody) => {
    assert.equal(await page.evaluate((expected) => { const saved = window.__resourceCaption; return saved.input.isConnected && saved.input === document.querySelector('.milkdown-image-block .caption-input') && saved.input.value === expected && document.activeElement === saved.input }, expected), true, 'Focused native history must retain the original caption input, exact value and focus')
    assert.equal(await rootLetter(), 'A', 'Focused native caption history must retain resource root A')
    assert.equal(JSON.stringify((await model()).content.filter((node) => node.type !== 'front_matter')), expectedBody, 'Focused native caption history must retain the complete body, changing only its caption')
  }
  const waitCaptionValue = (expected) => page.waitForFunction((expected) => { let caption; document.querySelector('.ProseMirror').pmViewDesc.node.descendants((node) => { if (node.type.name === 'image-block') caption = node.attrs.caption }); return caption === expected && document.querySelector('.milkdown-image-block .caption-input')?.value === expected }, expected)
  await assertFocusedCaption('Pending caption draft', pendingCaptionBody)
  const nativeCommandsBeforeFocusedUndo = (await nativeHistoryCommands()).length
  phase = 'caption: focused native menu undo after natural commit'
  await command('undo-document'); await waitCaptionValue('Original caption'); await waitUrls('A')
  await assertFocusedCaption('Original caption', initialBody)
  assert.deepEqual((await nativeHistoryCommands()).slice(nativeCommandsBeforeFocusedUndo).map((entry) => entry.direction), ['undo'], 'Focused menu Undo must dispatch exactly one native undo')
  phase = 'caption: focused native menu redo after natural commit'
  await command('redo-document'); await waitCaptionValue('Pending caption draft'); await waitUrls('A')
  await assertFocusedCaption('Pending caption draft', pendingCaptionBody)
  assert.deepEqual((await nativeHistoryCommands()).slice(nativeCommandsBeforeFocusedUndo).map((entry) => entry.direction), ['undo', 'redo'], 'Focused menu Undo/Redo must dispatch exactly those native directions')
  priorObservations[0].formalRegression = 'Passed in this run: focused native menu undo/redo after held URL delivery and natural commit, with exact input/PM values, original input identity/focus, root A and complete body preserved'
  check('Focused native caption menu undo/redo after held resource delivery and natural commit restores exact Original/Pending values in both input and PM, retaining original input/focus/root A/body', { undoScope: 'native input history while the original caption remains focused', directions: ['undo', 'redo'] })
  phase = 'caption: real body blur before shared document undo'
  await page.locator('.ProseMirror p').filter({ hasText: /^Body stays bold\.$/ }).click()
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ProseMirror')), true, 'A real body click must focus prose before requesting document history')
  const nativeCommandsBeforeDocumentUndo = (await nativeHistoryCommands()).length
  phase = 'caption: shared document undo after actual blur'
  await command('undo-document'); await page.waitForFunction(() => { let caption; document.querySelector('.ProseMirror').pmViewDesc.node.descendants((node) => { if (node.type.name === 'image-block') caption = node.attrs.caption }); return caption === 'Original caption' }); await waitUrls('A')
  assert.equal((await nativeHistoryCommands()).length, nativeCommandsBeforeDocumentUndo, 'This document Undo must not route to native input history')
  await page.waitForFunction(() => document.querySelector('.milkdown-image-block .caption-input')?.value === 'Original caption')
  assert.equal(await rootLetter(), 'A')
  assert.equal(JSON.stringify((await model()).content.filter((node) => node.type !== 'front_matter')), initialBody, 'One shared document Undo after native redo/real blur must restore the entire original body')
  phase = 'caption: restore root B after exact shared document undo'
  await setRoot('B'); await waitUrls('B')
  assert.equal(JSON.stringify((await model()).content.filter((node) => node.type !== 'front_matter')), initialBody)
  check('Active native caption control/draft survives pending URL delivery and its natural commit; one shared-document undo after real blur restores Original caption and keeps root A', { undoScope: 'shared document history after real body click', focusedNativeUndo: 'Strict focused native menu undo/redo passed earlier in this run; original failure remains in priorObservations' })

  phase = 'preview and frozen raw-snapshot exports'
  const snapshotB = await rawSnapshot(); assert.match(snapshotB.markdown, /typora-root-url: \.\.\/assetsB/)
  await command('toggle-split-mode'); await ready()
  const frame = page.frameLocator('.live-preview iframe')
  await frame.locator('img[alt="Markdown root"]').waitFor()
  await page.waitForFunction(({ image, audio }) => { const doc = document.querySelector('.live-preview iframe')?.contentDocument; const file = (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href } catch { return '' } }; return file(doc?.querySelector('img[alt="Markdown root"]')?.src) === image && file(doc?.querySelector('img[alt="HTML root"]')?.src) === image && file(doc?.querySelector('audio')?.src) === audio && file(doc?.querySelector('video source')?.src) === audio && file(doc?.querySelector('video')?.poster) === image }, { image: pathToFileURL(path.join(roots.B, 'cover.png')).href, audio: pathToFileURL(path.join(roots.B, 'tone.wav')).href })
  assert.equal(await sourceText(), snapshotB.markdown)
  await command('toggle-split-mode'); await ready(); await visualMode(); await waitUrls('B')
  const exportFiles = {}
  for (const format of ['html', 'pdf', 'png']) {
    phase = `frozen root-B ${format} export`
    const destination = artifact(`export.${format}`); exportFiles[format] = destination
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, destination)
    await command(`export-${format}`); await page.waitForFunction((name) => document.querySelector('.statusbar')?.textContent?.includes(name), path.basename(destination))
    const bytes = await readFile(destination)
    if (format === 'html') { const html = bytes.toString('utf8'); assert.ok(html.includes(`data:image/png;base64,${imageBytes.B.toString('base64')}`)); assert.ok(html.includes(`data:audio/wav;base64,${audioBytes.B.toString('base64')}`)); assert.ok(!html.includes(imageBytes.A.toString('base64'))) }
    else if (format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF')
    else assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'))
  }
  const exports = (await ipcRecords()).filter((entry) => entry.channel.startsWith('export:'))
  assert.equal(exports.length, 3); assert.ok(exports.every((entry) => entry.snapshot.sourcePath === note && entry.snapshot.markdown === snapshotB.markdown && entry.snapshot.html.includes('Markdown root')))
  const htmlInput = '<!doctype html><html><body><img alt="Snapshot A" src="cover.png"><audio controls src="tone.wav"></audio></body></html>'
  const previewA = await page.evaluate((request) => window.ttypora.preparePreview(request), { html: htmlInput, markdown: original, sourcePath: note, suggestedName: 'frozen-preview.html' })
  assert.ok(previewA.includes(pathToFileURL(path.join(roots.A, 'cover.png')).href)); assert.ok(!previewA.includes(pathToFileURL(path.join(roots.B, 'cover.png')).href))
  assert.equal(await readFile(note, 'utf8'), original)
  check('Live preview and HTML/PDF/PNG use the same captured raw root-B snapshot; explicit frozen root A wins over current root B', { exportFiles })

  phase = 'resource authorization rejects untitled, unauthorized path and outside root'
  const rejectionCases = await page.evaluate(async ({ documentPath, foreignPath, outsideMarkdown }) => {
    const rejected = async (operation) => { try { await operation(); return false } catch { return true } }
    return {
      untitledImage: await rejected(() => window.ttypora.resolveImageUrl({ documentPath: '', markdown: '' }, 'cover.png')),
      untitledMedia: await rejected(() => window.ttypora.resolveMediaUrl({ documentPath: '', markdown: '' }, 'tone.wav')),
      unauthorizedPath: await rejected(() => window.ttypora.resolveImageUrl({ documentPath: foreignPath, markdown: '' }, 'cover.png')),
      outsideImage: await rejected(() => window.ttypora.resolveImageUrl({ documentPath, markdown: outsideMarkdown }, 'cover.png')),
      outsideMedia: await rejected(() => window.ttypora.resolveMediaUrl({ documentPath, markdown: outsideMarkdown }, 'tone.wav')),
      rendererGrant: await rejected(() => window.ttypora.resolveImageUrl({ documentPath, markdown: '', authorizedRoot: 'C:/' }, 'cover.png')),
      unauthorizedPreview: await rejected(() => window.ttypora.preparePreview({ sourcePath: foreignPath, markdown: '', html: '<img src="cover.png">', suggestedName: 'preview.html' })),
    }
  }, { documentPath: note, foreignPath: path.join(outside, 'foreign.md'), outsideMarkdown: '---\ntypora-root-url: ../../outside\n---\n' })
  assert.ok(Object.values(rejectionCases).every(Boolean)); assert.deepEqual(blockedRequests, [])
  const untitledPreview = await page.evaluate(() => window.ttypora.preparePreview({ sourcePath: null, markdown: '![Unsaved](cover.png)', html: '<img src="cover.png"><audio controls src="tone.wav"></audio>', suggestedName: 'untitled-preview.html' }))
  assert.match(untitledPreview, /image-reference-placeholder/); assert.match(untitledPreview, /media-reference-placeholder/); assert.doesNotMatch(untitledPreview, /(?:src|poster)="(?:file:|cover\.png|tone\.wav)/)
  check('Real IPC rejects unsaved/unauthorized contexts, out-of-workspace roots and renderer-supplied grants', rejectionCases)

  phase = 'native image insertion copies to document assets and returns a readable rooted URL'
  await page.locator('.ProseMirror p').filter({ hasText: /^Body stays bold\.$/ }).click(); await page.keyboard.press('End')
  const beforeInsert = await model()
  await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, chosen)
  await command('insert-image'); await page.waitForFunction(() => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()).includes('chosen.png'))
  const insertedSnapshot = await rawSnapshot(), insertedModel = await model()
  const insertedSource = insertedModel.content.find((node) => node.type === 'image-block' && String(node.attrs.src).includes('chosen.png'))?.attrs.src
  assert.ok(insertedSource, 'Native insertion must create the copied image node')
  assert.deepEqual(await readFile(path.join(ownAssets, 'chosen.png')), await readFile(chosen))
  const insertedUrl = await page.evaluate(({ snapshot, source }) => window.ttypora.resolveImageUrl(snapshot, source), { snapshot: insertedSnapshot, source: insertedSource })
  assert.equal(fileURLToPath(insertedUrl), path.join(ownAssets, 'chosen.png'))
  await command('undo-document'); await page.waitForFunction((before) => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()) === JSON.stringify(before), beforeInsert)
  await command('redo-document'); await page.waitForFunction(() => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()).includes('chosen.png'))
  await command('undo-document'); await page.waitForFunction((before) => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()) === JSON.stringify(before), beforeInsert)
  check('Native insert-image retains the chosen original, copies into root-note.assets, resolves its returned URL under YAML root B and undoes/redoes as one operation')

  phase = 'per-document root and unsaved resource protection'
  await open(related); await page.waitForFunction((expected) => { const img = document.querySelector('img[alt="Related"]'); return img?.src?.startsWith(expected) && img.complete && img.naturalWidth === 2 }, pathToFileURL(path.join(roots.B, 'cover.png')).href)
  await sourceMode(); const source = page.locator('.source-editor .cm-content')
  await source.click(); await source.press('Control+Home'); await source.press('Control+a'); await page.keyboard.insertText('---\ntypora-root-url: ./root-note.assets\n---\n\n![Draft protector](draft-protected.png)\n')
  const relatedDraft = await sourceText(); await open(note); await visualMode(); await waitUrls('B')
  const librarySnapshot = await rawSnapshot()
  const inspected = await page.evaluate((request) => window.ttypora.listImages(request), { ...librarySnapshot, relatedDocuments: [{ path: related, markdown: relatedDraft }] })
  assert.equal(inspected.scanComplete, true); assert.ok(!inspected.orphans.some((item) => item.name === 'protected.png' || item.name === 'draft-protected.png')); assert.ok(inspected.orphans.some((item) => item.name === 'unrelated.png'))
  assert.equal(await readFile(related, 'utf8'), relatedOriginal)
  check('A second document uses its own root B; saved and unsaved sibling roots protect only the files they actually reference')

  phase = 'rooted resource library copy and rename through visible controls'
  await command('image-library')
  const library = page.getByRole('dialog', { name: '图片资源管理', exact: true })
  const settledLibrary = () => page.waitForFunction(() => document.querySelector('.image-library')?.getAttribute('aria-busy') === 'false')
  await library.waitFor(); await settledLibrary()
  await library.locator('.image-library__row').filter({ has: page.locator('strong', { hasText: /^cover\.png$/ }) }).click()
  await library.getByRole('button', { name: '复制到文档资源目录', exact: true }).click(); await library.getByRole('status').filter({ hasText: '已复制到文档资源目录' }).waitFor(); await settledLibrary()
  assert.deepEqual(await readFile(path.join(ownAssets, 'cover.png')), imageBytes.B)
  await library.locator('.image-library__row').filter({ has: page.locator('strong', { hasText: /^cover\.png$/ }) }).click()
  await library.getByLabel('图片文件名', { exact: true }).fill('renamed root.png')
  await library.getByRole('button', { name: '重命名引用', exact: true }).click(); await library.getByRole('status').filter({ hasText: '已将引用更新为 renamed root.png' }).waitFor(); await settledLibrary()
  await library.getByRole('button', { name: '完成', exact: true }).click(); await library.waitFor({ state: 'detached' }); await ready()
  const renamedSnapshot = await rawSnapshot(), renamedLibrary = await page.evaluate((request) => window.ttypora.listImages(request), renamedSnapshot)
  const renamedItem = renamedLibrary.items.find((item) => item.name === 'renamed root.png')
  assert.equal(renamedItem?.references, 3); assert.equal(renamedItem?.path, path.join(ownAssets, 'renamed root.png'))
  assert.deepEqual(await readFile(path.join(ownAssets, 'renamed root.png')), imageBytes.B); assert.deepEqual(await readFile(path.join(roots.B, 'cover.png')), imageBytes.B)
  for (const source of renamedItem.urls) {
    const url = await page.evaluate(({ snapshot, source }) => window.ttypora.resolveImageUrl(snapshot, source), { snapshot: renamedSnapshot, source })
    assert.equal(fileURLToPath(url), renamedItem.path)
  }
  check('Visible library copy/rename preserve all rooted Markdown/HTML/poster aliases, retain original bytes and return readable current-context URLs')

  phase = 'real mock-CLI upload rejects changed root at apply'
  await command('image-uploader')
  const uploader = page.getByRole('dialog', { name: '图片上传', exact: true })
  await uploader.waitFor(); await application.evaluate(({ dialog }, executable) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [executable] }) }, process.execPath)
  await uploader.getByRole('button', { name: '选择上传程序…', exact: true }).click()
  await page.waitForFunction((expected) => document.querySelector('.image-uploader__program code')?.textContent === expected, process.execPath)
  await page.evaluate((args) => window.ttypora.configureImageUploader({ adapter: 'custom', args, timeoutSeconds: 10 }), [mockCli, '{file}'])
  await uploader.getByRole('button', { name: '完成', exact: true }).click(); await uploader.waitFor({ state: 'detached' })
  const candidates = await page.evaluate((request) => window.ttypora.listImageUploadCandidates(request), renamedSnapshot)
  assert.equal(candidates.length, 1)
  const task = await page.evaluate((request) => window.ttypora.uploadImages(request), { ...renamedSnapshot, images: [{ imageId: candidates[0].id, expectedVersion: candidates[0].version }] })
  assert.equal(task.status, 'complete'); assert.equal(task.items[0].status, 'success')
  const cliCalls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(cliCalls.length, 1); assert.equal(cliCalls[0].bytes, imageBytes.B.toString('base64')); assert.ok(!cliCalls[0].source.startsWith(workspace))
  await setRoot('A'); const beforeApply = await model(), changedSnapshot = await rawSnapshot()
  const applyRejected = await page.evaluate(async (request) => { try { await window.ttypora.applyImageUploads(request); return { rejected: false } } catch (error) { return { rejected: true, message: String(error) } } }, { ...changedSnapshot, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [task.items[0].id] })
  assert.equal(applyRejected.rejected, true); assert.match(applyRejected.message, /资源根|保存位置/); assert.deepEqual(await model(), beforeApply)
  await setRoot('B')
  check('Genuine upload IPC freezes root-B bytes for a local CLI; changing the YAML root rejects apply even when frozen-original approval is supplied', { cliCalls: cliCalls.length })

  phase = 'Save As invalidates pending native insertion'
  const beforeStaleInsert = await model(), renamedPath = path.join(documents, 'renamed-note.md')
  await arm(['image:choose'])
  await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, chosen)
  await command('insert-image'); await waitPending()
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, renamedPath)
  await command('save-document-as'); await page.waitForFunction(() => document.title.includes('renamed-note.md')); activePath = renamedPath
  await release(); await page.waitForFunction(() => document.body.innerText.includes('插入期间文档发生变化')); await frames()
  assert.deepEqual(await model(), beforeStaleInsert)
  const savedAfterRename = await rawSnapshot(); assert.equal(await readFile(renamedPath, 'utf8'), savedAfterRename.markdown)
  check('Changing the saved path rejects a delayed genuine insert-image result and leaves the renamed document unchanged')

  assert.deepEqual(blockedRequests, []); assert.deepEqual(pageErrors, [])
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  await page.screenshot({ path: artifact('writing.png'), animations: 'disabled', timeout: 60000 })
  await writeFile(artifact('verification.json'), JSON.stringify({ variant: packaged ? 'packaged' : 'source', version: await application.evaluate(({ app }) => app.getVersion()), interaction: 'Native keyboard/YAML/caption/source editing, native app menu commands and visible library controls; model/DOM read only. Real registered main IPC is observed and selected results delayed; it is never replaced with a fabricated resolver.', checks, exclusions, priorObservations, blockedRequests, pageErrors, nativeHistoryCommands: await nativeHistoryCommands(), ipc: await ipcRecords() }, null, 2) + '\n')
} catch (error) {
  let diagnostic = { unavailable: true }
  if (page && !page.isClosed()) {
    diagnostic = await page.evaluate(() => ({ body: document.body.innerText, model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(), source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString(), yaml: document.querySelector('.front-matter-source')?.textContent, yamlNavigation: window.__resourceRootYAMLNavigation ?? [], images: [...document.querySelectorAll('.ProseMirror img')].map((image) => ({ alt: image.alt, src: image.src, loaded: image.complete, width: image.naturalWidth })), media: [...document.querySelectorAll('.ProseMirror audio,.ProseMirror video,.ProseMirror source')].map((element) => ({ tag: element.tagName, src: element.getAttribute('src'), poster: element.getAttribute('poster') })), caption: [...document.querySelectorAll('.caption-input')].map((input) => ({ value: input.value, from: input.selectionStart, to: input.selectionEnd, focused: document.activeElement === input })), selection: window.getSelection()?.toString() })).catch(() => diagnostic)
    await page.screenshot({ path: artifact('failure.png'), animations: 'disabled', timeout: 60000 }).catch(() => undefined)
  }
  await writeFile(artifact('failure.json'), JSON.stringify({ phase, error: String(error), stack: error?.stack, checks, exclusions, priorObservations, diagnostic, pageErrors, blockedRequests, nativeHistoryCommands: application ? await application.evaluate(() => globalThis.__resourceRootControl?.nativeEdits ?? []).catch(() => []) : [], ipc: application ? await application.evaluate(() => globalThis.__resourceRootControl?.records ?? []).catch(() => []) : [] }, null, 2) + '\n')
  throw error
} finally {
  if (application) await application.evaluate(({ ipcMain }) => { const control = globalThis.__resourceRootControl; if (!control) return; ipcMain.removeListener('edit:native-history', control.observeNativeEdit); control.delay = null; control.pending.splice(0).forEach(({ resolve }) => resolve()); for (const [channel, original] of control.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) } }).catch(() => undefined)
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  const actualTemporary = await realpath(temporary), actualParent = await realpath(tmpdir())
  const relative = path.relative(actualParent, actualTemporary)
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.' && path.basename(actualTemporary).startsWith('ttypora-resource-root-'), 'Refusing cleanup outside the exact newly created fixture directory')
  await rm(actualTemporary, { recursive: true, force: true })
}
