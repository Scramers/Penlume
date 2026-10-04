import { showFormattingToolbar } from './smoke-ui.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'

// Build and GUI ownership belong to the root verifier. This script only launches
// the selected existing executable and uses the real Windows/Electron clipboard.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-table-clipboard-'))
const workspace = path.join(temporary, 'notes'), artifacts = path.join(root, 'artifacts')
const packaged = process.env.TTYPORA_PACKAGED_EXE
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v0.8-${packaged ? 'packaged' : 'source'}`
const historyOnly = process.env.TTYPORA_CLIPBOARD_HISTORY_ONLY === '1'
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'))
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
const original = '# Clipboard table\n\nBefore table.\n\n| **Head A** | [Head B](https://example.com/head "Head title") | `Head\\|C` |\n| :--- | :---: | ---: |\n| A1 **bold** | [B1 link](https://example.com/body "Body title") | x\\|y |\n| **A2** | `b\\|2` | C2 |\n| A3 | [B3](https://example.com/three) | C3 |\n\nAfter table.\n'
const labels = ['no-th-html', 'quoted-tsv', 'caret-expansion', 'clipped-grid', 'tiled-grid', 'scalar-grid', 'internal-copy', 'plain-intent', 'cut', 'reject', 'paragraph-rich', 'table-history', 'paragraph-history', 'code-meta-history', 'source-history']
const notes = Object.fromEntries(labels.map((name) => [name, path.join(workspace, `${name}.md`)]))
const tableHistoryOriginal = '# Table history\n\n| H | B |\n| --- | --- |\n|  | z |\n\nTail.\n'
const historyFixtures = {
  'table-history': tableHistoryOriginal,
  'paragraph-history': '# Paragraph history\n\na\n',
  'code-meta-history': '# Code metadata history\n\n```text a\nvalue\n```\n',
  'source-history': '# Source history\n\na\n',
}
const golden = path.join(workspace, 'untouched-golden.md')
for (const [name, file] of Object.entries(notes)) await writeFile(file, historyFixtures[name] ?? original)
await writeFile(golden, original)
const parser = remark().use(remarkGfm)
const documentTableSelector = '.ProseMirror .milkdown-table-block table.children'
const pageErrors = [], checks = [], timings = []
let application, page, activePath, stage = 'launch', activeBaseline, latestExpectedModel, latestExpectedSource, activeTimingName
const quoteTsv = (value) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
const tsv = (rows) => rows.map((row) => row.map(quoteTsv).join('\t')).join('\r\n')
const clone = (value) => JSON.parse(JSON.stringify(value))
const markNames = (content) => {
  const names = []; const visit = (node) => { node.marks?.forEach((mark) => names.push(mark.type)); node.content?.forEach(visit) }
  content.forEach(visit); return names
}
const savedTable = (markdown) => {
  const tables = [], visit = (node) => { if (node.type === 'table') tables.push(node); else node.children?.forEach(visit) }
  visit(parser.parse(markdown)); assert.equal(tables.length, 1, 'Persisted Markdown must have exactly one GFM table'); return tables[0]
}

try {
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? ['--disable-gpu'] : ['--disable-gpu', '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version)
  page = await application.firstWindow(); await showFormattingToolbar(application, page); page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => { pageErrors.push(String(error)); console.error(error.stack) })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const command = (value) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const model = () => page.evaluate(() => JSON.stringify(document.querySelector('.ProseMirror').pmViewDesc.node.toJSON()))
  const waitModel = (expected) => { latestExpectedModel = expected; return page.waitForFunction((expected) => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()) === expected, expected) }
  const sourceText = () => page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString())
  const waitSource = (expected) => { latestExpectedSource = expected; return page.waitForFunction((expected) => document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === expected, expected) }
  const tables = () => page.evaluate(() => {
    const result = []
    document.querySelector('.ProseMirror').pmViewDesc.node.descendants((node) => {
      if (node.type.name !== 'table') return
      const rows = [], types = [], alignment = [], content = []
      node.forEach((row) => { const text = [], names = [], aligns = [], contents = []; row.forEach((cell) => { text.push(cell.textContent); names.push(cell.type.name); aligns.push(cell.attrs.alignment); contents.push(cell.content.toJSON()) }); rows.push(text); types.push(names); alignment.push(aligns); content.push(contents) })
      result.push({ rows, types, alignment, content, json: node.toJSON() }); return false
    }); return result
  })
  const table = async () => { const result = await tables(); assert.equal(result.length, 1, 'Paste must never split the destination into multiple tables'); return result[0] }
  const waitRows = (expected) => page.waitForFunction((expected) => {
    const result = []
    document.querySelector('.ProseMirror')?.pmViewDesc?.node.descendants((node) => { if (node.type.name !== 'table') return; const rows = []; node.forEach((row) => { const cells = []; row.forEach((cell) => cells.push(cell.textContent)); rows.push(cells) }); result.push(rows); return false })
    return result.length === 1 && JSON.stringify(result[0]) === JSON.stringify(expected)
  }, expected)
  const cell = (row, column) => page.locator(documentTableSelector).first().locator('tbody[data-content-dom="true"] > tr').nth(row).locator('th,td').nth(column)
  const clickCell = async (row, column, modifiers = []) => {
    const paragraph = cell(row, column).locator('p').first(); await paragraph.scrollIntoViewIfNeeded()
    const position = await paragraph.evaluate((element) => {
      const bounds = element.getBoundingClientRect(), targetCell = element.closest('th,td')
      const xs = [...new Set([16, 24, 32, bounds.width - 16, bounds.width - 24, bounds.width / 2, 8].map((x) => Math.max(2, Math.min(bounds.width - 2, x))))]
      const ys = [...new Set([8, bounds.height / 2, bounds.height - 4, 4].map((y) => Math.max(2, Math.min(bounds.height - 2, y))))]
      for (const y of ys) for (const x of xs) { const hit = document.elementFromPoint(bounds.left + x, bounds.top + y); if (hit && element.contains(hit) && hit.closest('th,td') === targetCell && !hit.closest('a,button,input,textarea,select,[contenteditable="false"],[data-display-type="tool"],.handle,.column-resize-handle')) return { x, y } }
      return null
    })
    assert.ok(position, `Cell ${row},${column} needs a real visible prose point outside native controls and links`)
    await paragraph.click({ position, modifiers })
  }
  const focusCell = async (row, column) => { await clickCell(row, column); await page.locator('[data-table-tools]').waitFor() }
  const selectRectangle = async (ar, ac, hr, hc) => {
    await focusCell(ar, ac)
    // Native tableEditing starts a CellSelection only when Shift-click reaches
    // another cell. Once started, Shift-click can contract it back to one cell.
    if (ar === hr && ac === hc) {
      const neighbor = ac === 0 ? 1 : ac - 1
      await clickCell(ar, neighbor, ['Shift'])
      await page.waitForFunction(({ selector }) => document.querySelector(selector)?.querySelectorAll('tbody[data-content-dom="true"] .selectedCell').length === 2, { selector: documentTableSelector })
    }
    await clickCell(hr, hc, ['Shift'])
    const count = (Math.abs(hr - ar) + 1) * (Math.abs(hc - ac) + 1)
    await page.waitForFunction(({ count, selector }) => document.querySelector(selector)?.querySelectorAll('tbody[data-content-dom="true"] .selectedCell').length === count, { count, selector: documentTableSelector })
  }
  const clipboardWrite = async (data) => {
    const written = await application.evaluate(async ({ clipboard, ClipboardItem }, data) => {
      await clipboard.write([new ClipboardItem({ 'text/plain': data.text ?? '', ...(data.html ? { 'text/html': data.html } : {}) })])
      const items = await clipboard.read(), item = items.find((item) => item.types.includes('text/html'))
      return { requested: data, text: await clipboard.readText(), html: item ? await (await item.getType('text/html')).text() : '' }
    }, data)
    await page.evaluate((written) => window.__clipboardDiagnostics?.push({ nativeClipboard: written }), written)
    assert.equal(written.text, data.text ?? '', 'The native clipboard must contain the text before the real paste shortcut')
    if (data.html) assert.ok(written.html.includes(data.html), 'The native clipboard must contain the HTML before the real paste shortcut')
  }
  const clipboardRead = () => application.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read(), item = items.find((item) => item.types.includes('text/html'))
    return { text: await clipboard.readText(), html: item ? await (await item.getType('text/html')).text() : '' }
  })
  const paste = async (data, plain = false) => { await clipboardWrite(data); await page.keyboard.press(plain ? 'Control+Shift+v' : 'Control+v') }
  const undo = async (expected) => { await page.getByRole('button', { name: '撤销', exact: true }).click(); await waitModel(expected) }
  const redo = async (expected) => { await page.getByRole('button', { name: '重做', exact: true }).click(); await waitModel(expected) }
  const save = async () => {
    await page.evaluate(() => { window.__clipboardSaveReceived = false; const remove = window.ttypora.onAppCommand((value) => { if (value === 'save-document') { window.__clipboardSaveReceived = true; remove() } }) })
    await command('save-document'); await page.waitForFunction(() => window.__clipboardSaveReceived); await settle()
    await page.waitForFunction(() => !document.title.startsWith('●') && /已保存：|文档没有需要保存的修改|Saved:|No document changes to save/.test(document.querySelector('.statusbar')?.textContent ?? ''))
    return readFile(activePath, 'utf8')
  }
  const sourceRoundTrip = async (markdown, expectedModel) => {
    await command('toggle-source-mode'); await ready()
    assert.equal(await page.locator('.source-editor .cm-content').evaluate((element) => element.cmTile.root.view.state.doc.toString()), markdown)
    await command('toggle-source-mode'); await ready(); await waitModel(expectedModel)
  }
  const open = async (name) => {
    stage = name; activePath = notes[name]; assert.ok(activePath, `Unknown fixture ${name}`)
    await page.locator('.file-tree').getByTitle(activePath, { exact: true }).click()
    await page.waitForFunction((name) => document.title.includes(name), path.basename(activePath)); await ready()
    const initial = historyFixtures[name] ?? original
    assert.equal(await save(), initial, 'Opening and saving without edits must preserve original source bytes')
    activeBaseline = await model(); latestExpectedModel = activeBaseline; latestExpectedSource = undefined
    return name.endsWith('-history') && name !== 'table-history' ? null : table()
  }
  const complete = (name) => { checks.push(name); console.log(`Table clipboard acceptance: ${name}`) }
  const verifyPersistAndHistory = async (before, expectedRows) => {
    const after = await model(), markdown = await save(), parsed = savedTable(markdown)
    assert.equal(parsed.children.length, expectedRows.length); assert.ok(parsed.children.every((row) => row.children.length === expectedRows[0].length))
    await sourceRoundTrip(markdown, after); await undo(before); await redo(after); await undo(before)
    return { after, markdown }
  }

  await ready(); await command('open-workspace')
  await page.evaluate(() => {
    window.__clipboardDiagnostics = []
    for (const type of ['paste', 'keydown']) document.addEventListener(type, (event) => {
      if (type === 'keydown' && !(event.ctrlKey && /[vcx]/i.test(event.key))) return
      window.__clipboardDiagnostics.push({ event: type, key: event.key, focus: document.hasFocus(), active: document.activeElement?.className, types: event.clipboardData ? [...event.clipboardData.types] : null, text: event.clipboardData?.getData('text/plain'), html: event.clipboardData?.getData('text/html') })
    }, true)
  })
  let baseline, expected, current, copied
  if (!historyOnly) {
  baseline = await open('no-th-html'); expected = clone(baseline.rows)
  await focusCell(1, 1)
  await paste({ text: 'fallback\twrong\r\nfallback2\twrong2', html: '<table><tbody><tr><td><strong>HTML Bold</strong></td><td><a href="https://example.com/html" title="Paste title">HTML Link</a></td></tr><tr><td><em>HTML Italic</em></td><td><code>HTML Code</code></td></tr></tbody></table>' })
  expected[1].splice(1, 2, 'HTML Bold', 'HTML Link'); expected[2].splice(1, 2, 'HTML Italic', 'HTML Code'); await waitRows(expected)
  current = await table()
  assert.deepEqual(current.alignment, baseline.alignment); assert.deepEqual(current.content[1][0], baseline.content[1][0]); assert.deepEqual(current.content[0], baseline.content[0]); assert.deepEqual(current.content[3], baseline.content[3])
  assert.ok(markNames(current.content[1][1]).includes('strong')); assert.ok(markNames(current.content[1][2]).includes('link')); assert.ok(markNames(current.content[2][1]).includes('emphasis')); assert.ok(markNames(current.content[2][2]).includes('inlineCode'))
  await verifyPersistAndHistory(activeBaseline, expected); complete('no-th HTML body-caret paste preserves rich marks, existing cells, column alignment and one table')

  baseline = await open('quoted-tsv')
  const quotedRows = [[' 左\t右 ', '第一行\r\n第二行', '他说"好"|pipe', '中文 ', ''], [' leading ', 'trailing ', '', 'x|y', ''], ['', '', '', '', '']]
  expected = [baseline.rows[0].concat('', ''), ...quotedRows]
  await focusCell(1, 0); await paste({ text: tsv(quotedRows) }); await waitRows(expected)
  current = await table(); assert.deepEqual(current.rows.slice(1), quotedRows, 'Quotes protect field tab/newline/quote/pipe/Chinese/space data and explicit final empty row')
  const quotedModel = await model(), quotedMarkdown = await save()
  assert.equal(savedTable(quotedMarkdown).children.length, 4); assert.ok(savedTable(quotedMarkdown).children.every((row) => row.children.length === 5))
  await sourceRoundTrip(quotedMarkdown, quotedModel); assert.deepEqual((await table()).rows.slice(1), quotedRows)
  await selectRectangle(1, 0, 3, 4); await page.keyboard.press('Control+c')
  copied = await clipboardRead(); assert.equal(copied.text, tsv(quotedRows)); assert.match(copied.html, /data-pm-slice=/)
  await undo(activeBaseline); await redo(quotedModel); await undo(activeBaseline)
  complete('quoted TSV fields, empty final column and explicit empty row survive persistence/source round trip and native copy')

  stage = 'quoted-tsv-native-copy-roundtrip'
  assert.equal((await clipboardRead()).text, tsv(quotedRows), 'Undo/redo must retain the quoted native clipboard copy')
  await focusCell(1, 0); await page.keyboard.press('Control+v'); await waitRows(expected)
  latestExpectedModel = quotedModel
  assert.equal(await model(), quotedModel, 'Pasting the native quoted TSV copy at a body caret must reproduce the complete original quoted model')
  assert.deepEqual((await table()).rows.slice(1), quotedRows)
  const copiedQuoted = await verifyPersistAndHistory(activeBaseline, expected)
  assert.equal(copiedQuoted.after, quotedModel)
  assert.equal(copiedQuoted.markdown, quotedMarkdown, 'Native quoted copy/paste must persist exactly the same Markdown')
  complete('native quoted TSV copy pasted back at a body caret restores exact rows/full model, saved/source content and one undo/redo group')

  baseline = await open('caret-expansion'); expected = baseline.rows.map((row) => [...row, '']); expected[3].splice(2, 2, 'E1', 'E2'); expected.push(['', '', 'E3', 'E4'])
  await focusCell(3, 2); await page.keyboard.press('End'); await paste({ text: 'E1\tE2\r\nE3\tE4' }); await waitRows(expected)
  current = await table(); assert.deepEqual(current.content[0].slice(0, 3), baseline.content[0]); assert.deepEqual(current.alignment.map((row) => row.slice(0, 3)), Array.from({ length: 5 }, () => ['left', 'center', 'right']))
  await verifyPersistAndHistory(activeBaseline, expected); complete('last-cell caret paste expands rows/columns without losing uncovered rich cells or alignment')

  baseline = await open('clipped-grid'); expected = clone(baseline.rows); expected[2][1] = 'clip1'
  await selectRectangle(2, 1, 2, 1); await paste({ text: 'clip1\tclip2\r\nclip3\tclip4' }); await waitRows(expected)
  await verifyPersistAndHistory(activeBaseline, expected); complete('larger grid is clipped to a single selected cell')

  baseline = await open('tiled-grid'); expected = clone(baseline.rows)
  const tile = [['t1', 't2'], ['t3', 't4']]
  for (let row = 1; row <= 3; row++) for (let column = 0; column < 3; column++) expected[row][column] = tile[(row - 1) % 2][column % 2]
  await selectRectangle(3, 2, 1, 0); await paste({ text: tsv(tile) }); await waitRows(expected)
  assert.deepEqual((await table()).content[0], baseline.content[0]); await verifyPersistAndHistory(activeBaseline, expected); complete('reverse rectangular selection tiles a smaller grid with clipped last repeats')

  baseline = await open('scalar-grid'); expected = clone(baseline.rows)
  for (let row = 1; row <= 2; row++) for (let column = 0; column <= 1; column++) expected[row][column] = 'scalar'
  await selectRectangle(1, 0, 2, 1); await paste({ text: 'scalar' }); await waitRows(expected)
  await verifyPersistAndHistory(activeBaseline, expected); complete('one-column scalar clipboard fills the whole CellSelection')

  baseline = await open('internal-copy'); await selectRectangle(0, 0, 1, 1); await page.keyboard.press('Control+c'); copied = await clipboardRead()
  assert.equal(copied.text, tsv(baseline.rows.slice(0, 2).map((row) => row.slice(0, 2)))); assert.match(copied.html, /data-pm-slice=/); assert.match(copied.html, /<strong>/); assert.match(copied.html, /https:\/\/example\.com\/head/)
  expected = clone(baseline.rows); expected[2].splice(1, 2, ...baseline.rows[0].slice(0, 2)); expected[3].splice(1, 2, ...baseline.rows[1].slice(0, 2))
  await selectRectangle(2, 1, 3, 2); await page.keyboard.press('Control+v'); await waitRows(expected); current = await table()
  assert.deepEqual(current.content[2].slice(1), baseline.content[0].slice(0, 2)); assert.deepEqual(current.content[3].slice(1), baseline.content[1].slice(0, 2)); assert.deepEqual(current.alignment, baseline.alignment)
  await verifyPersistAndHistory(activeBaseline, expected); complete('native cross-header/body open CellSelection copy/paste keeps HTML PM metadata and rich content')

  baseline = await open('plain-intent'); expected = clone(baseline.rows); expected[1].splice(0, 2, 'PLAIN', 'plain2')
  await focusCell(1, 0); await paste({ text: 'PLAIN\tplain2', html: '<table><tr><td><strong>HTML ignored</strong></td><td><em>HTML ignored too</em></td></tr></table>' }, true); await waitRows(expected)
  current = await table(); assert.deepEqual(markNames(current.content[1][0]), []); assert.deepEqual(markNames(current.content[1][1]), [])
  await verifyPersistAndHistory(activeBaseline, expected); complete('real Ctrl+Shift+V honors TSV plain-text intent even when clipboard has HTML')

  baseline = await open('cut'); expected = clone(baseline.rows)
  for (let row = 1; row <= 2; row++) for (let column = 0; column <= 1; column++) expected[row][column] = ''
  await selectRectangle(1, 0, 2, 1); await page.keyboard.press('Control+x'); await waitRows(expected); copied = await clipboardRead()
  assert.equal(copied.text, tsv(baseline.rows.slice(1, 3).map((row) => row.slice(0, 2)))); assert.match(copied.html, /data-pm-slice=/)
  current = await table(); assert.deepEqual(current.types, baseline.types); assert.deepEqual(current.alignment, baseline.alignment); assert.deepEqual(current.content[0], baseline.content[0]); assert.deepEqual(current.content[3], baseline.content[3])
  await verifyPersistAndHistory(activeBaseline, expected); complete('native cut empties selected cell content, preserves table structure and is one undo/redo unit')

  baseline = await open('reject'); await selectRectangle(1, 0, 2, 1)
  const beforeButtons = { undo: await page.getByRole('button', { name: '撤销', exact: true }).isEnabled(), redo: await page.getByRole('button', { name: '重做', exact: true }).isEnabled() }
  assert.equal(beforeButtons.undo, false); assert.equal(beforeButtons.redo, false)
  for (const [name, text] of [['unterminated quoted TSV', '"broken\tvalue'], ['row bound', Array.from({ length: 101 }, () => 'a\tb').join('\r\n')], ['column bound', Array(51).fill('a').join('\t')], ['cell bound', Array.from({ length: 100 }, () => Array(21).fill('a').join('\t')).join('\r\n')]]) {
    await paste({ text }); await settle(); assert.equal(await model(), activeBaseline, `${name} must not alter the model`)
    assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).isEnabled(), beforeButtons.undo, `${name} must not add app history`)
    assert.equal(await page.getByRole('button', { name: '重做', exact: true }).isEnabled(), beforeButtons.redo)
  }
  assert.equal(await save(), original); complete('malformed TSV and row/column/cell bounds leave original bytes, document and history unchanged')

  baseline = await open('paragraph-rich'); const beforeParagraph = activeBaseline
  const paragraph = page.locator('.ProseMirror > p').first(); await paragraph.click(); await page.keyboard.press('End')
  await paste({ text: 'wrong fallback', html: '<strong>Paragraph bold</strong> <a href="https://example.com/paragraph">Paragraph link</a>' })
  await paragraph.locator('strong').waitFor(); await paragraph.locator('a[href="https://example.com/paragraph"]').waitFor()
  assert.deepEqual(await table(), baseline); const paragraphAfter = await model(), paragraphMarkdown = await save(); await sourceRoundTrip(paragraphMarkdown, paragraphAfter)
  await undo(beforeParagraph); await redo(paragraphAfter); await undo(beforeParagraph); complete('ordinary paragraph HTML rich paste keeps marks/links and does not touch nearby table')
  }

  // Each fast sequence is timed from actual renderer keydown events. It has no
  // artificial wait/save/source switch between the three edits, so a pass cannot
  // be explained by the application's 650 ms typing-group timeout.
  const startTiming = () => {
    activeTimingName = stage
    return page.evaluate(() => { window.__clipboardKeys = []; window.__clipboardKeyListener = (event) => { if (['b', 'v', 'd'].includes(event.key.toLowerCase())) window.__clipboardKeys.push({ key: event.key.toLowerCase(), time: performance.now(), ctrlKey: event.ctrlKey, metaKey: event.metaKey, targetTag: event.target?.tagName }) }; document.addEventListener('keydown', window.__clipboardKeyListener, true) })
  }
  const finishTiming = async (name) => {
    activeTimingName = name
    const events = await page.evaluate(() => { document.removeEventListener('keydown', window.__clipboardKeyListener, true); return window.__clipboardKeys })
    const b = events.find((event) => event.key === 'b'), v = events.find((event) => event.key === 'v' && (event.ctrlKey || event.metaKey)), d = events.find((event) => event.key === 'd')
    const interval = b && d ? d.time - b.time : null
    timings.push({ name, intervalMs: interval, keydownEvents: events })
    assert.ok(b && v && d, `${name} must record real typing and paste shortcut keydown events`)
    assert.ok(interval < 650, `${name} took ${interval.toFixed(1)} ms; this run cannot prove paste history boundaries`)
  }
  await open('paragraph-history'); const historyParagraph = page.locator('.ProseMirror > p').last(); await historyParagraph.click(); await page.keyboard.press('End'); await clipboardWrite({ text: 'c' }); await startTiming()
  const beforeHistory = await model(); await page.keyboard.type('b'); const typedB = await model(); await page.keyboard.press('Control+v'); const pastedC = await model(); await page.keyboard.type('d'); const typedD = await model(); await finishTiming('paragraph b/paste c/d')
  assert.equal(await historyParagraph.textContent(), 'abcd'); await undo(pastedC); await undo(typedB); await undo(beforeHistory); await redo(typedB); await redo(pastedC); await redo(typedD)
  complete('sub-650ms single-character paragraph paste separates preceding typing, paste and subsequent typing into three undo/redo groups')

  baseline = await open('table-history'); await focusCell(1, 0); await page.keyboard.press('End'); await clipboardWrite({ text: 'c' }); await startTiming()
  const tableHistoryBefore = await model(); await page.keyboard.type('b'); const tableTypedB = await model()
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowLeft')
  await page.waitForFunction((selector) => document.querySelector(selector)?.querySelectorAll('tbody[data-content-dom="true"] .selectedCell').length === 1, documentTableSelector)
  await page.keyboard.press('Control+v'); const tablePastedC = await model()
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('End'); await page.keyboard.type('d'); const tableTypedD = await model(); await finishTiming('table b/scalar paste c/d')
  assert.equal((await table()).rows[1][0], 'cd'); await undo(tablePastedC); await undo(tableTypedB); await undo(tableHistoryBefore); await redo(tableTypedB); await redo(tablePastedC); await redo(tableTypedD)
  complete('sub-650ms table scalar paste separates surrounding typing and restores every complete table model through undo/redo')

  await open('code-meta-history')
  const metadata = page.locator('[data-code-meta]').first(); await metadata.waitFor(); assert.equal(await metadata.inputValue(), 'a')
  await metadata.click(); await page.keyboard.press('End'); await clipboardWrite({ text: 'c' })
  const metaBefore = await model()
  const metaModel = (value) => {
    const document = JSON.parse(metaBefore); let count = 0
    const visit = (node) => { if (node.type === 'code_block') { assert.equal(node.attrs.language, 'text'); assert.equal(node.attrs.meta, 'a'); node.attrs.meta = value; count++ }; node.content?.forEach(visit) }
    visit(document); assert.equal(count, 1, 'Metadata history fixture must have exactly one code block')
    return JSON.stringify(document)
  }
  const metaB = metaModel('ab'), metaC = metaModel('abc'), metaD = metaModel('abcd')
  await startTiming()
  await page.keyboard.type('b'); latestExpectedModel = metaB; assert.equal(await model(), metaB)
  await page.keyboard.press('Control+v'); latestExpectedModel = metaC; assert.equal(await model(), metaC)
  await page.keyboard.type('d'); latestExpectedModel = metaD; assert.equal(await model(), metaD)
  await finishTiming('native code metadata b/paste c/d'); assert.equal(await metadata.inputValue(), 'abcd')
  for (const [expectedModel, value] of [[metaC, 'abc'], [metaB, 'ab'], [metaBefore, 'a']]) { await undo(expectedModel); assert.equal(await metadata.inputValue(), value) }
  for (const [expectedModel, value] of [[metaB, 'ab'], [metaC, 'abc'], [metaD, 'abcd']]) { await redo(expectedModel); assert.equal(await metadata.inputValue(), value) }
  const metaMarkdown = await save(); assert.ok(metaMarkdown.includes('```text abcd\nvalue\n```'))
  await sourceRoundTrip(metaMarkdown, metaD)
  complete('sub-650ms native code metadata paste waits for its input/model notification and preserves all four full models through three undo/redo groups')

  await open('source-history'); await command('toggle-source-mode'); await ready()
  const source = page.locator('.source-editor .cm-content'), sourceBefore = historyFixtures['source-history']
  assert.equal(await sourceText(), sourceBefore)
  await source.click(); await page.keyboard.press('Control+End'); await page.keyboard.press('ArrowLeft'); await clipboardWrite({ text: 'c' })
  const sourceB = sourceBefore.replace(/a\n$/, 'ab\n'), sourceC = sourceBefore.replace(/a\n$/, 'abc\n'), sourceD = sourceBefore.replace(/a\n$/, 'abcd\n')
  await startTiming()
  await page.keyboard.type('b'); latestExpectedSource = sourceB; assert.equal(await sourceText(), sourceB)
  await page.keyboard.press('Control+v'); latestExpectedSource = sourceC; assert.equal(await sourceText(), sourceC)
  await page.keyboard.type('d'); latestExpectedSource = sourceD; assert.equal(await sourceText(), sourceD)
  await finishTiming('source CodeMirror b/paste c/d')
  for (const expectedSource of [sourceC, sourceB, sourceBefore]) { await page.getByRole('button', { name: '撤销', exact: true }).click(); await waitSource(expectedSource) }
  for (const expectedSource of [sourceB, sourceC, sourceD]) { await page.getByRole('button', { name: '重做', exact: true }).click(); await waitSource(expectedSource) }
  assert.equal(await save(), sourceD, 'All source keyboard and paste changes must actually persist')
  await command('toggle-source-mode'); await ready()
  complete('sub-650ms source CodeMirror native paste preserves every full source string through three undo/redo groups and actual save')

  assert.equal(await readFile(golden, 'utf8'), original, 'Unopened golden source bytes remain untouched'); assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: path.join(artifacts, `table-clipboard-${prefix}-writing.png`), animations: 'disabled', timeout: 60000 })
  await writeFile(path.join(artifacts, `table-clipboard-${prefix}-verification.json`), JSON.stringify({ variant: packaged ? 'packaged' : 'source', version: await application.evaluate(({ app }) => app.getVersion()), scope: historyOnly ? 'history-only subset: paragraph, table, native code metadata and source CodeMirror fast history' : 'full table clipboard and history suite', skippedCases: historyOnly ? ['The first 11 existing table/rich HTML cases and the additional quoted TSV native-copy re-paste case'] : [], interaction: 'Real Electron native clipboard.write(ClipboardItem[])/read/readText/getType, keyboard Ctrl+V/Ctrl+Shift+V/Ctrl+C/Ctrl+X, visible prose/native metadata/CodeMirror clicks and native table selection shortcuts; DOM/model read only for assertions', sourceBytesProtected: true, cases: checks, fastHistoryTimings: timings, pageErrors, exclusions: ['Native IME and external spreadsheet application interoperability are not exercised', 'Merged-cell or mixed multi-table HTML rejection is covered by core unit tests, not this GUI suite'] }, null, 2) + '\n')
  console.log(`Table clipboard acceptance passed: ${checks.length} cases, native clipboard, persisted/source-round-trip table semantics and separate shared-history groups.`)
} catch (error) {
  console.error(`Table clipboard failed at: ${stage}`)
  if (page && !page.isClosed()) {
    const diagnostic = await page.evaluate((selector) => ({ body: document.body.innerText, model: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON(), source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString(), codeMetadata: Array.from(document.querySelectorAll('[data-code-meta]')).map((input) => ({ value: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, focused: document.activeElement === input })), tableDOM: Array.from(document.querySelectorAll(selector)).map((element) => element.outerHTML), selectedCells: Array.from(document.querySelectorAll(`${selector} tbody[data-content-dom="true"] > tr`)).flatMap((row, r) => Array.from(row.querySelectorAll('th,td')).flatMap((cell, c) => cell.classList.contains('selectedCell') ? [[r, c]] : [])), browserSelection: window.getSelection()?.toString() }), documentTableSelector).catch(() => ({ unavailable: true }))
    const events = await page.evaluate(() => window.__clipboardDiagnostics ?? []).catch(() => [])
    const timingKeydownEvents = await page.evaluate(() => window.__clipboardKeys ?? []).catch(() => [])
    await writeFile(path.join(artifacts, `table-clipboard-${prefix}-failure.json`), JSON.stringify({ stage, scope: historyOnly ? 'history-only subset' : 'full suite', completedCases: checks, latestExpectedModel, latestExpectedSource, activeBaseline, activeTimingName, timingKeydownEvents, fastHistoryTimings: timings, pageErrors, error: String(error.stack ?? error), diagnostic, events }, null, 2) + '\n')
    await page.screenshot({ path: path.join(artifacts, `table-clipboard-${prefix}-failure.png`), timeout: 60000 }).catch(() => undefined)
  }
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  const resolved = path.resolve(temporary), parent = path.resolve(tmpdir())
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase()); assert.ok(path.basename(resolved).startsWith('ttypora-table-clipboard-'))
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
