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
const packageVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v${packageVersion}-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'))
const artifacts = path.join(root, 'artifacts'), artifact = (suffix) => path.join(artifacts, `outline-controls-${prefix}-${suffix}`)
assert(!existsSync(artifact('verification.json')), 'A success report already exists for this prefix; use a fresh verification prefix instead of overwriting old evidence')
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-outline-controls-')), workspace = path.join(temporary, 'notes')
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
const texts = {
  tree: 'Prelude before headings.\n\n### Orphan\n\nOrphan body.\n\n#### Orphan needle\n\nOrphan child body.\n\n# Same\n\nFirst same body.\n\n### Branch\n\nBranch body.\n\n#### Needle deep\n\nDeep body.\n\n## Peer\n\nPeer body.\n\n##### Peer needle\n\nPeer child body.\n\n# Same\n\nSecond same body.\n\n## Needle right\n\nRight body.\n\n# End\n\nTail stays **bold**, with `literal code` and [a link](https://example.invalid/).\n',
  mutation: '# First\n\nBody stays **bold**.\n\n## Child\n\nChild body.\n\n# End\n\nTail remains unchanged.\n',
  lateA: '# Late root\n\nLate body.\n\n## Late child\n\nLate tail.\n',
  lateB: '# Current B\n\nB body stays **bold**.\n\n## B child\n\nB tail.\n',
}
const files = Object.fromEntries(Object.keys(texts).map((name) => [name, path.join(workspace, `${name}.md`)]))
for (const [name, text] of Object.entries(texts)) await writeFile(files[name], text)
const lineOf = (markdown, marker, occurrence = 0) => { const lines = markdown.split('\n'); for (let index = 0; index < lines.length; index++) if (lines[index] === marker && occurrence-- === 0) return index + 1; throw new Error(`Missing literal fixture marker ${marker}`) }
const heading = (markdown, level, marker, text, occurrence = 0) => ({ level, line: lineOf(markdown, marker, occurrence), text })
const treeRows = [heading(texts.tree, 3, '### Orphan', 'Orphan'), heading(texts.tree, 4, '#### Orphan needle', 'Orphan needle'), heading(texts.tree, 1, '# Same', 'Same'), heading(texts.tree, 3, '### Branch', 'Branch'), heading(texts.tree, 4, '#### Needle deep', 'Needle deep'), heading(texts.tree, 2, '## Peer', 'Peer'), heading(texts.tree, 5, '##### Peer needle', 'Peer needle'), heading(texts.tree, 1, '# Same', 'Same', 1), heading(texts.tree, 2, '## Needle right', 'Needle right'), heading(texts.tree, 1, '# End', 'End')]
const parents = [null, 0, null, 2, 3, 2, 5, null, 7, null]
const simpleRows = (markdown, names) => names.map(([level, marker, text]) => heading(markdown, level, marker, text))
const mutationRows = simpleRows(texts.mutation, [[1, '# First', 'First'], [2, '## Child', 'Child'], [1, '# End', 'End']])
const lateARows = simpleRows(texts.lateA, [[1, '# Late root', 'Late root'], [2, '## Late child', 'Late child']])
const lateBRows = simpleRows(texts.lateB, [[1, '# Current B', 'Current B'], [2, '## B child', 'B child']])
const draftA = '# Draft root\n\nDraft A bytes stay **bold**.\n\n## Draft child\n\nChild A body.\n\n# Draft end\n\nA tail.\n'
const draftB = draftA.replace('Draft A bytes', 'Draft B bytes').replace('Child A body.', 'Child B body.').replace('A tail.', 'B tail.')
const draftRows = simpleRows(draftA, [[1, '# Draft root', 'Draft root'], [2, '## Draft child', 'Draft child'], [1, '# Draft end', 'Draft end']])
let application, page, activePath = null, phase = 'launch', report = null, restoredWorker = null
const errors = [], consoleMessages = [], checks = [], evidence = [], cleanup = {}
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`CHECK completed: ${name}`) }
const exclusions = [
  'Prepared as an independent suite; preparation uses node --check only. No GUI result is asserted until this file is explicitly run against integrated source or a packaged candidate.',
  'The real Vite/production module Worker parses original requests. The late-response group holds one genuine MessageEvent and delivers it to the captured original callback after disposal; this is controlled delivery, not a claim of natural OS lateness or a message newly produced by a terminated Worker.',
  'Read-only PM docView and CodeMirror state inspection verifies native keyboard/menu/navigation results. No PM/CM transaction, selection, bookmark, parser result, Worker event data or private React/Vue state is injected.',
  'No IPC handler or Save As picker is replaced. Public recovery-draft reads and an additive native-history listener observe real main-process work; this suite does not exercise Save As or the system file-dialog UI.',
  'Search/flat/fold controls and same-document body/title changes are covered. Worker crash/error recovery, IME, performance thresholds, level-change invalidation and natural scheduling order are not claimed.',
  'Success JSON is written only after Worker/listener restoration, isolated app process exit and verified removal of the exact newly created fixture directory.',
]

function installWorkerObservation() {
  const NativeWorker = window.Worker, onmessage = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'onmessage')
  if (!onmessage?.set) throw new Error('Native Worker.onmessage setter unavailable')
  const control = { workers: [], requests: [], responses: [], pending: [], states: [], gate: null, restored: false }, instances = []
  const state = () => {
    const list = document.querySelector('.outline-list'), nav = list?.closest('nav'), navigations = [...(list?.querySelectorAll('[data-outline-navigation]') ?? [])]
    const query = document.querySelector('.outline-title-filter input[type="search"]'), flat = document.querySelector('.outline-flat-toggle'), level = document.querySelector('.outline-depth select')
    return { at: performance.now(), title: document.title, busy: nav?.getAttribute('aria-busy') ?? null,
      indexedElements: list?.querySelectorAll('[data-outline-index]').length ?? 0,
      rows: navigations.map((button) => { const li = button.closest('li'), parent = li?.parentElement?.closest('li[data-outline-index]'); return { index: Number(button.dataset.outlineIndex), text: button.textContent, line: Number(button.title.match(/\d+/)?.[0]), parent: parent ? Number(parent.dataset.outlineIndex) : null, context: li?.dataset.outlineContext === 'true', disabled: button.disabled, current: button.getAttribute('aria-current'), active: button.classList.contains('outline-heading--active') } }),
      folds: [...(list?.querySelectorAll('.outline-toggle') ?? [])].map((button) => ({ index: Number(button.dataset.outlineIndex), expanded: button.getAttribute('aria-expanded'), disabled: button.disabled })),
      nestedLists: list?.querySelectorAll('.outline-children').length ?? 0,
      query: query ? { value: query.value, disabled: query.disabled } : null, flat: flat ? { pressed: flat.getAttribute('aria-pressed'), disabled: flat.disabled } : null, level: level ? { value: level.value, disabled: level.disabled } : null,
      status: [...document.querySelectorAll('.sidebar [role="status"]')].map((element) => element.textContent),
    }
  }
  let signature = ''
  const capture = () => { const current = state(), next = JSON.stringify({ ...current, at: 0 }); if (next !== signature) { signature = next; control.states.push(current) } }
  const observer = new MutationObserver(capture)
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy', 'aria-current', 'aria-expanded', 'aria-pressed', 'disabled', 'class', 'title', 'data-outline-index', 'data-outline-context'] })
  const ObservedWorker = new Proxy(NativeWorker, { construct(target, args, newTarget) {
    const worker = Reflect.construct(target, args, newTarget)
    const meta = { id: control.workers.length + 1, url: String(args[0]), type: args[1]?.type ?? 'classic', createdAt: performance.now(), terminatedAt: null, errors: [] }
    const entry = { worker, meta, callback: worker.onmessage, post: worker.postMessage, terminate: worker.terminate, descriptors: Object.fromEntries(['onmessage', 'postMessage', 'terminate'].map((key) => [key, Object.getOwnPropertyDescriptor(worker, key)])), errorListener: null, errorListenerRemoved: false }
    control.workers.push(meta); instances.push(entry)
    Object.defineProperty(worker, 'postMessage', { configurable: true, value: function (...args) { control.requests.push({ workerID: meta.id, at: performance.now(), data: structuredClone(args[0]) }); return entry.post.apply(worker, args) } })
    Object.defineProperty(worker, 'terminate', { configurable: true, value: function (...args) { meta.terminatedAt = performance.now(); return entry.terminate.apply(worker, args) } })
    Object.defineProperty(worker, 'onmessage', { configurable: true, get: () => entry.callback, set: (callback) => { entry.callback = callback } })
    onmessage.set.call(worker, (event) => {
      const data = event.data, callback = entry.callback
      const request = control.requests.findLast((request) => request.workerID === meta.id && request.data?.documentKey === data?.documentKey && request.data?.revision === data?.revision && request.data?.optionsKey === data?.optionsKey)
      const response = { workerID: meta.id, producedAt: performance.now(), deliveredAt: null, held: false, data: structuredClone(data), request: request?.data ?? null, producedBeforeTerminate: meta.terminatedAt === null, callbackCaptured: typeof callback === 'function' }
      control.responses.push(response)
      if (typeof callback !== 'function') return
      if (control.gate && request?.data?.markdown === control.gate.markdown && data?.kind === 'result') { control.gate = null; response.held = true; control.pending.push({ event, callback, worker, entry, response }); return }
      response.deliveredAt = performance.now(); callback.call(worker, event)
    })
    entry.errorListener = (event) => meta.errors.push({ at: performance.now(), message: event.message })
    worker.addEventListener('error', entry.errorListener)
    return worker
  } })
  window.Worker = ObservedWorker
  control.arm = (markdown) => { if (control.gate || control.pending.length) throw new Error('Only one genuine response may be held'); control.gate = { markdown } }
  control.release = () => { control.gate = null; control.pending.splice(0).forEach(({ event, callback, worker, entry, response }) => { response.deliveredAt = performance.now(); response.releasedAfterTerminate = entry.meta.terminatedAt !== null; response.callbackStillInstalled = entry.callback === callback; callback.call(worker, event) }) }
  control.state = state
  control.trace = () => ({ workers: control.workers, requests: control.requests, responses: control.responses, states: control.states, pending: control.pending.length, restored: control.restored })
  control.restore = () => {
    if (!control.restored) {
      control.release(); observer.disconnect()
      instances.forEach((entry) => { onmessage.set.call(entry.worker, entry.callback); for (const [key, descriptor] of Object.entries(entry.descriptors)) { if (descriptor) Object.defineProperty(entry.worker, key, descriptor); else delete entry.worker[key] }; entry.worker.removeEventListener('error', entry.errorListener); entry.errorListenerRemoved = true })
      window.Worker = NativeWorker; control.restored = true
    }
    return { constructorRestored: window.Worker === NativeWorker, pending: control.pending.length, observerDisconnected: control.restored, errorListenersRemoved: instances.every((entry) => entry.errorListenerRemoved),
      instanceDescriptorsRestored: instances.every(({ worker, descriptors }) => Object.entries(descriptors).every(([key, descriptor]) => { const actual = Object.getOwnPropertyDescriptor(worker, key); return descriptor ? actual?.value === descriptor.value && actual?.get === descriptor.get && actual?.set === descriptor.set && actual?.configurable === descriptor.configurable && actual?.enumerable === descriptor.enumerable && actual?.writable === descriptor.writable : !actual })) }
  }
  window.__outlineControlsVerification = control
}

try {
  const flags = ['--disable-gpu', '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? flags : [...flags, '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() }) })
  await page.addInitScript(installWorkerObservation); await page.reload(); await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await application.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus()
    const control = { commands: [], listener: null, restored: false }; globalThis.__outlineControlsMain = control
    control.listener = (_event, direction) => control.commands.push({ direction, at: Date.now() }); ipcMain.on('edit:native-history', control.listener)
  })
  const menu = (name) => application.evaluate(({ Menu, BrowserWindow }, name) => {
    const specs = { workspace: { labels: ['打开文件夹…', 'Open folder…'] }, files: { accelerator: 'CmdOrCtrl+Shift+3' }, outline: { accelerator: 'CmdOrCtrl+Shift+1' }, sidebar: { accelerator: 'CmdOrCtrl+Shift+L' }, source: { accelerator: 'CmdOrCtrl+/' }, new: { accelerator: 'CmdOrCtrl+N' }, save: { accelerator: 'CmdOrCtrl+S' }, undo: { accelerator: 'CmdOrCtrl+Z' }, redo: { accelerator: 'CmdOrCtrl+Y' } }
    const items = [], visit = (menu) => menu?.items.forEach((item) => { items.push(item); if (item.submenu) visit(item.submenu) }); visit(Menu.getApplicationMenu())
    const spec = specs[name], item = items.find((item) => item.visible && item.enabled && (spec.accelerator && item.accelerator === spec.accelerator || spec.labels?.includes(item.label.replace(/&/g, ''))))
    if (!item || typeof item.click !== 'function') throw new Error(`Actual menu item unavailable: ${name}`)
    item.click(item, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], {}); return { label: item.label, accelerator: item.accelerator }
  }, name)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror,.source-editor .cm-content').first().waitFor() }
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const trace = () => page.evaluate(() => window.__outlineControlsVerification.trace())
  const ui = () => page.evaluate(() => window.__outlineControlsVerification.state())
  const model = () => page.evaluate(() => document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON())
  const source = () => page.locator('.source-editor .cm-content')
  const sourceState = () => source().evaluate((element) => { const view = element.cmTile.root.view; return { markdown: view.state.doc.toString(), selection: view.state.selection.toJSON(), line: view.state.doc.lineAt(view.state.selection.main.head).number } })
  const query = () => page.locator('.outline-title-filter input[type="search"]')
  const flat = () => page.locator('.outline-flat-toggle')
  const depth = () => page.locator('.outline-depth select')
  const navigation = (index) => page.locator(`.outline-list [data-outline-navigation][data-outline-index="${index}"]`)
  const foldButton = (index) => page.locator(`.outline-list .outline-toggle[data-outline-index="${index}"]`)
  const waitOutlineReady = () => page.waitForFunction(() => { const list = document.querySelector('.outline-list'), query = document.querySelector('.outline-title-filter input'); return list?.closest('nav')?.getAttribute('aria-busy') === 'false' && query && !query.disabled && [...list.querySelectorAll('[data-outline-navigation]')].every((button) => !button.disabled) })
  const ensureSource = async () => { if (await page.locator('.ProseMirror').count()) { await menu('source'); await ready() }; await source().waitFor() }
  const ensureVisual = async () => { if (await page.locator('.source-editor').count()) { await menu('source'); await ready() }; await page.locator('.ProseMirror').waitFor() }
  const setQuery = async (value) => { await query().click(); await query().press('Control+a'); if (value) await page.keyboard.insertText(value); else await query().press('Backspace'); await page.waitForFunction((value) => document.querySelector('.outline-title-filter input')?.value === value, value); await frames() }
  const setFlat = async (value) => { if ((await flat().getAttribute('aria-pressed')) !== String(value)) await flat().click(); await page.waitForFunction((value) => document.querySelector('.outline-flat-toggle')?.getAttribute('aria-pressed') === String(value), value) }
  const resetControls = async () => { await waitOutlineReady(); await setQuery(''); await setFlat(false); await depth().selectOption('6') }
  const open = async (name) => { await menu('files'); await page.locator('.file-tree').getByTitle(files[name], { exact: true }).click(); activePath = files[name]; await page.waitForFunction((name) => document.title.includes(name), `${name}.md`); await ready(); await menu('outline'); await waitOutlineReady() }
  const assertRows = async (rows, indexes, options = {}) => {
    await waitOutlineReady(); await page.waitForFunction((indexes) => JSON.stringify([...document.querySelectorAll('.outline-list [data-outline-navigation]')].map((button) => Number(button.dataset.outlineIndex))) === JSON.stringify(indexes), indexes)
    const current = await ui(); assert.deepEqual(current.rows.map(({ index, line, text }) => ({ index, line, text })), indexes.map((index) => ({ index, line: rows[index].line, text: rows[index].text })))
    if (options.parents) assert.deepEqual(current.rows.map(({ parent }) => parent), indexes.map((index) => options.parents[index]))
    if (options.contexts) assert.deepEqual(current.rows.filter((row) => row.context).map((row) => row.index), options.contexts)
    if (options.flat) { assert.equal(current.folds.length, 0); assert.equal(current.nestedLists, 0); assert.ok(current.rows.every((row) => row.parent === null)) }
    return current
  }
  const assertActive = async (index) => { await page.waitForFunction((index) => { const buttons = [...document.querySelectorAll('.outline-list [data-outline-navigation]')], active = buttons.filter((button) => button.getAttribute('aria-current') === 'location'); return index === null ? active.length === 0 && !buttons.some((button) => button.classList.contains('outline-heading--active')) : active.length === 1 && Number(active[0].dataset.outlineIndex) === index && active[0].classList.contains('outline-heading--active') }, index); evidence.push({ phase, expectedActiveIndex: index, ui: await ui() }) }
  const pmSelection = () => page.evaluate(() => {
    const prose = document.querySelector('.ProseMirror'), selection = window.getSelection(), anchor = selection?.anchorNode, focus = selection?.focusNode, headings = []
    prose?.pmViewDesc?.node.descendants((node, position) => { if (node.type.name === 'heading') headings.push({ position, size: node.nodeSize, text: node.textContent, level: node.attrs.level }) })
    const anchorPosition = anchor && prose.contains(anchor) ? prose.pmViewDesc.posFromDOM(anchor, selection.anchorOffset, 1) : null, headPosition = focus && prose.contains(focus) ? prose.pmViewDesc.posFromDOM(focus, selection.focusOffset, 1) : null
    return { anchorPosition, headPosition, collapsed: selection?.isCollapsed, actualHeadingIndex: headPosition === null ? null : headings.findIndex((heading) => headPosition >= heading.position + 1 && headPosition < heading.position + heading.size), headings }
  })
  const assertNavigation = async (index, baseline, key = null) => {
    if (key) { await navigation(index).focus(); await navigation(index).press(key) } else await navigation(index).click()
    await assertActive(index); const selection = await pmSelection(); assert.equal(selection.actualHeadingIndex, index); assert.equal(selection.headPosition, selection.headings[index].position + 1); assert.equal(selection.collapsed, true); assert.deepEqual(await model(), baseline); evidence.push({ phase, index, key, selection })
  }
  const expectFold = async (index, expanded) => { await page.waitForFunction(({ index, expanded }) => document.querySelector(`.outline-list .outline-toggle[data-outline-index="${index}"]`)?.getAttribute('aria-expanded') === String(expanded), { index, expanded }) }
  const expectFocus = async (index) => { await page.waitForFunction((index) => document.activeElement?.matches(`[data-outline-navigation][data-outline-index="${index}"]`), index) }
  const goLine = async (line) => {
    await source().click(); await source().press('Control+Alt+g'); const input = page.locator('.source-editor .cm-goto-line input[name="line"]')
    await input.waitFor(); await input.press('Control+a'); await page.keyboard.insertText(String(line)); await input.press('Enter')
    await page.waitForFunction((line) => { const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view; return view && view.state.doc.lineAt(view.state.selection.main.head).number === line }, line)
  }
  const waitRaw = (markdown) => page.waitForFunction((markdown) => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === markdown, markdown)
  const assertRawAndModel = async (markdown, baseline) => { await ensureSource(); assert.equal((await sourceState()).markdown, markdown); await ensureVisual(); assert.deepEqual(await model(), baseline); await waitOutlineReady() }
  const nativeHistory = () => application.evaluate(() => globalThis.__outlineControlsMain.commands)
  const waitDraft = async (markdown) => { await page.waitForFunction(async (markdown) => (await window.ttypora.listRecoveryDrafts()).some((draft) => draft.markdown === markdown && draft.sourcePath === null), markdown); return page.evaluate(async (markdown) => (await window.ttypora.listRecoveryDrafts()).filter((draft) => draft.markdown === markdown && draft.sourcePath === null), markdown) }
  const assertPending = async () => { const current = await ui(); assert.equal(current.busy, 'true'); assert.equal(current.rows.length, 0); assert.equal(current.folds.length, 0); assert.equal(current.indexedElements, 0); assert.equal(current.status.length, 1); assert.ok(current.status[0]); assert.equal(current.query?.disabled, true); assert.equal(current.flat?.disabled, true); assert.equal(current.level?.disabled, true); await assertActive(null); evidence.push({ phase, pending: current }) }

  await ready(); await menu('workspace'); await open('tree'); await resetControls()
  phase = '1: canonical nested tree, duplicate folds and native keyboard controls'
  await assertRows(treeRows, treeRows.map((_, index) => index), { parents }); const treeBaseline = await model(), initial = await trace()
  const parsedTree = initial.responses.findLast((response) => response.request?.markdown === texts.tree && response.data?.kind === 'result' && response.deliveredAt !== null)
  assert.ok(parsedTree); assert.deepEqual(parsedTree.data.headings, treeRows)
  const worker = initial.workers.find((worker) => worker.id === parsedTree.workerID); assert.equal(worker.type, 'module'); assert.match(worker.url, /outline-worker(?:\.ts(?:\?|$)|-[\w-]+\.js(?:\?|$))/)
  await foldButton(2).click(); await expectFold(2, false); await assertRows(treeRows, [0, 1, 2, 7, 8, 9], { parents })
  await foldButton(7).click(); await expectFold(7, false); await assertRows(treeRows, [0, 1, 2, 7, 9], { parents })
  await foldButton(0).click(); await expectFold(0, false); await assertRows(treeRows, [0, 2, 7, 9], { parents })
  await navigation(2).focus(); await navigation(2).press('ArrowRight'); await expectFold(2, true)
  await navigation(2).press('ArrowRight'); await expectFocus(3)
  await navigation(3).press('ArrowLeft'); await expectFold(3, false); await expectFocus(3)
  await navigation(3).press('ArrowLeft'); await expectFocus(2)
  await navigation(2).press('ArrowLeft'); await expectFold(2, false)
  await navigation(2).press('ArrowRight'); await expectFold(2, true)
  await foldButton(2).focus(); await foldButton(2).press('Space'); await expectFold(2, false)
  await foldButton(2).press('Enter'); await expectFold(2, true)
  await foldButton(3).click(); await foldButton(0).click(); await foldButton(7).click()
  await assertRows(treeRows, treeRows.map((_, index) => index), { parents }); assert.ok((await ui()).nestedLists >= 5)
  await assertNavigation(7, treeBaseline, 'Enter'); await assertNavigation(1, treeBaseline, 'Space')
  assert.deepEqual(await model(), treeBaseline); assert.equal((await trace()).requests.length, initial.requests.length)
  await assertRawAndModel(texts.tree, treeBaseline); assert.equal(await readFile(files.tree, 'utf8'), texts.tree)
  check('Real nested/orphan hierarchy and independent same-label branches use canonical indexes; native ArrowLeft/ArrowRight/Space/Enter preserve whole PM and raw bytes', { worker, headings: treeRows, parents })

  phase = '2: flat layout, level range and exact duplicate-heading navigation'
  await foldButton(2).click(); await expectFold(2, false); await setFlat(true)
  await assertRows(treeRows, treeRows.map((_, index) => index), { flat: true })
  await depth().selectOption('3'); await assertRows(treeRows, [0, 2, 3, 5, 7, 8, 9], { flat: true })
  await assertNavigation(2, treeBaseline); await assertNavigation(7, treeBaseline)
  await depth().selectOption('6'); await setFlat(false); await expectFold(2, false); await assertRows(treeRows, [0, 1, 2, 7, 8, 9], { parents })
  await assertRawAndModel(texts.tree, treeBaseline); assert.equal(await readFile(files.tree, 'utf8'), texts.tree)
  check('Flat mode reveals the selected level range without folding/nesting, duplicates navigate exact PM positions, and returning to tree restores the saved fold')

  phase = '3: title query, actual ancestor context and active null without an ancestor'
  await ensureSource(); await goLine(treeRows[4].line); await depth().selectOption('1'); await assertActive(2)
  const beforeQuery = await sourceState(); await setQuery('nEeDlE')
  const contexts = [0, 2, 3, 5, 7], matches = [1, 4, 6, 8], matchingIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 8]
  const searched = await assertRows(treeRows, matchingIndexes, { parents, contexts }); assert.deepEqual(searched.rows.filter((row) => !row.context).map((row) => row.index), matches)
  assert.equal(searched.level.disabled, true); assert.equal(searched.level.value, '1'); assert.ok(searched.folds.length && searched.folds.every((button) => button.disabled && button.expanded === 'true'))
  await assertActive(4); assert.deepEqual((await sourceState()).selection, beforeQuery.selection)
  await setFlat(true); await assertRows(treeRows, matchingIndexes, { flat: true, contexts }); await assertActive(4)
  await goLine(treeRows[9].line); await assertActive(null)
  await setQuery('no such heading'); const empty = await assertRows(treeRows, []); assert.equal(empty.status.length, 1); assert.ok(empty.status[0]); assert.equal(empty.level.disabled, true); await assertActive(null)
  await setQuery(''); const cleared = await assertRows(treeRows, [2, 7, 9], { flat: true }); assert.equal(cleared.level.value, '1'); assert.equal(cleared.level.disabled, false); await assertActive(9)
  await setFlat(false); await depth().selectOption('6'); await expectFold(2, false); await assertRows(treeRows, [0, 1, 2, 7, 8, 9], { parents })
  assert.equal((await sourceState()).markdown, texts.tree); await ensureVisual(); assert.deepEqual(await model(), treeBaseline); assert.equal(await readFile(files.tree, 'utf8'), texts.tree)
  check('Mixed-case query reveals every real match plus all true ancestors across levels/folds, flat keeps contexts, no ancestor yields active null, and clear restores level/fold controls')

  phase = '4: two genuine same-name unsaved documents retain independent controls and bytes'
  const createUnsaved = async (markdown) => {
    const count = await page.locator('.document-tabs [role="tab"]').count(); await menu('new'); await ready()
    await page.waitForFunction((count) => document.querySelectorAll('.document-tabs [role="tab"]').length === count + 1, count)
    activePath = null; await ensureSource(); await source().click(); await source().press('Control+a'); await page.keyboard.insertText(markdown); await waitRaw(markdown)
    await menu('outline'); await waitOutlineReady(); await ensureVisual(); await waitOutlineReady()
    const ordinal = await page.locator('.document-tabs [role="tab"][aria-selected="true"]').evaluate((button) => [...button.parentElement.parentElement.querySelectorAll('[role="tab"]')].indexOf(button))
    const title = await page.locator('.document-tabs [role="tab"]').nth(ordinal).getAttribute('title'); assert.match(title, /未保存文档|Unsaved document/)
    return { ordinal, title, baseline: await model() }
  }
  const tabOrdinal = async (ordinal) => { await page.locator('.document-tabs [role="tab"]').nth(ordinal).click(); activePath = null; await ready(); await waitOutlineReady(); await ensureVisual(); await waitOutlineReady() }
  const firstDraft = await createUnsaved(draftA); await assertRows(draftRows, [0, 1, 2]); await foldButton(0).click(); await expectFold(0, false); await setQuery('child'); await setFlat(true)
  const secondDraft = await createUnsaved(draftB); const defaults = await assertRows(draftRows, [0, 1, 2]); assert.equal(defaults.query.value, ''); assert.equal(defaults.flat.pressed, 'false'); await expectFold(0, true)
  assert.equal(firstDraft.title, secondDraft.title); assert.notEqual(firstDraft.ordinal, secondDraft.ordinal)
  await foldButton(0).click(); await expectFold(0, false); await setQuery('end'); await assertRows(draftRows, [2]); assert.deepEqual(await model(), secondDraft.baseline)
  await tabOrdinal(firstDraft.ordinal); const firstRestored = await assertRows(draftRows, [0, 1], { flat: true, contexts: [0] }); assert.equal(firstRestored.query.value, 'child'); assert.equal(firstRestored.flat.pressed, 'true'); assert.deepEqual(await model(), firstDraft.baseline)
  await page.locator('.sidebar__header > .icon-button').click(); await page.locator('.sidebar').waitFor({ state: 'detached' }); await menu('outline'); await waitOutlineReady()
  const reopened = await assertRows(draftRows, [0, 1], { flat: true, contexts: [0] }); assert.equal(reopened.query.value, 'child'); assert.equal(reopened.flat.pressed, 'true')
  await setQuery(''); await setFlat(false); await expectFold(0, false); await assertRows(draftRows, [0, 2]); await assertRawAndModel(draftA, firstDraft.baseline)
  const firstRecovery = await waitDraft(draftA), secondRecovery = await waitDraft(draftB); assert.equal(firstRecovery.length, 1); assert.equal(secondRecovery.length, 1); assert.notEqual(firstRecovery[0].id, secondRecovery[0].id); assert.equal(firstRecovery[0].displayName, secondRecovery[0].displayName)
  await tabOrdinal(secondDraft.ordinal); const secondRestored = await assertRows(draftRows, [2]); assert.equal(secondRestored.query.value, 'end'); assert.equal(secondRestored.flat.pressed, 'false'); await setQuery(''); await expectFold(0, false); await assertRows(draftRows, [0, 2]); await assertRawAndModel(draftB, secondDraft.baseline)
  check('Two real unsaved same-name tabs have distinct recovery IDs and exact draft bytes; each owns query/flat/folds, including sidebar unmount/remount', { first: { ordinal: firstDraft.ordinal, recovery: firstRecovery[0] }, second: { ordinal: secondDraft.ordinal, recovery: secondRecovery[0] } })

  phase = '5: real body line shift, title invalidation and shared document Undo'
  await open('mutation'); await resetControls(); await ensureVisual(); const mutationBaseline = await model(); await assertRows(mutationRows, [0, 1, 2])
  await foldButton(0).click(); await expectFold(0, false); await setQuery('Child'); await setFlat(true)
  await ensureSource(); const stateStart = (await trace()).states.length, prefixBody = 'Prelude shifted without headings.\n\n', shifted = prefixBody + texts.mutation
  await source().click(); await source().press('Control+Home'); await page.keyboard.insertText(prefixBody); await waitRaw(shifted); await waitOutlineReady()
  const shiftedRows = mutationRows.map((row) => ({ ...row, line: row.line + 2 })); const shiftControls = await assertRows(shiftedRows, [0, 1], { flat: true, contexts: [0] }); assert.equal(shiftControls.query.value, 'Child')
  const transitions = (await trace()).states.slice(stateStart); assert.ok(transitions.some((state) => state.busy === 'true' && state.indexedElements === 0 && state.status.length === 1 && state.query?.disabled && state.flat?.disabled && state.level?.disabled), 'Natural pending must expose status and zero stale canonical index elements')
  await setQuery(''); await setFlat(false); await expectFold(0, false); await assertRows(shiftedRows, [0, 2])
  await ensureVisual(); const shiftedModel = await model(), expectedShift = structuredClone(mutationBaseline); expectedShift.content.unshift({ type: 'paragraph', content: [{ type: 'text', text: 'Prelude shifted without headings.' }] }); assert.deepEqual(shiftedModel, expectedShift)
  await setQuery('Child'); await setFlat(true); await ensureSource(); await goLine(shiftedRows[1].line); await source().press('Home'); await source().press('Shift+End'); await page.keyboard.insertText('## Child renamed')
  const renamed = shifted.replace('## Child', '## Child renamed'), renamedRows = shiftedRows.map((row, index) => index === 1 ? { ...row, text: 'Child renamed' } : row)
  await waitRaw(renamed); await waitOutlineReady(); const renameControls = await assertRows(renamedRows, [0, 1], { flat: true, contexts: [0] }); assert.equal(renameControls.query.value, 'Child')
  await ensureVisual(); const renamedModel = await model(), expectedRename = structuredClone(shiftedModel); const renamedHeading = expectedRename.content.find((node) => node.type === 'heading' && node.attrs.level === 2); renamedHeading.content = [{ type: 'text', text: 'Child renamed' }]; renamedHeading.attrs.id = 'child-renamed'; assert.deepEqual(renamedModel, expectedRename)
  await setQuery(''); await setFlat(false); await expectFold(0, true); await assertRows(renamedRows, [0, 1, 2]); await setQuery('Child'); await setFlat(true)
  await ensureSource(); await source().click(); const nativeBefore = (await nativeHistory()).length; const undo = await menu('undo'); await waitRaw(shifted); await waitOutlineReady()
  const undoControls = await assertRows(shiftedRows, [0, 1], { flat: true, contexts: [0] }); assert.equal(undoControls.query.value, 'Child'); assert.equal((await nativeHistory()).length, nativeBefore)
  await ensureVisual(); assert.deepEqual(await model(), shiftedModel); await setQuery(''); await setFlat(false); await expectFold(0, true); await assertRows(shiftedRows, [0, 1, 2])
  await ensureSource(); await source().click(); await menu('redo'); await waitRaw(renamed); await waitOutlineReady(); await ensureVisual(); assert.deepEqual(await model(), renamedModel); await expectFold(0, true)
  assert.equal((await nativeHistory()).length, nativeBefore); assert.equal(await readFile(files.mutation, 'utf8'), texts.mutation)
  check('Real source body insertion shifts only canonical lines and retains folds; renamed title clears folds while preserving query/flat, and one shared Undo/Redo changes only the title edit', { undo, shiftedRows, renamedRows, naturalTransitions: transitions })

  phase = '6: held genuine Worker result, pending zero-index rows and tab ownership'
  await open('lateA'); await resetControls(); await ensureSource(); await assertRows(lateARows, [0, 1]); await setQuery('Late'); await setFlat(true)
  const delayedRaw = texts.lateA + '\nHELD REAL RESULT TOKEN\n'
  await page.evaluate((markdown) => window.__outlineControlsVerification.arm(markdown), delayedRaw)
  await source().click(); await source().press('Control+End'); await source().press('Enter'); await page.keyboard.insertText('HELD REAL RESULT TOKEN'); await source().press('Enter'); await waitRaw(delayedRaw)
  await page.waitForFunction(() => window.__outlineControlsVerification.pending.length === 1 && window.__outlineControlsVerification.responses.some((response) => response.held && response.data?.kind === 'result' && response.deliveredAt === null)); await assertPending()
  const held = (await trace()).responses.findLast((response) => response.held && response.deliveredAt === null); assert.equal(held.request.markdown, delayedRaw); assert.ok(held.producedBeforeTerminate && held.callbackCaptured); assert.deepEqual(held.data.headings, lateARows)
  await open('lateB'); await resetControls(); await ensureVisual(); const currentBaseline = await model(); await assertRows(lateBRows, [0, 1]); await assertNavigation(1, currentBaseline)
  const beforeRelease = await ui(), selectionBefore = await pmSelection(), workerBefore = (await trace()).workers.find((worker) => worker.id === held.workerID); assert.ok(workerBefore.terminatedAt !== null && workerBefore.terminatedAt >= held.producedAt)
  await page.evaluate(() => window.__outlineControlsVerification.release()); await frames(); await assertRows(lateBRows, [0, 1]); await assertActive(1); assert.deepEqual(await pmSelection(), selectionBefore); assert.deepEqual(await model(), currentBaseline)
  const afterRelease = await ui(); assert.deepEqual({ ...afterRelease, at: 0 }, { ...beforeRelease, at: 0 })
  const released = (await trace()).responses.find((response) => response.workerID === held.workerID && response.data.revision === held.data.revision); assert.equal(released.releasedAfterTerminate, true); assert.equal(released.callbackStillInstalled, false)
  await assertRawAndModel(texts.lateB, currentBaseline); assert.equal(await readFile(files.lateA, 'utf8'), texts.lateA); assert.equal(await readFile(files.lateB, 'utf8'), texts.lateB)
  check('Pending exposes no stale index rows and disables controls; a held genuine old-document Event released to the disposed callback cannot alter current tree/query/selection/PM/raw bytes', { held: released, disposedWorker: workerBefore })

  phase = 'restoration before final cleanup'
  assert.equal(checks.length, 6); assert.deepEqual(errors, []); const finalTrace = await trace(); assert.equal(finalTrace.pending, 0); assert.ok(finalTrace.workers.length && finalTrace.workers.every((worker) => worker.errors.length === 0))
  for (const [name, markdown] of Object.entries(texts)) assert.equal(await readFile(files[name], 'utf8'), markdown)
  await page.screenshot({ path: artifact('final.png'), animations: 'disabled', timeout: 60000 })
  restoredWorker = await page.evaluate(() => window.__outlineControlsVerification.restore()); assert.equal(restoredWorker.constructorRestored, true); assert.equal(restoredWorker.instanceDescriptorsRestored, true); assert.equal(restoredWorker.observerDisconnected, true); assert.equal(restoredWorker.errorListenersRemoved, true); assert.equal(restoredWorker.pending, 0)
  cleanup.worker = restoredWorker
  const nativeCommands = await nativeHistory(); cleanup.nativeObserverRemoved = await application.evaluate(({ ipcMain }) => { const control = globalThis.__outlineControlsMain; ipcMain.removeListener('edit:native-history', control.listener); control.restored = true; return !ipcMain.listeners('edit:native-history').includes(control.listener) }); assert.equal(cleanup.nativeObserverRemoved, true)
  report = { variant: packaged ? 'packaged' : 'source', prefix, version: await application.evaluate(({ app }) => app.getVersion()), completedAt: new Date().toISOString(), interaction: 'Real installed menu callbacks, outline/tree/fold/filter/flat/tab controls and native keyboard/source Go to line; original module Worker and public draft-store reads', checks, evidence, exclusions, errors, consoleMessages, nativeCommands, worker: finalTrace, restoredWorker }
} catch (error) {
  let diagnostic = { unavailable: true }
  if (page && !page.isClosed()) {
    diagnostic = await page.evaluate(() => ({ title: document.title, body: document.body.innerText, model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(), source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString(), sourceSelection: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.selection.toJSON(), ui: window.__outlineControlsVerification?.state(), worker: window.__outlineControlsVerification?.trace(), focused: document.activeElement?.outerHTML })).catch(() => diagnostic)
    await page.screenshot({ path: artifact('failure.png'), animations: 'disabled', timeout: 60000 }).catch(() => undefined)
  }
  await writeFile(artifact('failure.json'), JSON.stringify({ phase, activePath, prefix, error: String(error), stack: error?.stack, checks, exclusions, evidence, diagnostic, errors, consoleMessages, restoredWorker }, null, 2) + '\n'); process.exitCode = 1
} finally {
  if (page && !page.isClosed()) cleanup.worker = await page.evaluate(() => window.__outlineControlsVerification?.restore() ?? null).catch((error) => ({ error: String(error) }))
  if (application) {
    cleanup.nativeObserverRemoved = await application.evaluate(({ ipcMain }) => { const control = globalThis.__outlineControlsMain; if (!control) return null; ipcMain.removeListener('edit:native-history', control.listener); control.restored = true; return !ipcMain.listeners('edit:native-history').includes(control.listener) }).catch(() => false)
    if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
    const child = application.process(); let timer
    cleanup.applicationClosed = await Promise.race([application.close().then(() => true, (error) => String(error)), new Promise((resolve) => { timer = setTimeout(() => resolve('Application close exceeded 15 seconds'), 15000) })]); clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise((resolve) => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve() }) }) }
    cleanup.processExited = Boolean(child && (child.exitCode !== null || child.signalCode !== null))
  }
  try {
    if (application) assert.equal(cleanup.processExited, true, 'Refusing fixture cleanup while isolated app may still run')
    const actual = await realpath(temporary), parent = await realpath(tmpdir()), relative = path.relative(parent, actual)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.' && path.basename(actual).startsWith('ttypora-outline-controls-'), 'Refusing cleanup outside exact newly created fixture directory')
    await rm(actual, { recursive: true, force: true }); cleanup.fixtureRemoved = !existsSync(actual); assert.equal(cleanup.fixtureRemoved, true)
  } catch (error) { cleanup.fixtureError = String(error); process.exitCode = 1 }
  if (application && (cleanup.worker?.constructorRestored !== true || cleanup.worker?.instanceDescriptorsRestored !== true || cleanup.worker?.observerDisconnected !== true || cleanup.worker?.errorListenersRemoved !== true || cleanup.worker?.pending !== 0 || cleanup.nativeObserverRemoved !== true || cleanup.applicationClosed !== true || cleanup.processExited !== true)) process.exitCode = 1
  await mkdir(artifacts, { recursive: true }); await writeFile(artifact('cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n')
}
if (report && errors.length) { process.exitCode = 1; await writeFile(artifact('failure.json'), JSON.stringify({ phase: 'Late renderer error during restoration/close', prefix, checks, exclusions, errors, consoleMessages, cleanup }, null, 2) + '\n') }
if (report && process.exitCode !== 1) { await writeFile(artifact('verification.json'), JSON.stringify({ ...report, cleanup }, null, 2) + '\n'); console.log('PASS all six outline controls groups after Worker/listener restoration, process exit and exact fixture cleanup') }
