import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { _electron as electron } from 'playwright'
import { fromHtml } from 'hast-util-from-html'

// Run serially against the built source or package, with isolated user data.
let root = path.dirname(fileURLToPath(import.meta.url))
while (!existsSync(path.join(root, 'package.json'))) { const parent = path.dirname(root); assert.notEqual(parent, root, 'Repository package.json missing'); root = parent }
const packaged = process.env.TTYPORA_PACKAGED_EXE
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v${version}-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'), 'Invalid evidence prefix')
const artifacts = path.join(root, 'artifacts'), artifact = (suffix) => path.join(artifacts, `selection-copy-${prefix}-${suffix}`)
for (const suffix of ['verification.json', 'failure.json', 'cleanup.json']) assert(!existsSync(artifact(suffix)), `Evidence exists for ${prefix}; choose a fresh prefix`)
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-selection-copy-'))
const workspace = path.join(temporary, 'notes'), docs = path.join(workspace, 'docs'), assets = path.join(workspace, 'assets')
const texts = {
  prose: '# Prose selection\n\nAlpha **BOLDTOKEN** omega.\n\nSecond *ITALICTOKEN* tail.\n\nUNSELECTED sentinel.\n',
  source: '# Source selection\n\nBefore **PARTIAL** after & ordinary.\n\nWhitespace:  \t end.\n\nUNSELECTED source sentinel.\n',
  embedded: '# Embedded selection\n\nBody stays.\n\n```text title="native.txt"\nliteral **NOT_BOLD** <tag>&\n```\n\nInline $\\frac{a}{b}$ tail.\n\nUNSELECTED embedded sentinel.\n',
  table: '# Cell selection\n\n| H1 | H2 |\n| --- | --- |\n| **A1** | B1 |\n| A2 | B2 |\n\nUNSELECTED table sentinel.\n',
  resource: '---\ntypora-root-url: ../assets\n---\n\n# Resource selection\n\nUNSELECTED resource sentinel.\n\n![Owned](owned.png)\n\n![Outside](../../outside.png)\n\nTail stays.\n',
  other: '# Other tab\n\nOther document stays unchanged.\n',
}
const files = Object.fromEntries(Object.keys(texts).map((name) => [name, path.join(docs, `${name}.md`)]))
function fixturePng() {
  const crc = (bytes) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0) }; return (value ^ 0xffffffff) >>> 0 }
  const chunk = (name, bytes) => { const type = Buffer.from(name), result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); type.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc(Buffer.concat([type, bytes])), result.length - 4); return result }
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 40, 65, 175, 40, 65, 175, 0, 40, 65, 175, 40, 65, 175]))), chunk('IEND', Buffer.alloc(0))])
}
const imageBytes = fixturePng()
const resourceFragment = '![Owned](owned.png)\n\n![Outside](../../outside.png)'
const sameDraft = '# Same draft\n\nExact same **DRAFT_TOKEN** body.\n'
const groups = [], cases = [], errors = [], consoleMessages = [], requests = [], menus = []
let application, page, activePath = null, phase = 'fixtures', report = null
const cleanup = { fixtureDirectory: temporary, handlerIdentities: null, nativeObserverRemoved: null, applicationClosed: null, forcedTermination: false, processExited: null, mainPidGone: null, fixtureRemoved: false }
const exclusions = [
  'Prepared with a syntax check only. No GUI/build/unit PASS is claimed by preparation; a complete verification report requires an actual serial source or packaged run.',
  'Native menu item callbacks invoke the real installed application menu. Menu window painting, the OS file picker, and multi-platform clipboard interoperability are outside this suite.',
  'Every PM/CM/input selection and document edit is created by real Playwright mouse/keyboard events. PM document/view descriptors and CM state are inspected read-only; no selection/content transaction, bookmark, React/Vue state, or IPC authorization/result is fabricated.',
  'Only original registered clipboard:prepare-selection and clipboard:write handlers are wrapped. Each original executes first. A controlled hold delays delivery of a genuine preparation result; it does not simulate naturally occurring OS scheduling.',
  'HTML assertions parse strings into a host-side HAST. No browser document is populated with clipboard HTML and no image/browser resource loads are initiated by the assertions.',
  'Clipboard sentinel writes use real Electron ClipboardItem and clipboard.write; product writes are separately observed through the original clipboard:write handler.',
  'CellSelection remains an explicit rejection for the new format commands; the existing Ctrl+C HTML/data-pm-slice/TSV protocol is checked independently.',
  'No custom multi-range injection, IME simulation, size-limit benchmark, unsupported-node fabrication, external app paste, or natural race-frequency measurement is claimed.',
  'Success is emitted only after all real preparation/write results settle, original handler/listener identities are restored, the normal application close succeeds, its main PID is gone, and the exact new fixture directory is removed.',
]
const textOf = (node) => node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join('')
const elements = (html, tag) => { const found = []; const visit = (node) => { if (node.type === 'element' && node.tagName === tag) found.push(node); node.children?.forEach(visit) }; visit(fromHtml(html)); return found }
const bodyText = (html) => { const body = elements(html, 'body')[0]; return body ? textOf(body) : textOf(fromHtml(html, { fragment: true })) }
const outsideRequests = () => requests.filter((entry) => { try { return new URL(entry.url).pathname.toLowerCase().endsWith('/outside.png') } catch { return entry.url.includes('outside.png') } })
const completeCase = (name, detail = {}) => { cases.push({ phase, name, ...detail }); console.log(`CHECK ${name}`) }
const completeGroup = (name) => { groups.push({ name, cases: cases.filter((item) => item.phase.startsWith(`${groups.length + 1}:`)).map((item) => item.name) }); console.log(`GROUP ${groups.length}/6 ${name}`) }

try {
  for (const directory of [docs, assets, artifacts]) await mkdir(directory, { recursive: true })
  for (const [name, markdown] of Object.entries(texts)) await writeFile(files[name], markdown)
  await writeFile(path.join(assets, 'owned.png'), imageBytes); await writeFile(path.join(temporary, 'outside.png'), imageBytes)
  const flags = ['--disable-gpu', '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  phase = 'launch'
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? flags : [...flags, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text(), at: Date.now() }) })
  page.on('request', (request) => requests.push({ url: request.url(), type: request.resourceType(), at: Date.now() }))
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await application.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1360, 960); window.show(); window.focus()
    const control = { originals: new Map(), records: [], hold: false, pending: [], nativeEdits: [], restored: false }
    globalThis.__selectionCopyControl = control
    control.nativeObserver = (_event, direction) => control.nativeEdits.push({ direction, at: Date.now() })
    ipcMain.on('edit:native-history', control.nativeObserver)
    for (const channel of ['clipboard:prepare-selection', 'clipboard:write']) {
      const original = ipcMain._invokeHandlers?.get(channel)
      if (typeof original !== 'function') throw new Error(`Missing original registered ${channel}; integrate/build selection-copy before running`)
      control.originals.set(channel, original); ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        const record = { index: control.records.length, channel, input: args[0], startedAt: Date.now(), completed: false, delivered: false, held: false }
        control.records.push(record)
        let result
        try { result = await original(event, ...args); record.result = result; record.completed = true; record.completedAt = Date.now() }
        catch (error) { record.error = String(error); record.completed = record.delivered = true; record.completedAt = record.deliveredAt = Date.now(); throw error }
        if (channel === 'clipboard:prepare-selection' && control.hold) { control.hold = false; record.held = true; await new Promise((resolve) => control.pending.push({ index: record.index, resolve })) }
        record.delivered = true; record.deliveredAt = Date.now(); return result
      })
    }
  })
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version)
  const menu = async (name) => {
    const result = await application.evaluate(({ Menu, BrowserWindow }, name) => {
      const specs = {
        workspace: { labels: ['打开文件夹…', 'Open folder…'] }, files: { accelerator: 'CmdOrCtrl+Shift+3' }, source: { accelerator: 'CmdOrCtrl+/' },
        new: { accelerator: 'CmdOrCtrl+N' }, save: { accelerator: 'CmdOrCtrl+S' }, undo: { accelerator: 'CmdOrCtrl+Z' }, redo: { accelerator: 'CmdOrCtrl+Y' },
        preferences: { accelerator: 'CmdOrCtrl+,' }, find: { accelerator: 'CmdOrCtrl+F' },
        markdown: { labels: ['复制选区为 Markdown', 'Copy selection as Markdown'] },
        html: { labels: ['复制选区为 HTML', 'Copy selection as HTML'] },
        text: { labels: ['复制选区为纯文本', 'Copy selection as plain text'] },
      }
      const items = [], visit = (menu) => menu?.items.forEach((item) => { items.push(item); if (item.submenu) visit(item.submenu) }); visit(Menu.getApplicationMenu())
      const spec = specs[name], item = items.find((item) => item.visible && item.enabled && (spec.accelerator && item.accelerator === spec.accelerator || spec.labels?.includes(item.label.replace(/&/g, ''))))
      if (!item || typeof item.click !== 'function') throw new Error(`Genuine menu item missing: ${name}`)
      item.click(item, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], {}); return { name, label: item.label, accelerator: item.accelerator }
    }, name)
    menus.push(result); return result
  }
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror,.source-editor .cm-content').first().waitFor() }
  const frames = (count = 3) => page.evaluate((count) => new Promise((resolve) => { const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next) }), count)
  const model = () => page.evaluate(() => document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON())
  const waitModel = (expected) => page.waitForFunction((expected) => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()) === JSON.stringify(expected), expected)
  const source = () => page.locator('.source-editor .cm-content')
  const cmText = (locator = source()) => locator.evaluate((element) => element.cmTile.root.view.state.doc.toString())
  const cmSelected = (locator = source()) => locator.evaluate((element) => { const view = element.cmTile.root.view, selection = view.state.selection.main; return { from: selection.from, to: selection.to, text: view.state.doc.sliceString(selection.from, selection.to), ranges: view.state.selection.ranges.length } })
  const sourceMode = async () => { if (!await source().count()) { await menu('source'); await ready() }; await source().waitFor() }
  const visualMode = async () => { if (await source().count()) { await menu('source'); await ready() }; await page.locator('.ProseMirror').waitFor() }
  const open = async (name, mode = 'visual') => {
    if (activePath !== files[name]) {
      await menu('files'); await page.locator('.file-tree').getByTitle(files[name], { exact: true }).click(); activePath = files[name]
    }
    await page.waitForFunction((name) => document.title.includes(name) && document.title.endsWith('Penlume'), `${name}.md`); await ready()
    if (mode === 'source') await sourceMode(); else await visualMode()
    await frames(4)
  }
  const save = async () => {
    await menu('save'); await page.waitForFunction(() => !document.title.startsWith('●') && /已保存：|文档没有需要保存的修改|Saved:|No document changes to save/.test(document.querySelector('.statusbar')?.textContent ?? ''))
    return activePath ? readFile(activePath, 'utf8') : null
  }
  const rawRoundTrip = async (raw, expectedModel) => { await sourceMode(); assert.equal(await cmText(), raw); await visualMode(); if (expectedModel) assert.deepEqual(await model(), expectedModel) }
  const proseRange = () => page.evaluate(() => {
    const prose = document.querySelector('.ProseMirror'), selection = window.getSelection()
    if (!prose || !selection?.anchorNode || !selection.focusNode || !prose.contains(selection.anchorNode) || !prose.contains(selection.focusNode)) return null
    return { anchor: prose.pmViewDesc.posFromDOM(selection.anchorNode, selection.anchorOffset, 1), head: prose.pmViewDesc.posFromDOM(selection.focusNode, selection.focusOffset, 1), text: selection.toString(), collapsed: selection.isCollapsed }
  })
  const selectProse = async (firstText, start, lastText = firstText, end = firstText.length) => {
    const paragraph = page.locator('.ProseMirror p').filter({ hasText: new RegExp(`^${firstText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first()
    await paragraph.scrollIntoViewIfNeeded(); await paragraph.click(); await page.keyboard.press('Home')
    const target = await page.evaluate(({ firstText, start, lastText, end }) => {
      const prose = document.querySelector('.ProseMirror'), found = []
      prose.pmViewDesc.node.descendants((node, position) => { if (node.type.name === 'paragraph') found.push({ text: node.textContent, position: position + 1 }) })
      const first = found.find((item) => item.text === firstText), last = found.find((item) => item.text === lastText)
      if (!first || !last) throw new Error('Unique paragraph fixture missing')
      return { anchor: first.position + start, head: last.position + end }
    }, { firstText, start, lastText, end })
    // Crossing a mark boundary can consume an arrow key without advancing the
    // native caret. Inspect its position and continue using real key presses.
    for (let guard = 0; guard < 500; guard++) {
      const actual = await proseRange()
      if (actual?.anchor === target.anchor) break
      assert.ok(actual && actual.anchor < target.anchor, 'Native caret overshot the selected start')
      await page.keyboard.press('ArrowRight')
    }
    const initial = await proseRange(); assert.ok(initial); assert.equal(initial.anchor, target.anchor); assert.equal(initial.head, target.anchor)
    for (let guard = 0; guard < 500; guard++) {
      const actual = await proseRange(); if (actual?.head === target.head) break
      assert.ok(actual && actual.anchor === target.anchor && actual.head < target.head, 'Native cross-block range overshot its exact end')
      await page.keyboard.press('Shift+ArrowRight')
    }
    const actual = await proseRange(); assert.equal(actual.anchor, target.anchor); assert.equal(actual.head, target.head); assert.equal(actual.collapsed, target.anchor === target.head)
    return actual
  }
  const selectCM = async (locator, from, to) => {
    await locator.click(); await page.keyboard.press('Control+Home')
    for (let index = 0; index < from; index++) await page.keyboard.press('ArrowRight')
    for (let index = from; index < to; index++) await page.keyboard.press('Shift+ArrowRight')
    const actual = await cmSelected(locator); assert.equal(actual.from, from); assert.equal(actual.to, to); assert.equal(actual.ranges, 1); return actual
  }
  const sourceSelect = async (needle) => { const raw = await cmText(), from = raw.indexOf(needle); assert.ok(from >= 0 && raw.indexOf(needle, from + 1) === -1, 'Source fixture fragment must be unique'); return selectCM(source(), from, from + needle.length) }
  const palette = async (format) => {
    await page.locator('.command-trigger').click()
    const title = { markdown: '复制选区为 Markdown', html: '复制选区为 HTML', text: '复制选区为纯文本' }[format]
    const input = page.getByRole('combobox', { name: '搜索命令', exact: true }); await input.waitFor(); await input.fill(title)
    await page.getByRole('option').filter({ hasText: title }).click(); await page.getByRole('combobox').waitFor({ state: 'detached' })
  }
  const clipboardRead = () => application.evaluate(async ({ clipboard }) => { const items = await clipboard.read(), html = items.find((item) => item.types.includes('text/html')); return { text: await clipboard.readText(), html: html ? await (await html.getType('text/html')).text() : '' } })
  const sentinel = async (name) => {
    await application.evaluate(async ({ clipboard, ClipboardItem }, name) => clipboard.write([new ClipboardItem({ 'text/plain': `SENTINEL:${name}`, 'text/html': `<p>SENTINEL:${name}</p>` })]), name)
    return clipboardRead()
  }
  const records = () => application.evaluate(() => globalThis.__selectionCopyControl.records)
  const writes = async () => (await records()).filter((entry) => entry.channel === 'clipboard:write')
  const nativeEdits = () => application.evaluate(() => globalThis.__selectionCopyControl.nativeEdits)
  const waitRecords = async (predicate, message) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { const current = await records(); if (predicate(current)) return current; await frames() }; throw new Error(message) }
  const copy = async (format, viaPalette = false) => {
    const before = (await writes()).length
    if (viaPalette) await palette(format); else await menu(format)
    const current = await waitRecords((entries) => entries.filter((entry) => entry.channel === 'clipboard:write').length === before + 1 && entries.filter((entry) => entry.channel === 'clipboard:write').at(-1).delivered, 'Genuine clipboard write never completed')
    const entry = current.filter((entry) => entry.channel === 'clipboard:write').at(-1); assert.equal(entry.error, undefined)
    const actual = await clipboardRead(); assert.equal(actual.text, entry.input.text)
    if (format !== 'html') assert.equal(actual.html, '', 'Markdown/plain copy must clear an earlier HTML clipboard flavor')
    else {
      assert.ok(actual.html, 'HTML format must write real HTML')
      // Windows CF_HTML may add transport metadata on read. Assert the exact
      // product submission is a fragment, then inspect real read-back content.
      assert.ok(typeof entry.input.html === 'string' && entry.input.html.length)
      assert.doesNotMatch(entry.input.html, /<!doctype|<\/?(?:html|head|body|style|meta|title)(?:\s|>)/i, 'Product HTML submission must contain only the selected body fragment')
    }
    await frames(); return { actual, entry }
  }
  const rejectedCopy = async (format, expected, viaPalette = false, restoreSelection = null) => {
    // A previous identical refusal must not satisfy this action's status wait.
    // Real Save reports a distinct status. Restore the intended native range
    // afterward, because existing Save/bookmark handling is outside this case.
    await save()
    assert.ok(!(await page.locator('.statusbar').innerText()).includes(expected))
    if (restoreSelection) await restoreSelection()
    const clip = await sentinel(`${phase}:${format}`), before = (await writes()).length
    if (viaPalette) await palette(format); else await menu(format)
    await page.waitForFunction((expected) => document.querySelector('.statusbar')?.textContent?.includes(expected), expected); await frames(5)
    assert.deepEqual(await clipboardRead(), clip); assert.equal((await writes()).length, before)
  }
  const switchLocale = async (locale) => {
    await menu('preferences'); await page.locator('.preferences fieldset').first().locator('select').selectOption(locale)
    await page.waitForFunction((locale) => document.documentElement.lang === locale, locale)
    await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'Done' : '完成', exact: true }).click(); await frames()
  }
  const hold = async () => { const before = (await records()).length; await application.evaluate(() => { const control = globalThis.__selectionCopyControl; if (control.pending.length || control.hold) throw new Error('Previous hold unresolved'); control.hold = true }); return before }
  const release = () => application.evaluate(() => { const control = globalThis.__selectionCopyControl; control.hold = false; control.pending.splice(0).forEach(({ resolve }) => resolve()) })
  const waitHeld = async (from) => {
    const current = await waitRecords((entries) => entries.slice(from).some((entry) => entry.channel === 'clipboard:prepare-selection' && entry.held && entry.completed && !entry.delivered), 'Original preparation result did not reach the controlled hold')
    const entry = current.slice(from).find((entry) => entry.channel === 'clipboard:prepare-selection' && entry.held); assert.equal(entry.error, undefined); assert.ok(entry.result?.html); return entry
  }
  const verifyCanceled = async (start, clip, count) => {
    await release(); await waitRecords((entries) => entries.slice(start).every((entry) => entry.completed && entry.delivered), 'Held genuine result did not settle'); await frames(8)
    assert.deepEqual(await clipboardRead(), clip); assert.equal((await writes()).length, count, 'A stale preparation must never submit a clipboard write')
  }

  await ready(); await menu('workspace')

  phase = '1: PM partial marks, cross-block fragments and history'
  await open('prose'); const proseBaseline = await model(); assert.equal(await save(), texts.prose)
  const first = 'Alpha BOLDTOKEN omega.', second = 'Second ITALICTOKEN tail.'
  const partial = () => selectProse(first, 7, first, 10)
  await partial(); let result = await copy('markdown'); assert.equal(result.actual.text, '**OLD**\n')
  await partial(); result = await copy('html'); assert.equal(result.actual.text, 'OLD'); assert.deepEqual(elements(result.actual.html, 'strong').map(textOf), ['OLD']); assert.ok(!result.actual.html.includes('UNSELECTED'))
  await partial(); result = await copy('text'); assert.equal(result.actual.text, 'OLD'); assert.deepEqual(await model(), proseBaseline)
  const cross = () => selectProse(first, 6, second, 7 + 'ITALICTOKEN'.length)
  const crossMarkdown = '**BOLDTOKEN** omega.\n\nSecond *ITALICTOKEN*\n', crossText = 'BOLDTOKEN omega.\n\nSecond ITALICTOKEN'
  await cross(); result = await copy('markdown'); assert.equal(result.actual.text, crossMarkdown)
  await cross(); result = await copy('html'); assert.equal(result.actual.text, crossText); assert.deepEqual(elements(result.actual.html, 'strong').map(textOf), ['BOLDTOKEN']); assert.deepEqual(elements(result.actual.html, 'em').map(textOf), ['ITALICTOKEN']); assert.ok(!result.actual.html.includes('UNSELECTED'))
  await cross(); result = await copy('text'); assert.equal(result.actual.text, crossText)
  assert.deepEqual(await model(), proseBaseline); await rawRoundTrip(texts.prose, proseBaseline); assert.equal(await save(), texts.prose)
  completeCase('Partial strong span and exact cross-block rich fragments copy in all three formats while source/model/file remain unchanged')
  await selectProse('UNSELECTED sentinel.', 'UNSELECTED sentinel.'.length); await page.keyboard.insertText(' HISTORY_EDIT')
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('HISTORY_EDIT')); const editedModel = await model()
  const nativeBefore = (await nativeEdits()).length
  for (const format of ['markdown', 'html', 'text']) { await partial(); await copy(format) }
  await selectProse(first, 0, first, 0); await menu('undo'); await waitModel(proseBaseline)
  await menu('redo'); await waitModel(editedModel); await menu('undo'); await waitModel(proseBaseline)
  assert.equal((await nativeEdits()).length, nativeBefore); await rawRoundTrip(texts.prose, proseBaseline); assert.equal(await save(), texts.prose)
  completeCase('Copy inserts no document history entry: one genuine shared Undo/Redo restores the preceding atomic body edit and full model')
  completeGroup('PM rich fragments and unchanged document history')

  phase = '2: source CM exact primary selection and rendering'
  await open('source', 'source'); assert.equal(await cmText(), texts.source)
  for (const format of ['markdown', 'html', 'text']) {
    await sourceSelect('**PARTIAL**'); result = await copy(format)
    assert.equal(result.actual.text, format === 'markdown' ? '**PARTIAL**' : 'PARTIAL')
    if (format === 'html') assert.deepEqual(elements(result.actual.html, 'strong').map(textOf), ['PARTIAL'])
    assert.equal(await cmText(), texts.source)
  }
  for (const format of ['markdown', 'html', 'text']) {
    await sourceSelect('**PART'); result = await copy(format); assert.equal(result.actual.text, '**PART')
    if (format === 'html') { assert.equal(elements(result.actual.html, 'strong').length, 0); assert.ok(bodyText(result.actual.html).includes('**PART')) }
  }
  for (const format of ['markdown', 'html', 'text']) {
    await sourceSelect('  \t'); result = await copy(format); assert.equal(result.actual.text, '  \t')
    if (format === 'html') assert.deepEqual(elements(result.actual.html, 'pre').map(textOf), ['  \t'])
  }
  assert.equal(await cmText(), texts.source); assert.equal(await save(), texts.source)
  completeCase('Source primary ranges preserve raw Markdown/partial syntax and whitespace exactly; HTML/plain render only the selected fragment')
  await source().click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('SOURCE_HISTORY_EDIT')
  await page.waitForFunction(() => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().endsWith('SOURCE_HISTORY_EDIT'))
  const editedSource = await cmText(); await sourceSelect('**PARTIAL**'); await copy('html')
  await source().click(); await menu('undo'); await page.waitForFunction((raw) => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === raw, texts.source)
  await menu('redo'); await page.waitForFunction((raw) => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === raw, editedSource)
  await menu('undo'); await page.waitForFunction((raw) => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === raw, texts.source); assert.equal(await save(), texts.source)
  completeCase('Source copy adds no history edit; the preceding typed change is one genuine Undo/Redo unit')
  completeGroup('Source exact selection and fragment rendering')

  phase = '3: embedded native fields and pointer palette capture'
  await open('embedded'); const embeddedBaseline = await model(), code = page.locator('.ttypora-code-block .cm-content').first()
  const literal = '**NOT_BOLD** <tag>&', codeRaw = await cmText(code), codeFrom = codeRaw.indexOf(literal)
  assert.ok(codeFrom >= 0)
  for (const format of ['markdown', 'html', 'text']) {
    await selectCM(code, codeFrom, codeFrom + literal.length); result = await copy(format, true); assert.equal(result.actual.text, literal)
    if (format === 'html') { assert.deepEqual(elements(result.actual.html, 'pre').map(textOf), [literal]); assert.equal(elements(result.actual.html, 'strong').length, 0); assert.equal(elements(result.actual.html, 'tag').length, 0) }
    assert.deepEqual(await model(), embeddedBaseline)
  }
  const formula = page.locator('.ttypora-math-inline [data-math-source-editor]').first()
  if (!await formula.isVisible()) await page.locator('.ttypora-math-inline-edit').first().click()
  for (const format of ['markdown', 'html', 'text']) {
    await formula.click(); await page.keyboard.press('Home'); for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowRight')
    assert.equal(await formula.evaluate((input) => input.value.slice(input.selectionStart, input.selectionEnd)), '\\frac')
    result = await copy(format, true); assert.equal(result.actual.text, '\\frac')
    if (format === 'html') assert.deepEqual(elements(result.actual.html, 'pre').map(textOf), ['\\frac'])
    assert.deepEqual(await model(), embeddedBaseline)
  }
  await rawRoundTrip(texts.embedded, embeddedBaseline); assert.equal(await save(), texts.embedded)
  completeCase('Owned embedded CodeMirror and inline math input ranges remain literal in all three formats after genuine header pointerdown opens the palette')
  completeGroup('Native field selection survives command palette focus')

  phase = '4: empty and foreign input guards'
  await open('prose'); const emptyBaseline = await model()
  for (const format of ['markdown', 'html', 'text']) await rejectedCopy(format, '请先在文档中选择内容。', false, () => selectProse(first, 0, first, 0))
  await partial(); await menu('find'); const search = page.locator('.search-panel input').first(); await search.waitFor()
  await search.fill('FOREIGN_QUERY'); await search.press('Control+a')
  const restoreForeign = async () => { await search.click(); await search.press('Control+a') }
  for (const format of ['markdown', 'html', 'text']) await rejectedCopy(format, '请先在文档中选择内容。', false, restoreForeign)
  await rejectedCopy('markdown', '请先在文档中选择内容。', true, restoreForeign)
  await search.press('Escape'); assert.deepEqual(await model(), emptyBaseline); await rawRoundTrip(texts.prose, emptyBaseline); assert.equal(await save(), texts.prose)
  completeCase('Empty caret and selected foreign find input reject without reviving an earlier prose range or overwriting either clipboard flavor')
  completeGroup('No whole-document fallback for empty or foreign focus')

  phase = '5: existing CellSelection clipboard protocol'
  await open('table'); const tableBaseline = await model(), tableSelector = '.ProseMirror .milkdown-table-block table.children'
  const cell = (row, column) => page.locator(tableSelector).first().locator('tbody[data-content-dom="true"] > tr').nth(row).locator('th,td').nth(column).locator('p').first()
  const clickCell = async (row, column, modifiers = []) => {
    const paragraph = cell(row, column); await paragraph.scrollIntoViewIfNeeded()
    const position = await paragraph.evaluate((element) => {
      const rect = element.getBoundingClientRect(), target = element.closest('th,td')
      for (const x of [16, 24, rect.width / 2, rect.width - 16]) for (const y of [rect.height / 2, 8]) {
        const dx = Math.max(2, Math.min(rect.width - 2, x)), dy = Math.max(2, Math.min(rect.height - 2, y)), hit = document.elementFromPoint(rect.left + dx, rect.top + dy)
        if (hit && element.contains(hit) && hit.closest('th,td') === target && !hit.closest('a,button,input,textarea,select,[contenteditable="false"],.handle,.column-resize-handle')) return { x: dx, y: dy }
      }
      return null
    })
    assert.ok(position); await paragraph.click({ position, modifiers })
  }
  const rectangle = async () => { await clickCell(1, 0); await clickCell(2, 1, ['Shift']); await page.waitForFunction((selector) => document.querySelector(selector)?.querySelectorAll('tbody[data-content-dom="true"] .selectedCell').length === 4, tableSelector) }
  await rectangle(); await page.keyboard.press('Control+c'); const tableClipboard = await clipboardRead()
  assert.equal(tableClipboard.text, 'A1\tB1\r\nA2\tB2'); assert.match(tableClipboard.html, /data-pm-slice=/); assert.deepEqual(elements(tableClipboard.html, 'strong').map(textOf), ['A1'])
  for (const format of ['markdown', 'html', 'text']) {
    await rejectedCopy(format, '此选区暂不支持格式复制；表格矩形请使用 Ctrl+C。', false, rectangle)
    assert.deepEqual(await model(), tableBaseline)
  }
  await rectangle(); await page.keyboard.press('Control+c'); const tableClipboardAgain = await clipboardRead()
  assert.equal(tableClipboardAgain.text, tableClipboard.text); assert.match(tableClipboardAgain.html, /data-pm-slice=/); assert.deepEqual(elements(tableClipboardAgain.html, 'strong').map(textOf), ['A1'])
  await rawRoundTrip(texts.table, tableBaseline); assert.equal(await save(), texts.table)
  completeCase('Real Shift-click rectangle retains Ctrl+C TSV/rich HTML protocol, explicitly rejects all new format commands, and remains intact afterward')
  completeGroup('CellSelection behavior is preserved')

  phase = '6: authorized resource context and stale genuine preparation'
  await open('resource', 'source'); await sourceSelect(resourceFragment); const resourcesStart = (await records()).length
  result = await copy('html'); const prepared = (await records()).slice(resourcesStart).find((entry) => entry.channel === 'clipboard:prepare-selection')
  assert.ok(prepared && prepared.completed && prepared.delivered); assert.equal(prepared.input.markdown, texts.resource); assert.equal(prepared.input.sourcePath, files.resource)
  assert.ok(!prepared.input.html.includes('UNSELECTED') && !prepared.input.html.includes('typora-root-url'))
  const copiedImages = elements(result.actual.html, 'img'); assert.equal(copiedImages.length, 1); assert.equal(copiedImages[0].properties.src, `data:image/png;base64,${imageBytes.toString('base64')}`)
  const placeholders = elements(result.actual.html, 'span').filter((node) => (node.properties.className ?? []).includes('image-reference-placeholder'))
  assert.equal(placeholders.length, 1); assert.equal(placeholders[0].properties.dataImageSource, '../../outside.png'); assert.ok(textOf(placeholders[0]).includes('Outside')); assert.ok(prepared.result.warnings.length > 0)
  assert.equal(await cmText(), texts.resource); assert.equal(await save(), texts.resource)
  completeCase('Selected image HTML embeds authorized YAML-root image bytes using full original raw context and replaces outside-root image with a static reference')

  for (const mutation of ['body', 'tab', 'locale', 'dispose']) {
    await open('resource', 'source'); await sourceSelect(resourceFragment)
    const clip = await sentinel(`held-${mutation}`), count = (await writes()).length, start = await hold()
    await menu('html'); const held = await waitHeld(start)
    assert.equal(held.input.markdown, texts.resource); assert.equal(held.input.sourcePath, files.resource)
    await page.evaluate(() => { const content = document.querySelector('.source-editor .cm-content'); window.__heldSelectionCopySource = { content, view: content.cmTile.root.view } })
    if (mutation === 'body') {
      await source().click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('BODY_MUTATION')
      await page.waitForFunction(() => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().endsWith('BODY_MUTATION'))
    } else if (mutation === 'tab') await open('other', 'source')
    else if (mutation === 'locale') {
      await switchLocale('en')
      assert.equal(await page.evaluate(() => { const saved = window.__heldSelectionCopySource, content = document.querySelector('.source-editor .cm-content'); return content === saved.content && content.cmTile.root.view === saved.view }), true, 'Locale switch must keep the source editor mounted')
    } else {
      await visualMode(); assert.equal(await page.evaluate(() => window.__heldSelectionCopySource.content.isConnected), false)
    }
    await verifyCanceled(start, clip, count)
    if (mutation === 'body') { await source().click(); await menu('undo'); await page.waitForFunction((raw) => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === raw, texts.resource) }
    else if (mutation === 'locale') await switchLocale('zh-CN')
    if (mutation === 'tab') { assert.equal(await cmText(), texts.other); assert.equal(await readFile(files.other, 'utf8'), texts.other) }
    else { await sourceMode(); assert.equal(await cmText(), texts.resource) }
    assert.equal(await readFile(files.resource, 'utf8'), texts.resource)
    completeCase(`Genuine preparation held after authorization/embedding is canceled after ${mutation} change, with zero stale clipboard writes`, { heldRecord: held.index })
  }

  const newDraft = async () => {
    await menu('new'); activePath = null; await ready(); await sourceMode(); await source().click(); await page.keyboard.press('Control+a')
    // Native Enter creates every newline. insertText is used only for one line.
    for (const [index, line] of sameDraft.split('\n').entries()) { if (index) await page.keyboard.press('Enter'); if (line) await page.keyboard.insertText(line) }
    await page.waitForFunction((raw) => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === raw, sameDraft)
  }
  await newDraft(); await sourceSelect('**DRAFT_TOKEN**')
  const draftClip = await sentinel('same-name-same-content-unsaved'), draftCount = (await writes()).length, draftStart = await hold()
  await menu('html'); const draftHeld = await waitHeld(draftStart); assert.equal(draftHeld.input.sourcePath, null); assert.equal(draftHeld.input.markdown, sameDraft)
  await newDraft()
  let drafts = []
  for (let attempt = 0; attempt < 150; attempt++) {
    drafts = await page.evaluate(async (raw) => (await window.ttypora.listRecoveryDrafts()).filter((draft) => draft.sourcePath === null && draft.markdown === raw), sameDraft)
    if (drafts.length >= 2) break
    await frames(4)
  }
  assert.ok(drafts.length >= 2); assert.ok(new Set(drafts.map((draft) => draft.id)).size >= 2); assert.ok(drafts.every((draft) => draft.displayName === drafts[0].displayName))
  await verifyCanceled(draftStart, draftClip, draftCount); assert.equal(await cmText(), sameDraft)
  await sourceSelect('**DRAFT_TOKEN**'); result = await copy('html'); assert.equal(result.actual.text, 'DRAFT_TOKEN'); assert.deepEqual(elements(result.actual.html, 'strong').map(textOf), ['DRAFT_TOKEN'])
  assert.equal((await writes()).length, draftCount + 1)
  completeCase('Two actual unsaved documents with the same name/path/content have distinct recovery IDs; late A writes nothing and current B can copy normally', { draftIds: drafts.map((draft) => draft.id), displayName: drafts[0].displayName })
  completeGroup('Resources and document/mount/locale ownership')

  phase = 'settle all requests and restore observation'
  assert.equal(groups.length, 6); assert.deepEqual(errors, [])
  const ipc = await waitRecords((entries) => entries.every((entry) => entry.completed && entry.delivered), 'All genuine clipboard requests must settle before restoration')
  assert.ok(ipc.every((entry) => !entry.error)); await frames(8); assert.deepEqual(errors, [])
  assert.deepEqual(outsideRequests(), [], 'The unauthorized image must never become a browser resource request')
  for (const [name, raw] of Object.entries(texts)) assert.equal(await readFile(files[name], 'utf8'), raw, `Fixture ${name} must finish with its exact original bytes`)
  assert.deepEqual(await readFile(path.join(assets, 'owned.png')), imageBytes); assert.deepEqual(await readFile(path.join(temporary, 'outside.png')), imageBytes)
  await page.screenshot({ path: artifact('writing.png'), animations: 'disabled', timeout: 60000 })
  const restored = await application.evaluate(({ ipcMain }) => {
    const control = globalThis.__selectionCopyControl; control.hold = false; control.pending.splice(0).forEach(({ resolve }) => resolve())
    for (const [channel, original] of control.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
    ipcMain.removeListener('edit:native-history', control.nativeObserver); control.restored = true
    return { handlers: Object.fromEntries([...control.originals].map(([channel, original]) => [channel, ipcMain._invokeHandlers?.get(channel) === original])), observerRemoved: !ipcMain.listeners('edit:native-history').includes(control.nativeObserver) }
  })
  assert.ok(Object.values(restored.handlers).every(Boolean)); assert.equal(restored.observerRemoved, true)
  cleanup.handlerIdentities = restored.handlers; cleanup.nativeObserverRemoved = restored.observerRemoved
  report = { variant: packaged ? 'packaged' : 'source', prefix, version, completedAt: new Date().toISOString(), groups, cases, exclusions, menus, restored, nativeEdits: await nativeEdits(), ipc, errors, consoleMessages, requests, modelAndSavedFixturesRestored: true }
} catch (error) {
  let diagnostic = { unavailable: true }
  if (page && !page.isClosed()) {
    diagnostic = await page.evaluate(() => ({ title: document.title, body: document.body.innerText, lang: document.documentElement.lang, focus: document.activeElement?.outerHTML, selection: window.getSelection()?.toString(), model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(), source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString(), sourceSelection: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.selection.toJSON(), inputs: [...document.querySelectorAll('.markdown-editor input,.markdown-editor textarea')].map((input) => ({ value: input.value, from: input.selectionStart, to: input.selectionEnd, active: input === document.activeElement })) })).catch(() => diagnostic)
    await page.screenshot({ path: artifact('failure.png'), animations: 'disabled', timeout: 60000 }).catch(() => undefined)
  }
  await mkdir(artifacts, { recursive: true }); await writeFile(artifact('failure.json'), JSON.stringify({ phase, activePath, prefix, error: String(error), stack: error?.stack, groups, cases, exclusions, diagnostic, errors, consoleMessages, requests, ipc: application ? await application.evaluate(() => globalThis.__selectionCopyControl?.records ?? []).catch(() => []) : [] }, null, 2) + '\n'); process.exitCode = 1
} finally {
  if (application) {
    const restored = await application.evaluate(({ ipcMain }) => {
      const control = globalThis.__selectionCopyControl; if (!control) return { handlers: null, observerRemoved: null }
      control.hold = false; control.pending.splice(0).forEach(({ resolve }) => resolve())
      if (!control.restored) { for (const [channel, original] of control.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }; control.restored = true }
      ipcMain.removeListener('edit:native-history', control.nativeObserver)
      return { handlers: Object.fromEntries([...control.originals].map(([channel, original]) => [channel, ipcMain._invokeHandlers?.get(channel) === original])), observerRemoved: !ipcMain.listeners('edit:native-history').includes(control.nativeObserver) }
    }).catch((error) => ({ handlers: null, observerRemoved: false, error: String(error) }))
    cleanup.handlerIdentities = restored.handlers; cleanup.nativeObserverRemoved = restored.observerRemoved
    if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
    const child = application.process(); cleanup.mainPid = child?.pid; let timer
    cleanup.applicationClosed = await Promise.race([application.close().then(() => true, (error) => String(error)), new Promise((resolve) => { timer = setTimeout(() => resolve('Normal application close exceeded 15 seconds'), 15000) })]); clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) { cleanup.forcedTermination = true; child.kill(); await new Promise((resolve) => { const timeout = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timeout); resolve() }) }) }
    cleanup.processExited = Boolean(child && (child.exitCode !== null || child.signalCode !== null))
    try { if (child?.pid) process.kill(child.pid, 0); cleanup.mainPidGone = false } catch (error) { cleanup.mainPidGone = error?.code === 'ESRCH' }
  }
  try {
    if (application) { assert.equal(cleanup.processExited, true, 'Refusing fixture cleanup while main process may still run'); assert.equal(cleanup.mainPidGone, true, 'Isolated main PID is still present') }
    const actual = await realpath(temporary), parent = await realpath(tmpdir()), relative = path.relative(parent, actual)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.' && path.basename(actual).startsWith('ttypora-selection-copy-'), 'Refusing recursive removal outside the exact newly created fixture directory')
    await rm(actual, { recursive: true, force: true }); cleanup.fixtureRemoved = !existsSync(actual); assert.equal(cleanup.fixtureRemoved, true)
  } catch (error) { cleanup.fixtureError = String(error); process.exitCode = 1 }
  if (application && (!cleanup.handlerIdentities || !Object.values(cleanup.handlerIdentities).every(Boolean) || cleanup.nativeObserverRemoved !== true || cleanup.applicationClosed !== true || cleanup.forcedTermination || cleanup.processExited !== true || cleanup.mainPidGone !== true)) process.exitCode = 1
  await mkdir(artifacts, { recursive: true }); await writeFile(artifact('cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n')
}
if (report && (errors.length || outsideRequests().length)) { process.exitCode = 1; await writeFile(artifact('failure.json'), JSON.stringify({ phase: 'Late renderer error or unauthorized image request after settled original IPC', prefix, groups, cases, errors, outsideRequests: outsideRequests(), cleanup }, null, 2) + '\n') }
if (report && process.exitCode !== 1) { await writeFile(artifact('verification.json'), JSON.stringify({ ...report, cleanup }, null, 2) + '\n'); console.log('PASS all six selection-copy groups after original handler restoration, normal process exit and exact fixture cleanup') }
