import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

let root = path.dirname(fileURLToPath(import.meta.url))
while (!existsSync(path.join(root, 'package.json'))) { const parent = path.dirname(root); assert.notEqual(parent, root); root = parent }
const packaged = process.env.TTYPORA_PACKAGED_EXE
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v0.10-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'))
const artifacts = path.join(root, 'artifacts'), artifact = (suffix) => path.join(artifacts, `outline-${prefix}-${suffix}`)
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-outline-')), workspace = path.join(temporary, 'notes')
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
const files = Object.fromEntries(['a', 'b', 'mutation', 'history'].map((name) => [name, path.join(workspace, `${name}.md`)]))
const a = '---\ntitle: Outline A\n---\n\nPrelude before headings.\n\n### Orphan\n\nOrphan body.\n\n# Same\n\nFirst same body.\n\n## Branch\n\nBranch body.\n\n### Deep\n\nDeep body.\n\n# Same\n\nSecond same body.\n\n#\n\nEmpty heading body.\n\n> ## Quoted\n>\n> Quoted body.\n\n- ### Listed\n\n  Listed body.\n\nMulti line\nSetext text\n-----------\n\nSetext body.\n\n## Rich **bold** $a+b$ :smile: [link](https://example.invalid/)\n\nRich body.\n\n# Fields\n\n```js title="outline.js"\n# Fake code heading\nconst literal = 1\n```\n\n$$ field-equation\n# Fake math heading\n$$\n\n<div>\n<h1>Fake HTML heading</h1>\n</div>\n\n![Outline alt](pixel.png "Original caption")\n\n| A | B |\n|---|---|\n| C | D |\n\n# End\n\nEnd body.\n'
const b = '# B only\n\nB paragraph.\n\n## B detail\n\nB tail.\n'
const mutation = '# Mutation first\n\nAlpha body.\n\n## Mutation second\n\nBravo body.\n\n### Mutation third\n\nCharlie body.\n'
const history = '# First\n\nAlpha paragraph.\n\n## Second\n\nBravo paragraph.\n'
for (const [name, text] of Object.entries({ a, b, mutation, history })) await writeFile(files[name], text)
await writeFile(path.join(workspace, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
const lineOf = (markdown, marker, occurrence = 0) => { const lines = markdown.split('\n'); for (let index = 0; index < lines.length; index++) if (lines[index] === marker && occurrence-- === 0) return index + 1; throw new Error(`Missing literal fixture marker ${marker}`) }
const row = (markdown, level, marker, text, occurrence = 0) => ({ level, line: lineOf(markdown, marker, occurrence), text })
const aRows = [row(a, 3, '### Orphan', 'Orphan'), row(a, 1, '# Same', 'Same'), row(a, 2, '## Branch', 'Branch'), row(a, 3, '### Deep', 'Deep'), row(a, 1, '# Same', 'Same', 1), row(a, 1, '#', ''), row(a, 2, '> ## Quoted', 'Quoted'), row(a, 3, '- ### Listed', 'Listed'), row(a, 2, 'Multi line', 'Multi line Setext text'), row(a, 2, '## Rich **bold** $a+b$ :smile: [link](https://example.invalid/)', 'Rich bold a+b 😄 link'), row(a, 1, '# Fields', 'Fields'), row(a, 1, '# End', 'End')]
const bRows = [row(b, 1, '# B only', 'B only'), row(b, 2, '## B detail', 'B detail')]
const historyRows = [row(history, 1, '# First', 'First'), row(history, 2, '## Second', 'Second')]
let application, page, activePath = null, phase = 'launch', restoredWorker = null
const pageErrors = [], consoleMessages = [], checks = [], evidence = []
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`) }
const exclusions = [
  'Workers load the actual Vite/production outline-worker entry and parse genuine requests. One real MessageEvent may be held for controlled delivery; this is not natural OS lateness and no parser/result/Event data is fabricated.',
  'The worker late-callback case captures a genuine result before termination, then calls that captured original app callback after disposal; it does not claim a terminated OS worker naturally posted a new result.',
  'Read-only PM docView DOM mapping verifies real heading coordinates; no test injects a PM/CM transaction, DOM selection or editor bookmark.',
  'No parsing latency threshold, large-document performance claim, IME case, worker crash/recovery test or Typora timing comparison is included.',
  'This suite does not replace any IPC handler. Worker constructor/instance wrappers are restored and verified before the success JSON; all remaining cleanup runs in finally.',
]

function installWorkerObservation() {
  const NativeWorker = window.Worker, onmessage = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'onmessage')
  if (!onmessage?.set) throw new Error('Native Worker.onmessage setter unavailable')
  const control = { workers: [], requests: [], responses: [], pending: [], outlineStates: [], gate: null, restored: false }
  const instances = []
  const viewState = () => {
    const list = document.querySelector('.outline-list'), nav = list?.closest('nav'), buttons = [...(list?.querySelectorAll('.outline-navigation') ?? [])]
    return { at: performance.now(), title: document.title, busy: nav?.getAttribute('aria-busy') ?? null,
      rows: buttons.map((button) => ({ text: button.textContent, line: Number(button.title.match(/\d+/)?.[0]), disabled: button.disabled, current: button.getAttribute('aria-current'), active: button.classList.contains('outline-heading--active') })),
      indexRows: list?.querySelectorAll('[data-outline-index]').length ?? 0,
      activeMarkers: list?.querySelectorAll('[aria-current="location"], .outline-heading--active').length ?? 0,
      controls: ['.outline-title-filter input', '.outline-depth select', '.outline-flat-toggle'].map((selector) => ({ selector, present: Boolean(document.querySelector(selector)), disabled: document.querySelector(selector)?.disabled === true })),
      status: [...document.querySelectorAll('.sidebar [role="status"]')].map((element) => element.textContent) }
  }
  let signature = ''
  const observeOutline = () => { const state = viewState(), next = JSON.stringify({ ...state, at: 0 }); if (next !== signature) { signature = next; control.outlineStates.push(state) } }
  const observer = new MutationObserver(observeOutline)
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy', 'aria-current', 'disabled', 'class', 'title'] })
  const ObservedWorker = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget)
      const meta = { id: control.workers.length + 1, url: String(args[0]), type: args[1]?.type ?? 'classic', createdAt: performance.now(), terminatedAt: null, errors: [] }
      const entry = { worker, meta, callback: null, post: worker.postMessage, terminate: worker.terminate }
      control.workers.push(meta); instances.push(entry)
      Object.defineProperty(worker, 'postMessage', { configurable: true, value: function (...messageArgs) { control.requests.push({ workerID: meta.id, at: performance.now(), data: structuredClone(messageArgs[0]) }); return entry.post.apply(worker, messageArgs) } })
      Object.defineProperty(worker, 'terminate', { configurable: true, value: function (...terminateArgs) { meta.terminatedAt = performance.now(); return entry.terminate.apply(worker, terminateArgs) } })
      Object.defineProperty(worker, 'onmessage', { configurable: true, get: () => entry.callback, set: (callback) => { entry.callback = callback } })
      onmessage.set.call(worker, (event) => {
        const data = event.data, callback = entry.callback
        const request = control.requests.findLast((request) => request.workerID === meta.id && request.data?.documentKey === data?.documentKey && request.data?.revision === data?.revision && request.data?.optionsKey === data?.optionsKey)
        const response = { workerID: meta.id, producedAt: performance.now(), deliveredAt: null, held: false, data: structuredClone(data), request: request?.data ?? null, producedBeforeTerminate: meta.terminatedAt === null, callbackCaptured: typeof callback === 'function' }
        control.responses.push(response)
        if (typeof callback !== 'function') return
        if (control.gate && request?.data?.markdown?.includes(control.gate.markdownIncludes) && data?.kind === 'result') {
          control.gate = null; response.held = true
          control.pending.push({ event, callback, worker, entry, response })
          return
        }
        response.deliveredAt = performance.now(); callback.call(worker, event)
      })
      worker.addEventListener('error', (event) => meta.errors.push({ at: performance.now(), message: event.message }))
      return worker
    },
  })
  window.Worker = ObservedWorker
  control.arm = (markdownIncludes) => { if (control.gate || control.pending.length) throw new Error('Only one actual response may be held'); control.gate = { markdownIncludes } }
  control.release = () => { control.gate = null; control.pending.splice(0).forEach(({ event, callback, worker, entry, response }) => { response.deliveredAt = performance.now(); response.releasedAfterTerminate = entry.meta.terminatedAt !== null; response.callbackStillInstalled = entry.callback === callback; callback.call(worker, event) }) }
  control.state = viewState
  control.trace = () => ({ workers: control.workers, requests: control.requests, responses: control.responses, outlineStates: control.outlineStates, pending: control.pending.length, restored: control.restored })
  control.restore = () => {
    control.release(); observer.disconnect()
    instances.forEach((entry) => { onmessage.set.call(entry.worker, entry.callback); delete entry.worker.onmessage; delete entry.worker.postMessage; delete entry.worker.terminate })
    window.Worker = NativeWorker; control.restored = true
    return { at: performance.now(), constructorRestored: window.Worker === NativeWorker, pending: control.pending.length, instanceOverridesRemoved: instances.every(({ worker }) => !Object.hasOwn(worker, 'onmessage') && !Object.hasOwn(worker, 'postMessage') && !Object.hasOwn(worker, 'terminate')) }
  }
  window.__outlineVerification = control
}

try {
  const flags = ['--disable-gpu', '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? flags : [...flags, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() }) })
  await page.addInitScript(installWorkerObservation)
  await page.reload(); await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
  const menu = (name) => application.evaluate(({ Menu, BrowserWindow }, name) => {
    const specs = { workspace: { labels: ['打开文件夹…', 'Open folder…'] }, files: { accelerator: 'CmdOrCtrl+Shift+3' }, outline: { accelerator: 'CmdOrCtrl+Shift+1' }, source: { accelerator: 'CmdOrCtrl+/' }, split: { accelerator: 'CmdOrCtrl+Shift+V' }, preferences: { accelerator: 'CmdOrCtrl+,' }, save: { accelerator: 'CmdOrCtrl+S' }, undo: { accelerator: 'CmdOrCtrl+Z' }, redo: { accelerator: 'CmdOrCtrl+Y' } }
    const items = [], visit = (menu) => menu?.items.forEach((item) => { items.push(item); if (item.submenu) visit(item.submenu) })
    visit(Menu.getApplicationMenu()); const spec = specs[name], item = items.find((item) => item.visible && item.enabled && (item.accelerator === spec.accelerator && spec.accelerator || spec.labels?.includes(item.label.replace(/&/g, ''))))
    if (!item || typeof item.click !== 'function') throw new Error(`Actual menu item unavailable: ${name}`)
    item.click(item, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], {})
    return { label: item.label, accelerator: item.accelerator }
  }, name)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror,.source-editor .cm-content').first().waitFor() }
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const trace = () => page.evaluate(() => window.__outlineVerification.trace())
  const ui = () => page.evaluate(() => window.__outlineVerification.state())
  const model = () => page.evaluate(() => document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON())
  const source = () => page.locator('.source-editor .cm-content')
  const sourceState = () => source().evaluate((element) => { const view = element.cmTile.root.view, selection = view.state.selection.main; return { markdown: view.state.doc.toString(), selection: view.state.selection.toJSON(), head: selection.head, line: view.state.doc.lineAt(selection.head).number } })
  const waitOutlineReady = () => page.waitForFunction(() => { const list = document.querySelector('.outline-list'); return list?.closest('nav')?.getAttribute('aria-busy') === 'false' && [...list.querySelectorAll('.outline-navigation')].every((button) => !button.disabled) })
  const open = async (name) => { await menu('files'); await page.locator('.file-tree').getByTitle(files[name], { exact: true }).click(); activePath = files[name]; await page.waitForFunction((name) => document.title.includes(name), `${name}.md`); await ready(); await menu('outline'); await waitOutlineReady(); await page.locator('.outline-depth select').selectOption('6') }
  const tab = async (name) => { await page.locator('.document-tabs').getByRole('tab').filter({ hasText: new RegExp(`^${name}\\.md(?:\\s|$)`) }).click(); activePath = files[name]; await page.waitForFunction((name) => document.title.includes(name), `${name}.md`); await ready(); await waitOutlineReady() }
  const ensureSource = async () => { if (await page.locator('.ProseMirror').count()) { await menu('source'); await ready() }; await source().waitFor() }
  const ensureVisual = async () => { if (await page.locator('.source-editor').count()) { await menu('source'); await ready() }; await page.locator('.ProseMirror').waitFor() }
  const assertRows = async (expected) => { await waitOutlineReady(); const current = await ui(), locale = await page.evaluate(() => document.documentElement.lang); assert.deepEqual(current.rows.map(({ line, text }) => ({ line, text })), expected.map(({ line, text }) => ({ line, text: text || (locale === 'en' ? 'Untitled heading' : '空标题') }))); return current }
  const assertActive = async (index, rows) => {
    await page.waitForFunction((line) => { const buttons = [...document.querySelectorAll('.outline-list .outline-navigation')], active = buttons.filter((button) => button.getAttribute('aria-current') === 'location'); return line === null ? !active.length && !buttons.some((button) => button.classList.contains('outline-heading--active')) : active.length === 1 && Number(active[0].title.match(/\d+/)?.[0]) === line && active[0].classList.contains('outline-heading--active') }, index === null ? null : rows[index].line)
    evidence.push({ phase, expectedActiveIndex: index, outline: await ui() })
  }
  const clickHeading = async (index, rows) => { await waitOutlineReady(); const buttons = page.locator('.outline-list .outline-navigation'), ordinal = (await ui()).rows.findIndex((entry) => entry.line === rows[index].line); assert.ok(ordinal >= 0); await buttons.nth(ordinal).click(); await assertActive(index, rows) }
  const pmSelection = () => page.evaluate(() => {
    const prose = document.querySelector('.ProseMirror'), selection = window.getSelection(), anchor = selection?.anchorNode, focus = selection?.focusNode
    const headings = []; prose?.pmViewDesc?.node.descendants((node, position) => { if (node.type.name === 'heading') headings.push({ position, size: node.nodeSize, text: node.textContent, level: node.attrs.level }) })
    const anchorPosition = anchor && prose.contains(anchor) ? prose.pmViewDesc.posFromDOM(anchor, selection.anchorOffset, 1) : null
    const headPosition = focus && prose.contains(focus) ? prose.pmViewDesc.posFromDOM(focus, selection.focusOffset, 1) : null
    return { anchorPosition, headPosition, selected: selection?.toString(), collapsed: selection?.isCollapsed, actualHeadingIndex: headPosition === null ? null : headings.findIndex((heading) => headPosition >= heading.position + 1 && headPosition < heading.position + heading.size), headings }
  })
  const goLine = async (line) => {
    await source().click(); await source().press('Control+Alt+g')
    const input = page.locator('.source-editor .cm-goto-line input[name="line"]')
    await input.waitFor(); await input.press('Control+a'); await page.keyboard.insertText(String(line)); await input.press('Enter')
    await page.waitForFunction((line) => { const element = document.querySelector('.source-editor .cm-content'), view = element?.cmTile?.root?.view; return view && view.state.doc.lineAt(view.state.selection.main.head).number === line }, line)
  }
  const arm = (token) => page.evaluate((token) => window.__outlineVerification.arm(token), token)
  const waitHeld = () => page.waitForFunction(() => window.__outlineVerification.pending.length === 1 && window.__outlineVerification.responses.some((response) => response.held && response.data.kind === 'result' && response.deliveredAt === null))
  const release = () => page.evaluate(() => window.__outlineVerification.release())
  const assertPending = async () => {
    const state = await ui(); assert.equal(state.busy, 'true'); assert.equal(state.rows.length, 0); assert.equal(state.indexRows, 0); assert.equal(state.activeMarkers, 0)
    assert.equal(state.controls.length, 3); assert.ok(state.controls.every((control) => control.present && control.disabled), 'Pending canonical ownership disables every outline control')
    evidence.push({ phase, pending: state })
  }
  const switchLanguage = async (locale) => { await menu('preferences'); await page.locator('.preferences fieldset').first().locator('select').selectOption(locale); await page.waitForFunction((locale) => document.documentElement.lang === locale, locale); await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'Done' : '完成', exact: true }).click() }
  const save = async () => {
    await page.evaluate(() => { window.__outlineSaveReceived = false; const remove = window.ttypora.onAppCommand((value) => { if (value === 'save-document') { window.__outlineSaveReceived = true; remove() } }) })
    await menu('save'); await page.waitForFunction(() => window.__outlineSaveReceived)
    await page.waitForFunction(() => !document.title.startsWith('●') && /已保存：|没有需要保存|Saved:|No document changes to save/.test(document.querySelector('.statusbar')?.textContent ?? ''))
    return readFile(activePath, 'utf8')
  }

  await ready(); await menu('workspace'); await open('a')
  phase = 'canonical real worker: duplicate/empty/nested/Setext/rich and literal exclusions'
  await assertRows(aRows)
  const actual = await trace(), responseA = actual.responses.findLast((response) => response.data?.kind === 'result' && response.request?.markdown === a && response.deliveredAt !== null)
  assert.ok(responseA, 'Actual worker must return a genuine canonical parse of the exact fixture bytes')
  assert.deepEqual(responseA.data.headings, aRows)
  const workerA = actual.workers.find((worker) => worker.id === responseA.workerID)
  assert.match(workerA.url, /outline-worker(?:\.ts(?:\?|$)|-[\w-]+\.js(?:\?|$))/)
  assert.equal(workerA.type, 'module'); assert.equal(workerA.errors.length, 0)
  const initialA = await model(), headingModel = await pmSelection()
  assert.equal(headingModel.headings.length, aRows.length, 'Actual PM headings and canonical worker indexes must have identical cardinality')
  for (const index of [1, 4, 5, 6, 7, 8, 9]) {
    phase = `visual canonical navigation: index ${index} / source line ${aRows[index].line}`
    await clickHeading(index, aRows); const selection = await pmSelection()
    assert.equal(selection.actualHeadingIndex, index); assert.equal(selection.headPosition, selection.headings[index].position + 1); assert.equal(selection.collapsed, true)
    assert.deepEqual(await model(), initialA)
    evidence.push({ phase, selection })
  }
  assert.equal(await save(), a)
  check('A genuine Vite module Worker preserves duplicate/empty/nested/Setext/rich heading indexes, excludes code/math/raw-HTML fake headings, and real visual outline clicks target their exact PM headings', { worker: workerA, headings: aRows })

  phase = 'visual focus ownership: native metadata and embedded fields'
  for (const [name, selector, expectedIndex] of [['metadata', '.front-matter-source', null], ['code', '.ttypora-code-block .cm-content', 10], ['code metadata', '[data-code-meta]', 10], ['block math', '.ttypora-math-block .cm-content', 10], ['HTML source', '[data-html-source-editor]', 10], ['image caption', '.milkdown-image-block .caption-input', 10], ['table cell', '.milkdown-table-block table p', 10]]) {
    phase = `visual focus ownership: ${name}`
    await clickHeading(11, aRows)
    // The installed native code view creates CodeMirror only when its public
    // host enters the viewport. Scroll the real host before locating its editor.
    if (name === 'code') await page.locator('.ttypora-code-block').first().scrollIntoViewIfNeeded()
    const target = name === 'table cell' ? page.locator(selector).filter({ hasText: /^D$/ }) : page.locator(selector).first()
    await target.click(); await assertActive(expectedIndex, aRows); assert.deepEqual(await model(), initialA)
  }
  assert.equal(await save(), a)
  check('Metadata before headings has no active section; real code/metadata/math/HTML/caption/table focus selects its enclosing Fields section without modifying Markdown')

  phase = 'source caret and canonical source-line navigation'
  await ensureSource(); await waitOutlineReady(); assert.equal((await sourceState()).markdown, a)
  for (const index of [1, 4, 5, 6, 7, 8]) { await clickHeading(index, aRows); assert.equal((await sourceState()).line, aRows[index].line) }
  await goLine(aRows[8].line + 1); await assertActive(8, aRows)
  await goLine(2); await assertActive(null, aRows)
  await clickHeading(3, aRows)
  await page.evaluate(() => { const content = document.querySelector('.source-editor .cm-content'); window.__outlineSourceIdentity = { content, view: content.cmTile.root.view, selection: content.cmTile.root.view.state.selection.toJSON() } })
  phase = 'split uses the same source caret and live CodeMirror instance'
  await menu('split'); await ready(); await page.locator('.live-preview iframe').waitFor(); await assertActive(3, aRows)
  assert.equal(await page.evaluate(() => { const saved = window.__outlineSourceIdentity, content = document.querySelector('.source-editor .cm-content'); return content === saved.content && content.cmTile.root.view === saved.view && JSON.stringify(content.cmTile.root.view.state.selection.toJSON()) === JSON.stringify(saved.selection) }), true)
  await clickHeading(6, aRows); assert.equal((await sourceState()).line, aRows[6].line)
  assert.equal((await sourceState()).markdown, a)
  await page.screenshot({ path: artifact('split.png'), animations: 'disabled', timeout: 60000 })
  check('Source and split highlight actual caret/source lines, including metadata and multi-line Setext; split preserves the CM instance/selection and outline navigation changes no Markdown')

  phase = 'filtered active ancestry uses full canonical indexes'
  await goLine(aRows[3].line); await assertActive(3, aRows); const beforeFilter = await sourceState()
  await page.locator('.outline-depth select').selectOption('1'); await assertActive(1, aRows)
  assert.deepEqual((await sourceState()).selection, beforeFilter.selection)
  await goLine(aRows[0].line); await assertActive(null, aRows)
  await page.locator('.outline-depth select').selectOption('6'); await assertActive(0, aRows)
  check('H1 filtering projects Deep onto its actual Same ancestor, creates no ancestor for initial Orphan, and preserves source selection/full indexes')

  phase = 'language/mode changes retain the current actual caret'
  await clickHeading(5, aRows); const beforeLanguage = await sourceState()
  await switchLanguage('en'); await waitOutlineReady(); await assertActive(5, aRows); await assertRows(aRows)
  assert.deepEqual(await sourceState(), beforeLanguage)
  await menu('split'); await ready(); await page.locator('.ProseMirror').waitFor()
  evidence.push({ phase: 'visual readiness after source/split empty-heading caret', beforeSource: beforeLanguage, pm: await pmSelection(), outline: await ui() })
  await assertActive(5, aRows)
  assert.equal((await pmSelection()).actualHeadingIndex, 5); assert.deepEqual(await model(), initialA)
  await menu('source'); await ready(); await assertActive(5, aRows); assert.equal((await sourceState()).line, aRows[5].line)
  assert.equal((await sourceState()).markdown, a)
  check('Chinese-to-English language change localizes the empty label while source/split/visual switches retain the actual empty-heading location and exact Markdown')

  phase = 'natural pending-to-ready after a real source body edit'
  await open('mutation'); await ensureSource(); await waitOutlineReady()
  const stateStart = (await trace()).outlineStates.length
  await source().click(); await source().press('Control+End')
  assert.equal((await sourceState()).head, mutation.length)
  await page.keyboard.press('Enter'); await page.keyboard.type('Natural pending body.'); await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__outlineVerification.responses.some((response) => response.data?.kind === 'result' && response.request?.markdown === '# Mutation first\n\nAlpha body.\n\n## Mutation second\n\nBravo body.\n\n### Mutation third\n\nCharlie body.\n\nNatural pending body.\n' && response.deliveredAt !== null))
  await waitOutlineReady(); const natural = (await trace()).outlineStates.slice(stateStart)
  assert.ok(natural.some((state) => state.busy === 'true' && state.rows.length === 0 && state.indexRows === 0 && state.activeMarkers === 0 && state.controls.length === 3 && state.controls.every((control) => control.present && control.disabled)), 'Observer must see genuine natural pending with zero old index rows/highlight and all outline controls disabled')
  assert.ok(natural.some((state) => state.busy === 'false' && state.rows.length && state.rows.every((row) => !row.disabled)), 'Natural worker completion must re-enable the current list')
  check('A real source edit naturally transitions pending→ready with zero old index navigation/highlight and disabled controls, using the actual worker without a hold', { outlineStates: natural })

  let mutated = mutation + '\nNatural pending body.\n'
  const edits = [
    { name: 'delete heading', line: () => 1, text: 'plain first', token: 'plain first', expected: () => mutated.replace('# Mutation first', 'plain first') },
    { name: 'insert heading before existing list', prefix: '# Inserted first\n\n', token: '# Inserted first', expected: () => '# Inserted first\n\n' + mutated },
    { name: 'change heading format/text', line: () => lineOf(mutated, '## Mutation second'), text: '#### Mutation second revised', token: '#### Mutation second revised', expected: () => mutated.replace('## Mutation second', '#### Mutation second revised') },
  ]
  for (const edit of edits) {
    phase = `pending mutation: native ${edit.name}`
    await arm(edit.token)
    if (edit.prefix) { await source().click(); await source().press('Control+Home'); await page.keyboard.insertText(edit.prefix) }
    else { await goLine(edit.line()); await source().press('Home'); await source().press('Shift+End'); await page.keyboard.insertText(edit.text) }
    mutated = edit.expected(); await waitHeld(); await assertPending()
    assert.equal((await sourceState()).markdown, mutated)
    const heldResponse = (await trace()).responses.findLast((response) => response.held && response.deliveredAt === null)
    assert.equal(heldResponse.request.markdown, mutated); assert.equal(heldResponse.producedBeforeTerminate, true)
    await release(); await waitOutlineReady()
    const headings = (await trace()).responses.findLast((response) => response.request?.markdown === mutated && response.deliveredAt !== null).data.headings
    const expectedText = edit.name === 'delete heading' ? ['Mutation second', 'Mutation third'] : edit.name === 'insert heading before existing list' ? ['Inserted first', 'Mutation second', 'Mutation third'] : ['Inserted first', 'Mutation second revised', 'Mutation third']
    assert.deepEqual(headings.map((heading) => heading.text), expectedText); await assertRows(headings)
    if (edit.name === 'delete heading') await assertActive(null, headings)
    else await assertActive(edit.prefix ? 0 : 1, headings)
    evidence.push({ phase, heldResponse, headings })
  }
  check('Real heading deletion, prefix insertion and format/text change remove stale index rows/clear current/disable controls while a genuine parse result is held; release restores exact new indexes without stale navigation')

  phase = 'tab ownership: open B then return to A'
  await open('b'); await ensureSource(); await assertRows(bRows)
  await tab('a'); await ensureSource(); await assertRows(aRows)
  phase = 'tab ownership: actual A parse completes before its controlled delayed delivery'
  await arm('LATE-A TOKEN'); await source().click(); await source().press('Control+End')
  assert.equal((await sourceState()).head, a.length)
  await page.keyboard.press('Enter'); await page.keyboard.type('LATE-A TOKEN'); await page.keyboard.press('Enter')
  assert.equal((await sourceState()).markdown, a + '\nLATE-A TOKEN\n')
  await waitHeld(); await assertPending()
  const oldA = (await trace()).responses.findLast((response) => response.held && response.deliveredAt === null)
  assert.ok(oldA.producedBeforeTerminate && oldA.callbackCaptured)
  await tab('b'); await assertRows(bRows); await clickHeading(1, bRows); assert.equal((await sourceState()).line, bRows[1].line)
  await tab('a'); await assertRows(aRows); await assertActive(11, aRows)
  const beforeLate = await sourceState(), currentA = (await trace()).responses.findLast((response) => response.request?.markdown === a + '\nLATE-A TOKEN\n' && response.deliveredAt !== null)
  assert.ok(currentA && currentA.workerID !== oldA.workerID && currentA.data.revision > oldA.data.revision)
  const oldWorker = (await trace()).workers.find((worker) => worker.id === oldA.workerID)
  assert.ok(oldWorker.terminatedAt !== null && oldWorker.terminatedAt >= oldA.producedAt, 'Actual A result must have been produced before its old worker was terminated by the tab transition')
  phase = 'tab ownership: captured actual old-A callback released after A/B/A'
  await release(); await frames(); await assertRows(aRows); await assertActive(11, aRows); assert.deepEqual(await sourceState(), beforeLate)
  const released = (await trace()).responses.find((response) => response.workerID === oldA.workerID && response.data.revision === oldA.data.revision)
  assert.equal(released.releasedAfterTerminate, true); assert.equal(released.callbackStillInstalled, false)
  assert.equal(await readFile(files.a, 'utf8'), a); assert.equal(await readFile(files.b, 'utf8'), b)
  check('A/B/A uses fresh worker/revision ownership; a genuine old A response produced before termination and delivered to its captured disposed callback cannot alter current A selection/raw bytes/list/highlight', { oldResponse: released, oldWorker, currentResponse: currentA })

  phase = 'extension preference remount: native current selection before toggle'
  await open('history'); await ensureVisual(); await waitOutlineReady(); await assertRows(historyRows)
  const historyBaseline = await model()
  await page.locator('.ProseMirror p').filter({ hasText: /^Alpha paragraph\.$/ }).click(); await page.keyboard.press('Home')
  for (let step = 0; step < 5; step++) await page.keyboard.press('Shift+ArrowRight')
  const beforeExtension = await pmSelection(); assert.equal(beforeExtension.selected, 'Alpha'); await assertActive(0, historyRows)
  await menu('preferences')
  const highlight = page.locator('.preferences .setting-check').filter({ hasText: /^(?:高亮|Highlight)$/ }).locator('input[type="checkbox"]')
  const highlightBefore = await highlight.isChecked(); await highlight.click()
  assert.equal(await highlight.isChecked(), !highlightBefore)
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click(); await ready(); await waitOutlineReady()
  const afterExtension = await pmSelection()
  assert.equal(afterExtension.selected, 'Alpha'); assert.equal(afterExtension.anchorPosition, beforeExtension.anchorPosition); assert.equal(afterExtension.headPosition, beforeExtension.headPosition)
  assert.deepEqual(await model(), historyBaseline); await assertActive(0, historyRows); assert.equal(await save(), history)
  check('A real Markdown extension preference toggle restores the current native PM selection/bookmark and active section after remount, retaining syntax-free Markdown rather than an older history bookmark', { beforeExtension, afterExtension, highlightBefore })

  phase = 'navigation history: one real edit before multiple outline/mode/locale actions'
  await page.locator('.ProseMirror p').filter({ hasText: /^Alpha paragraph\.$/ }).click(); await page.keyboard.press('End'); await page.keyboard.insertText(' HISTORY MARK')
  await waitOutlineReady(); const editedHistoryModel = await model()
  await clickHeading(0, historyRows); await clickHeading(1, historyRows)
  const beforeLocale = await pmSelection(); await switchLanguage('zh-CN'); await ready(); await waitOutlineReady(); await assertActive(1, historyRows)
  assert.equal((await pmSelection()).headPosition, beforeLocale.headPosition); assert.deepEqual(await model(), editedHistoryModel)
  await ensureSource(); await waitOutlineReady(); await assertActive(1, historyRows)
  const editedHistoryRaw = (await sourceState()).markdown
  assert.equal(editedHistoryRaw, history.replace('Alpha paragraph.', 'Alpha paragraph. HISTORY MARK'))
  await clickHeading(0, historyRows); await menu('split'); await ready(); await assertActive(0, historyRows); await clickHeading(1, historyRows)
  assert.equal((await sourceState()).markdown, editedHistoryRaw)
  await menu('split'); await ready(); await assertActive(1, historyRows); assert.deepEqual(await model(), editedHistoryModel)
  phase = 'navigation history: the next actual document Undo removes only that original edit'
  await menu('undo'); await page.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent?.includes('HISTORY MARK')); await waitOutlineReady()
  assert.deepEqual(await model(), historyBaseline); assert.equal(await save(), history)
  await menu('redo'); await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('HISTORY MARK')); await waitOutlineReady(); assert.deepEqual(await model(), editedHistoryModel)
  await menu('undo'); await page.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent?.includes('HISTORY MARK')); await waitOutlineReady(); assert.equal(await save(), history)
  check('Real outline navigation, locale and visual/source/split transitions preserve bytes and add no document undo step; one Undo/Redo removes/restores the original single edit')

  const finalTrace = await trace()
  assert.ok(finalTrace.workers.length && finalTrace.responses.some((response) => response.data?.kind === 'result'))
  assert.ok(finalTrace.workers.every((worker) => !worker.errors.length)); assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: artifact('final.png'), animations: 'disabled', timeout: 60000 })
  restoredWorker = await page.evaluate(() => window.__outlineVerification.restore())
  assert.equal(restoredWorker.constructorRestored, true); assert.equal(restoredWorker.instanceOverridesRemoved, true); assert.equal(restoredWorker.pending, 0)
  await writeFile(artifact('verification.json'), JSON.stringify({ variant: packaged ? 'packaged' : 'source', version: await application.evaluate(({ app }) => app.getVersion()), prefix, interaction: 'Real keyboard, native installed menu callbacks, source CM Go to line dialog, outline/tab/field/Preferences controls; no injected editor transaction/selection. Actual Vite Worker parser observed with explicitly controlled genuine Event delivery.', checks, exclusions, evidence, pageErrors, consoleMessages, worker: finalTrace, restoredWorker }, null, 2) + '\n')
} catch (error) {
  let diagnostic = { unavailable: true }
  if (page && !page.isClosed()) {
    diagnostic = await page.evaluate(() => ({ title: document.title, lang: document.documentElement.lang, body: document.body.innerText, model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(), source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state?.doc.toString(), sourceSelection: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state?.selection.toJSON(), outline: window.__outlineVerification?.state(), worker: window.__outlineVerification?.trace(), focused: document.activeElement?.outerHTML, selection: window.getSelection()?.toString() })).catch(() => diagnostic)
    await page.screenshot({ path: artifact('failure.png'), animations: 'disabled', timeout: 60000 }).catch(() => undefined)
  }
  await writeFile(artifact('failure.json'), JSON.stringify({ phase, activePath, error: String(error), stack: error?.stack, prefix, checks, exclusions, evidence, diagnostic, pageErrors, consoleMessages, restoredWorker }, null, 2) + '\n')
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => { const control = window.__outlineVerification; if (control && !control.restored) return control.restore() }).catch((error) => console.error(`Worker restoration failed: ${error}`))
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  const actualTemporary = await realpath(temporary), actualParent = await realpath(tmpdir()), relative = path.relative(actualParent, actualTemporary)
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.' && path.basename(actualTemporary).startsWith('ttypora-outline-'), 'Refusing cleanup outside the exact newly created fixture directory')
  await rm(actualTemporary, { recursive: true, force: true })
}
