import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'

// The root verifier builds and owns the Windows desktop session. This script
// launches only its selected existing executable; it never builds or packages.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const packaged = process.env.TTYPORA_PACKAGED_EXE
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v${packageVersion.replace(/\.0$/, '')}-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'), 'Verification prefix must be a file name without paths')
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-table-hardbreak-'))
const workspace = path.join(temporary, 'notes'), artifacts = path.join(root, 'artifacts')
const documentTableSelector = '.ProseMirror .milkdown-table-block table.children'
const original = '# Table hardbreak\n\nBefore table.\n\n| HEAD | COPY | CODE |\n| :--- | :--- | :--- |\n| BODY | DEST | `A<br>B` |\n| STABLE | TARGET | untouched |\n\nOutside paragraph.\n\n```js\nconst untouched = "<br>";\n```\n'
const cases = ['header-first', 'body-first', 'header-consecutive', 'body-consecutive', 'selected-text', 'inline-code', 'ordinary-paragraph', 'native-copy', 'table-controls']
const notes = Object.fromEntries(cases.map((name) => [name, path.join(workspace, `${name}.md`)]))
const golden = path.join(workspace, 'untouched-golden.md')
const parser = remark().use(remarkGfm)
const checks = [], pageErrors = [], runLog = [], nativeObservations = [], keyboardSequences = [], clipboardObservations = []
let application, page, activePath, activeBaseline, expectedModel, lastSavedMarkdown, stage = 'prepare-files'
const clone = (value) => JSON.parse(JSON.stringify(value))
const breakNode = () => ({ type: 'hardbreak', attrs: { isInline: false } })
const tableNode = (doc) => {
  const tables = [], visit = (node) => { if (node.type === 'table') tables.push(node); else node.content?.forEach(visit) }
  visit(doc); assert.equal(tables.length, 1, 'The entire model must contain exactly one table'); return tables[0]
}
const paragraphNode = (doc, row, column) => {
  const cell = tableNode(doc).content[row].content[column]
  assert.equal(cell.content.length, 1, 'Each table cell keeps exactly one paragraph')
  assert.equal(cell.content[0].type, 'paragraph'); return cell.content[0]
}
const appendBreaks = (before, row, column, count) => {
  const expected = clone(before), paragraph = paragraphNode(expected, row, column)
  paragraph.content = [...(paragraph.content ?? []), ...Array.from({ length: count }, breakNode)]
  return expected
}
const quoteTsv = (value) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
const tsv = (rows) => rows.map((row) => row.map(quoteTsv).join('\t')).join('\r\n')
const complete = (name) => { checks.push(name); const line = `Table hardbreak acceptance: ${name}`; runLog.push(line); console.log(line) }

try {
  await mkdir(workspace); await mkdir(artifacts, { recursive: true })
  for (const file of Object.values(notes)) await writeFile(file, original)
  await writeFile(golden, original)
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? ['--disable-gpu'] : ['--disable-gpu', '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), packageVersion, 'Run the executable built from the current package version')
  page = await application.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => { pageErrors.push(String(error)); runLog.push(String(error.stack ?? error)); console.error(error.stack) })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const command = (value) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const markStage = async (value) => { stage = value; await page.evaluate((value) => { window.__tableHardbreakStage = value }, value) }
  const model = () => page.evaluate(() => document.querySelector('.ProseMirror').pmViewDesc.node.toJSON())
  const validateStructure = () => page.evaluate(() => {
    const doc = document.querySelector('.ProseMirror').pmViewDesc.node
    doc.check()
    let tables = 0
    doc.descendants((node) => {
      if (node.type.name === 'table') tables++
      if (node.type.name !== 'table_cell' && node.type.name !== 'table_header') return
      if (node.childCount !== 1 || node.firstChild.type.name !== 'paragraph') throw new Error('A table cell must retain exactly one paragraph')
    })
    if (tables !== 1) throw new Error(`Expected one document table; found ${tables}`)
  })
  const waitModel = async (expected) => {
    expectedModel = clone(expected)
    await page.waitForFunction((expected) => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()) === JSON.stringify(expected), expected)
    await validateStructure()
  }
  const cell = (row, column) => page.locator(documentTableSelector).first().locator('tbody[data-content-dom="true"] > tr').nth(row).locator('th,td').nth(column)
  const clickCell = async (row, column, modifiers = []) => {
    const paragraph = cell(row, column).locator('p').first(); await paragraph.scrollIntoViewIfNeeded()
    const position = await paragraph.evaluate((element) => {
      const bounds = element.getBoundingClientRect(), target = element.closest('th,td')
      // Prefer a point on the first visual line. All caret navigation below is
      // then real Home/ArrowRight keys, including traversal of existing breaks.
      const xs = [...new Set([16, 24, 32, bounds.width - 16, bounds.width - 24, bounds.width / 2, 8].map((x) => Math.max(2, Math.min(bounds.width - 2, x))))]
      const ys = [...new Set([8, 4, 12].map((y) => Math.max(2, Math.min(bounds.height - 2, y))))]
      for (const y of ys) for (const x of xs) {
        const hit = document.elementFromPoint(bounds.left + x, bounds.top + y)
        if (hit && element.contains(hit) && hit.closest('th,td') === target && !hit.closest('a,button,input,textarea,select,[contenteditable="false"],[data-display-type="tool"],.handle,.column-resize-handle')) return { x, y }
      }
      return null
    })
    assert.ok(position, `Cell ${row},${column} needs a real visible prose point outside controls`)
    await paragraph.click({ position, modifiers })
  }
  const focusedCell = () => page.evaluate((selector) => {
    const selection = window.getSelection(), node = selection?.focusNode
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement, target = element?.closest('th,td')
    const row = target?.parentElement, table = target?.closest('table')
    if (!target || !row || !table || !table.matches(selector.replace('.ProseMirror .milkdown-table-block ', ''))) return null
    return [Array.from(table.querySelectorAll('tbody[data-content-dom="true"] > tr')).indexOf(row), Array.from(row.querySelectorAll('th,td')).indexOf(target)]
  }, documentTableSelector)
  const focusAt = async (row, column, offset) => {
    await clickCell(row, column); await page.locator('[data-table-tools]').waitFor(); await page.keyboard.press('Home')
    for (let index = 0; index < offset; index++) await page.keyboard.press('ArrowRight')
    assert.deepEqual(await focusedCell(), [row, column], 'Real caret navigation must stay in its intended cell')
  }
  const selectedCells = () => page.evaluate((selector) => Array.from(document.querySelector(selector)?.querySelectorAll('tbody[data-content-dom="true"] > tr') ?? []).flatMap((row, r) => Array.from(row.querySelectorAll('th,td')).flatMap((cell, c) => cell.classList.contains('selectedCell') ? [[r, c]] : [])), documentTableSelector)
  const selectRectangle = async (ar, ac, hr, hc) => {
    await clickCell(ar, ac); await clickCell(hr, hc, ['Shift'])
    const expected = (Math.abs(ar - hr) + 1) * (Math.abs(ac - hc) + 1)
    await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.querySelectorAll('tbody[data-content-dom="true"] .selectedCell').length === expected, { selector: documentTableSelector, expected })
  }
  const clipboardRead = () => application.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read(), item = items.find((item) => item.types.includes('text/html'))
    return { text: await clipboard.readText(), html: item ? await (await item.getType('text/html')).text() : '' }
  })
  const save = async () => {
    await page.evaluate(() => {
      window.__tableHardbreakSaveReceived = false
      const remove = window.ttypora.onAppCommand((value) => { if (value === 'save-document') { window.__tableHardbreakSaveReceived = true; remove() } })
    })
    await command('save-document'); await page.waitForFunction(() => window.__tableHardbreakSaveReceived); await settle()
    await page.waitForFunction(() => !document.title.startsWith('●') && /已保存：|文档没有需要保存的修改|Saved:|No document changes to save/.test(document.querySelector('.statusbar')?.textContent ?? ''))
    lastSavedMarkdown = await readFile(activePath, 'utf8'); return lastSavedMarkdown
  }
  const sourceRoundTrip = async (markdown, expected) => {
    await command('toggle-source-mode'); await ready()
    assert.equal(await page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString()), markdown)
    assert.equal(await page.locator('[data-table-tools]').count(), 0)
    await command('toggle-source-mode'); await ready(); await waitModel(expected)
  }
  const persist = async (expected) => {
    const markdown = await save(), tables = []
    const visit = (node) => { if (node.type === 'table') tables.push(node); else node.children?.forEach(visit) }
    visit(parser.parse(markdown)); assert.equal(tables.length, 1)
    const expectedTable = tableNode(expected)
    assert.equal(tables[0].children.length, expectedTable.content.length)
    assert.ok(tables[0].children.every((row) => row.children.length === expectedTable.content[0].content.length))
    await sourceRoundTrip(markdown, expected); return markdown
  }
  const undo = async (expected) => { await command('undo-document'); await waitModel(expected) }
  const redo = async (expected) => { await command('redo-document'); await waitModel(expected) }
  const verifyHistory = async (snapshots) => {
    for (let index = snapshots.length - 2; index >= 0; index--) await undo(snapshots[index])
    for (let index = 1; index < snapshots.length; index++) await redo(snapshots[index])
  }
  const open = async (name) => {
    await markStage(name); activePath = notes[name]
    await page.locator('.file-tree').getByTitle(activePath, { exact: true }).click()
    await page.waitForFunction((name) => document.title.includes(name), path.basename(activePath)); await ready()
    activeBaseline = await model(); expectedModel = clone(activeBaseline); await validateStructure()
    assert.equal(await save(), original, 'An untouched document must retain its original Markdown bytes')
    return clone(activeBaseline)
  }
  const reopen = async (expected) => {
    const saved = await save(); await command('close-document')
    await page.locator('.document-tabs').getByTitle(activePath, { exact: true }).waitFor({ state: 'detached' })
    await page.locator('.file-tree').getByTitle(activePath, { exact: true }).click()
    await page.waitForFunction((name) => document.title.includes(name), path.basename(activePath)); await ready(); await waitModel(expected)
    assert.equal(await save(), saved, 'Fresh disk reopen must preserve saved source bytes')
  }
  const captureKeys = async (name, body) => {
    const first = await page.evaluate(() => window.__tableHardbreakEvents.length)
    await body()
    const events = await page.evaluate((first) => window.__tableHardbreakEvents.slice(first), first)
    const keys = events.filter((event) => event.event === 'keydown' && event.key === 'Enter' && event.shiftKey)
    keyboardSequences.push({ name, shiftEnterCount: keys.length, events })
    return keys
  }
  const action = async (name) => {
    const button = page.locator('[data-table-tools]').locator(`[data-table-action="${name}"]`)
    assert.equal(await button.isEnabled(), true, `Table action ${name} remains available`); await button.click()
  }

  await ready()
  await page.evaluate(() => {
    window.__tableHardbreakEvents = []
    for (const type of ['keydown', 'copy', 'cut', 'paste']) document.addEventListener(type, (event) => {
      window.__tableHardbreakEvents.push({ stage: window.__tableHardbreakStage, event: type, key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, isComposing: event.isComposing, time: performance.now(), focus: document.hasFocus(), active: document.activeElement?.className, browserSelection: window.getSelection()?.toString(), types: event.clipboardData ? [...event.clipboardData.types] : null, text: event.clipboardData?.getData('text/plain'), html: event.clipboardData?.getData('text/html') })
    }, true)
  })
  await command('open-workspace')

  for (const [name, row] of [['header-first', 0], ['body-first', 1]]) {
    const before = await open(name), expected = appendBreaks(before, row, 0, 1)
    await focusAt(row, 0, 4); expectedModel = clone(expected)
    const keys = await captureKeys(name, () => page.keyboard.press('Shift+Enter'))
    assert.equal(keys.length, 1); await waitModel(expected)
    assert.equal(paragraphNode(await model(), row, 0).content.at(-1).attrs.isInline, false)
    assert.ok((await persist(expected)).includes('<br>'))
    await verifyHistory([before, expected]); await reopen(expected)
    complete(`${name}: real first Shift+Enter, one paragraph, exact persistence/source/disk reopen and shared undo/redo`)
  }

  for (const [name, row] of [['header-consecutive', 0], ['body-consecutive', 1]]) {
    const before = await open(name), snapshots = [before]
    await focusAt(row, 0, 4)
    const keys = await captureKeys(name, async () => {
      for (let count = 1; count <= 3; count++) {
        const expected = appendBreaks(before, row, 0, count); expectedModel = clone(expected)
        await page.keyboard.press('Shift+Enter'); await waitModel(expected); snapshots.push(expected)
      }
    })
    assert.equal(keys.length, 3)
    const final = snapshots.at(-1)
    assert.match(await persist(final), /<br><br><br>/)
    await verifyHistory(snapshots); await reopen(final)
    complete(`${name}: three trailing keyboard breaks retain each complete model through source, disk and all shared-history steps`)
  }

  {
    const before = await open('selected-text'), expected = clone(before)
    paragraphNode(expected, 1, 0).content = [{ type: 'text', text: 'B' }, breakNode(), { type: 'text', text: 'Y' }]
    await focusAt(1, 0, 1); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight')
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'OD')
    expectedModel = clone(expected); await page.keyboard.press('Shift+Enter'); await waitModel(expected)
    await persist(expected); await verifyHistory([before, expected]); await reopen(expected)
    complete('selected-text: real Shift+Enter replaces only the selected cell text and preserves all other nodes/marks')
  }

  {
    const before = await open('inline-code'), expected = clone(before), originalCode = clone(paragraphNode(before, 1, 2).content[0])
    assert.equal(originalCode.text, 'A<br>B'); assert.ok(originalCode.marks.some((mark) => mark.type === 'inlineCode'))
    paragraphNode(expected, 1, 2).content = [{ ...clone(originalCode), text: 'A' }, breakNode(), { ...clone(originalCode), text: '<br>B' }]
    await focusAt(1, 2, 1); expectedModel = clone(expected); await page.keyboard.press('Shift+Enter'); await waitModel(expected)
    assert.deepEqual(paragraphNode(await model(), 1, 2).content[1], breakNode(), 'Break must not inherit the inlineCode mark')
    await persist(expected); await verifyHistory([before, expected]); await reopen(expected)
    complete('inline-code: surrounding literal <br> code stays code, the inserted break is unmarked and the external code block stays exact')
  }

  {
    const before = await open('ordinary-paragraph'), beforeTable = clone(tableNode(before))
    const paragraph = page.locator('.ProseMirror > p').filter({ hasText: 'Outside paragraph.' })
    await paragraph.click(); await page.keyboard.press('Home')
    for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+Enter'); await settle()
    const after = await model(); assert.notDeepEqual(after, before, 'The native paragraph handler must still receive Shift+Enter')
    assert.deepEqual(tableNode(after), beforeTable)
    const changed = after.content.filter((node, index) => JSON.stringify(node) !== JSON.stringify(before.content[index]))
    nativeObservations.push({ name: 'ordinary paragraph Shift+Enter', before: before.content, after: after.content, changed })
    // Native paragraphs have their existing normalization rules. Record their
    // observed semantics without requiring the new table-only round-trip rule.
    const markdown = await save(); await command('toggle-source-mode'); await ready()
    assert.equal(await page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString()), markdown)
    await command('toggle-source-mode'); await ready()
    const reloaded = await model(); assert.deepEqual(tableNode(reloaded), beforeTable)
    assert.deepEqual(reloaded.content.filter((node) => node.type === 'code_block'), before.content.filter((node) => node.type === 'code_block'))
    nativeObservations.at(-1).reloaded = reloaded.content
    await undo(before); await redo(reloaded)
    complete('ordinary-paragraph: native keyboard handling remains active, its actual serialization is recorded, nearby table/code stays exact')
  }

  {
    const before = await open('native-copy')
    await focusAt(0, 0, 4)
    for (let count = 1; count <= 3; count++) { await page.keyboard.press('Shift+Enter'); await waitModel(appendBreaks(before, 0, 0, count)) }
    const withHeader = await model(); await focusAt(1, 0, 4)
    for (let count = 1; count <= 3; count++) { await page.keyboard.press('Shift+Enter'); await waitModel(appendBreaks(withHeader, 1, 0, count)) }
    const beforePaste = await model()
    await selectRectangle(0, 0, 1, 0); assert.deepEqual(await selectedCells(), [[0, 0], [1, 0]])
    await page.keyboard.press('Control+c')
    const copied = await clipboardRead(), expectedTsv = tsv([['HEAD\n\n\n'], ['BODY\n\n\n']])
    clipboardObservations.push({ stage: 'native header/body copy', expectedTsv, ...copied })
    assert.equal(copied.text, expectedTsv); assert.match(copied.html, /data-pm-slice=/); assert.match(copied.html, /<br/)
    assert.match(copied.html, /data-ttypora-cell-content=/, 'Native HTML must carry the validated exact cell-content marker')
    const expected = clone(beforePaste)
    tableNode(expected).content[0].content[1].content = clone(tableNode(beforePaste).content[0].content[0].content)
    tableNode(expected).content[1].content[1].content = clone(tableNode(beforePaste).content[1].content[0].content)
    await selectRectangle(0, 1, 1, 1); expectedModel = clone(expected); await page.keyboard.press('Control+v'); await waitModel(expected)
    await persist(expected); await verifyHistory([beforePaste, expected])
    await selectRectangle(0, 1, 1, 1); await page.keyboard.press('Control+c')
    const recopied = await clipboardRead(); clipboardObservations.push({ stage: 'copy back after native HTML paste', expectedTsv, ...recopied })
    assert.equal(recopied.text, expectedTsv, 'Pasted native hardbreak nodes must copy back to the same quoted TSV')
    await reopen(expected)
    complete('native-copy: cross-header/body CellSelection HTML retains three trailing hardbreak nodes, exact TSV, source/disk model and paste history')
  }

  {
    const before = await open('table-controls'), withBreaks = appendBreaks(before, 1, 0, 3)
    await focusAt(1, 0, 4)
    for (let count = 1; count <= 3; count++) { await page.keyboard.press('Shift+Enter'); await waitModel(appendBreaks(before, 1, 0, count)) }
    const added = clone(withBreaks), table = tableNode(added), template = table.content[1]
    table.content.splice(2, 0, { type: 'table_row', content: template.content.map((cell) => ({ type: 'table_cell', attrs: clone(cell.attrs), content: [{ type: 'paragraph' }] })) })
    await focusAt(1, 0, 4); expectedModel = clone(added); await action('add-row-after'); await waitModel(added)
    await persist(added); await verifyHistory([withBreaks, added])
    const aligned = clone(added)
    tableNode(aligned).content.forEach((row) => { row.content[0].attrs.alignment = 'right' })
    await focusAt(1, 0, 4); expectedModel = clone(aligned); await action('align-right'); await waitModel(aligned)
    await persist(aligned); await verifyHistory([added, aligned]); await reopen(aligned)
    complete('table-controls: row insertion and column alignment still preserve hardbreaks, single-paragraph cells and exact shared history')
  }

  assert.equal(await readFile(golden, 'utf8'), original, 'Unopened golden source bytes remain unchanged'); assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: path.join(artifacts, `table-hardbreak-${prefix}-writing.png`), animations: 'disabled', timeout: 60000 })
  const events = await page.evaluate(() => window.__tableHardbreakEvents)
  await writeFile(path.join(artifacts, `table-hardbreak-${prefix}-verification.json`), JSON.stringify({ variant: packaged ? 'packaged' : 'source', version: await application.evaluate(({ app }) => app.getVersion()), executable: packaged ?? null, completedAt: new Date().toISOString(), interaction: 'Real visible prose/Shift-click selection, Home/ArrowRight navigation, Shift+Enter/Ctrl+C/Ctrl+V keyboard, Electron async native clipboard.read/readText/getType, menu commands for save/source/undo/redo/close and fresh file-tree reopen; DOM/model read only for assertions', cases: checks, keyboardSequences, clipboardObservations, nativeObservations, events, tableFullModelEquality: true, oneParagraphPerCell: true, sourceBytesProtected: true, pageErrors, exclusions: ['Native IME, read-only editor UI and external spreadsheet applications are not exercised by this suite', 'Ordinary paragraph normalization retains native behavior and is recorded separately'] }, null, 2) + '\n')
  const message = `Table hardbreak acceptance passed: ${checks.length} GUI cases with no page errors.`
  runLog.push(message); console.log(message)
} catch (error) {
  const message = `Table hardbreak failed at ${stage}: ${String(error.stack ?? error)}`
  runLog.push(message); console.error(message)
  let diagnostic = { unavailable: true }, events = []
  if (page && !page.isClosed()) {
    diagnostic = await page.evaluate((selector) => ({ body: document.body.innerText, model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(), source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state?.doc.toString(), tableDOM: Array.from(document.querySelectorAll(selector)).map((element) => element.outerHTML), selectedCells: Array.from(document.querySelectorAll(`${selector} tbody[data-content-dom="true"] > tr`)).flatMap((row, r) => Array.from(row.querySelectorAll('th,td')).flatMap((cell, c) => cell.classList.contains('selectedCell') ? [[r, c]] : [])), browserSelection: window.getSelection()?.toString() }), documentTableSelector).catch(() => ({ unavailable: true }))
    events = await page.evaluate(() => window.__tableHardbreakEvents ?? []).catch(() => [])
    await page.screenshot({ path: path.join(artifacts, `table-hardbreak-${prefix}-failure.png`), timeout: 60000 }).catch(() => undefined)
  }
  await writeFile(path.join(artifacts, `table-hardbreak-${prefix}-failure.json`), JSON.stringify({ stage, activePath, completedCases: checks, baseline: activeBaseline, expectedModel, lastSavedMarkdown, error: String(error.stack ?? error), diagnostic, keyboardSequences, clipboardObservations, nativeObservations, events, pageErrors }, null, 2) + '\n').catch(() => undefined)
  throw error
} finally {
  await writeFile(path.join(artifacts, `table-hardbreak-${prefix}-run.log`), runLog.join('\n') + '\n').catch(() => undefined)
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  const resolved = path.resolve(temporary), parent = path.resolve(tmpdir())
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase()); assert.ok(path.basename(resolved).startsWith('ttypora-table-hardbreak-'))
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
