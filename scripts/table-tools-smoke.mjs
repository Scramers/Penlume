import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-tables-'))
const workspace = path.join(temporary, 'notes'), artifacts = path.join(root, 'artifacts')
const packaged = process.env.TTYPORA_PACKAGED_EXE
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? 'v0.6-source'
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'))
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
const note = path.join(workspace, '表格工具.md')
const headerNote = path.join(workspace, '仅表头.md')
const singleNote = path.join(workspace, '单列表头.md')
const original = '# 表格工具\n\nBefore table.\n\n| **Head A** | [Head B](https://example.com/head "Head title") | `Head\\|C` |\n| :--- | :---: | ---: |\n| A1 **bold** | [B1 link](https://example.com/body "Body title") | x\\|y |\n| **A2** | `b\\|2` | C2 |\n| A3 | [B3](https://example.com/three) | C3 |\n\nAfter table.\n'
const headerOriginal = '# 仅表头\n\nBefore header.\n\n| **Only** | [Other](https://example.com/only) |\n| :--- | ---: |\n\nAfter header.\n'
const singleOriginal = '# 单列表头\n\nBefore single.\n\n| **Single\\|cell** |\n| :---: |\n\nAfter single.\n'
await writeFile(note, original); await writeFile(headerNote, headerOriginal); await writeFile(singleNote, singleOriginal)
let application, page, activePath = note
const errors = [], verified = []
const parser = remark().use(remarkGfm)
// Crepe renders an empty drag-preview table before the editable document table.
// Its actual ProseMirror contentDOM is the marked tbody inside table.children.
const documentTableSelector = '.ProseMirror .milkdown-table-block table.children'
const savedTable = (markdown) => {
  const tables = []
  const visit = (node) => { if (node.type === 'table') tables.push(node); else node.children?.forEach(visit) }
  visit(parser.parse(markdown))
  assert.equal(tables.length, 1, 'Saved Markdown must contain exactly one native GFM table')
  return tables[0]
}

try {
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? ['--disable-gpu'] : ['--disable-gpu', '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version)
  page = await application.firstWindow()
  page.on('pageerror', (error) => { errors.push(String(error)); console.error(error.stack) })
  const command = (value) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const model = () => page.evaluate(() => JSON.stringify(document.querySelector('.ProseMirror').pmViewDesc.node.toJSON()))
  const waitModel = (expected) => page.waitForFunction((expected) => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()) === expected, expected)
  const tables = () => page.evaluate(() => {
    const result = []
    document.querySelector('.ProseMirror').pmViewDesc.node.descendants((node) => {
      if (node.type.name !== 'table') return
      const rows = [], types = [], alignment = [], content = []
      node.forEach((row) => {
        const texts = [], names = [], aligns = [], contents = []
        row.forEach((cell) => { texts.push(cell.textContent); names.push(cell.type.name); aligns.push(cell.attrs.alignment); contents.push(cell.content.toJSON()) })
        rows.push(texts); types.push(names); alignment.push(aligns); content.push(contents)
      })
      result.push({ rows, types, alignment, content, json: node.toJSON() })
      return false
    })
    return result
  })
  const table = async () => { const result = await tables(); assert.equal(result.length, 1); return result[0] }
  const waitRows = (expected) => page.waitForFunction((expected) => {
    const tables = []
    document.querySelector('.ProseMirror')?.pmViewDesc?.node.descendants((node) => {
      if (node.type.name !== 'table') return
      const rows = []
      node.forEach((row) => { const cells = []; row.forEach((cell) => cells.push(cell.textContent)); rows.push(cells) })
      tables.push(rows); return false
    })
    return tables.length === 1 && JSON.stringify(tables[0]) === JSON.stringify(expected)
  }, expected)
  const cell = (row, column) => page.locator(documentTableSelector).first().locator('tbody[data-content-dom="true"] > tr').nth(row).locator('th,td').nth(column)
  const clickCellProse = async (row, column, modifiers = []) => {
    const paragraph = cell(row, column).locator('p').first()
    await paragraph.scrollIntoViewIfNeeded()
    const position = await paragraph.evaluate((element) => {
      const bounds = element.getBoundingClientRect(), cell = element.closest('th,td')
      // The native row popover can overlap the first few pixels of the first
      // paragraph. Prefer an inset point and verify its actual hit target; the
      // centered/right aligned links in these fixtures must also remain inactive.
      const xs = [...new Set([16, 24, 32, bounds.width - 16, bounds.width - 24, bounds.width / 2, 8].map((x) => Math.max(2, Math.min(bounds.width - 2, x))))]
      const ys = [...new Set([8, bounds.height / 2, bounds.height - 4, 4].map((y) => Math.max(2, Math.min(bounds.height - 2, y))))]
      for (const y of ys) for (const x of xs) {
        const hit = document.elementFromPoint(bounds.left + x, bounds.top + y)
        if (!hit || !element.contains(hit) || hit.closest('th,td') !== cell) continue
        if (hit.closest('a,button,input,textarea,select,[contenteditable="false"],[data-display-type="tool"],.handle,.column-resize-handle')) continue
        return { x, y }
      }
      return null
    })
    assert.ok(position, `Cell ${row},${column} must have a visible prose point outside links and native controls`)
    await paragraph.click({ position, modifiers })
  }
  const focusCell = async (row, column) => { await clickCellProse(row, column); await page.locator('[data-table-tools]').waitFor() }
  const toolbar = () => page.locator('[data-table-tools]')
  const action = async (name) => {
    const button = toolbar().locator(`[data-table-action="${name}"]`)
    assert.equal(await button.isEnabled(), true, `Table action ${name} must be available`)
    await button.click()
  }
  const selectedCells = () => page.evaluate((selector) => Array.from(document.querySelector(selector)?.querySelectorAll('tbody[data-content-dom="true"] > tr') ?? []).flatMap((row, rowIndex) => Array.from(row.querySelectorAll('th,td')).flatMap((cell, columnIndex) => cell.classList.contains('selectedCell') ? [[rowIndex, columnIndex]] : [])), documentTableSelector)
  const waitSelected = (count) => page.waitForFunction(({ count, selector }) => document.querySelector(selector)?.querySelectorAll('tbody[data-content-dom="true"] .selectedCell').length === count, { count, selector: documentTableSelector })
  const selectRectangle = async (anchorRow, anchorColumn, headRow, headColumn) => {
    // Shift-click uses the real ProseMirror table mousedown handler to create a CellSelection.
    // Starting in a cell body avoids Crepe's separate row/column handles and resize borders.
    await focusCell(anchorRow, anchorColumn)
    await clickCellProse(headRow, headColumn, ['Shift'])
    await waitSelected((Math.abs(headRow - anchorRow) + 1) * (Math.abs(headColumn - anchorColumn) + 1))
  }
  const undo = async (expected) => { await page.getByRole('button', { name: documentLanguage === 'en' ? 'Undo' : '撤销', exact: true }).click(); await waitModel(expected) }
  const redo = async (expected) => { await page.getByRole('button', { name: documentLanguage === 'en' ? 'Redo' : '重做', exact: true }).click(); await waitModel(expected) }
  let documentLanguage = 'zh-CN'
  const save = async () => {
    await page.evaluate(() => {
      window.__tableSaveReceived = false
      const remove = window.ttypora.onAppCommand((value) => { if (value === 'save-document') { window.__tableSaveReceived = true; remove() } })
    })
    await command('save-document'); await page.waitForFunction(() => window.__tableSaveReceived)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForFunction(() => !document.title.startsWith('●') && /已保存：|文档没有需要保存的修改|Saved:|No document changes to save/.test(document.querySelector('.statusbar')?.textContent ?? ''))
    return readFile(activePath, 'utf8')
  }
  const sourceRoundTrip = async (markdown, expectedModel) => {
    await command('toggle-source-mode'); await ready()
    const source = page.locator('.source-editor .cm-content')
    assert.equal(await source.evaluate((element) => element.cmTile.root.view.state.doc.toString()), markdown)
    assert.equal(await toolbar().count(), 0)
    await command('toggle-source-mode'); await ready(); await waitModel(expectedModel)
  }
  const open = async (filePath) => {
    activePath = filePath
    await page.locator('.file-tree').getByTitle(filePath, { exact: true }).click()
    await page.waitForFunction((fileName) => document.title.includes(fileName), path.basename(filePath)); await ready()
  }
  const exercise = async (name, row, column, tableAction, expectedRows, inspect = () => {}) => {
    const before = await model()
    await focusCell(row, column); await action(tableAction); await waitRows(expectedRows)
    const after = await model(), current = await table()
    assert.notEqual(after, before)
    await inspect(current)
    const markdown = await save()
    assert.equal(savedTable(markdown).children.length, expectedRows.length)
    await sourceRoundTrip(markdown, after)
    await undo(before); await redo(after); await undo(before)
    verified.push(name); console.log(`Table acceptance: ${name}`)
  }

  await ready(); await command('open-workspace'); await open(note)
  assert.equal(await page.locator(documentTableSelector).count(), 1, 'Locate the document table rather than Crepe\'s empty drag-preview table')
  assert.equal(await page.locator(documentTableSelector).locator('tbody[data-content-dom="true"] > tr').count(), 4)
  const baseline = await table(), baselineModel = await model()
  assert.deepEqual(baseline.rows, [['Head A', 'Head B', 'Head|C'], ['A1 bold', 'B1 link', 'x|y'], ['A2', 'b|2', 'C2'], ['A3', 'B3', 'C3']])
  assert.deepEqual(baseline.alignment, Array.from({ length: 4 }, () => ['left', 'center', 'right']))
  assert.equal(await save(), original)

  await exercise('insert-before-header-demotes-rich-header', 0, 1, 'add-row-before', [['', '', ''], ...baseline.rows], (current) => {
    assert.deepEqual(current.types[0], ['table_header', 'table_header', 'table_header'])
    assert.deepEqual(current.types[1], ['table_cell', 'table_cell', 'table_cell'])
    assert.deepEqual(current.content[1], baseline.content[0])
    assert.deepEqual(current.alignment, Array.from({ length: 5 }, () => ['left', 'center', 'right']))
  })
  assert.equal(await save(), original)
  await exercise('insert-after-final-row', 3, 2, 'add-row-after', [...baseline.rows, ['', '', '']])
  await exercise('insert-before-final-row', 3, 1, 'add-row-before', [...baseline.rows.slice(0, 3), ['', '', ''], baseline.rows[3]])
  await exercise('delete-first-header-promotes-rich-body', 0, 0, 'delete-row', baseline.rows.slice(1), (current) => {
    assert.deepEqual(current.types[0], ['table_header', 'table_header', 'table_header'])
    assert.deepEqual(current.content[0], baseline.content[1])
    assert.deepEqual(current.alignment[0], ['left', 'center', 'right'])
  })
  await exercise('delete-final-row', 3, 2, 'delete-row', baseline.rows.slice(0, 3))
  await exercise('insert-first-column', 1, 0, 'add-column-before', baseline.rows.map((row) => ['', ...row]), (current) => {
    assert.deepEqual(current.alignment, Array.from({ length: 4 }, () => ['left', 'left', 'center', 'right']))
    assert.deepEqual(current.types[0], Array(4).fill('table_header'))
  })
  await exercise('insert-final-column', 3, 2, 'add-column-after', baseline.rows.map((row) => [...row, '']), (current) => {
    assert.deepEqual(current.alignment, Array.from({ length: 4 }, () => ['left', 'center', 'right', 'right']))
  })
  await exercise('delete-first-column', 1, 0, 'delete-column', baseline.rows.map((row) => row.slice(1)), (current) => {
    assert.deepEqual(current.content, baseline.content.map((row) => row.slice(1)))
    assert.deepEqual(current.alignment, Array.from({ length: 4 }, () => ['center', 'right']))
  })
  await exercise('delete-final-column', 3, 2, 'delete-column', baseline.rows.map((row) => row.slice(0, 2)))

  await selectRectangle(1, 0, 2, 1); await action('select-row'); await waitSelected(6)
  assert.deepEqual(await selectedCells(), [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]])
  await action('delete-row'); await waitRows([baseline.rows[0], baseline.rows[3]])
  let after = await model(), current = await table()
  assert.deepEqual(current.content, [baseline.content[0], baseline.content[3]])
  assert.deepEqual(current.alignment, [['left', 'center', 'right'], ['left', 'center', 'right']])
  savedTable(await save())
  await undo(baselineModel); await waitSelected(6)
  await redo(after); await undo(baselineModel); await waitSelected(6)
  verified.push('multi-row-selection-delete-content-history-and-selection')

  await selectRectangle(1, 0, 2, 1); await action('select-column'); await waitSelected(8)
  assert.deepEqual(await selectedCells(), [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1]])
  await action('delete-column'); await waitRows(baseline.rows.map((row) => [row[2]]))
  after = await model(); current = await table()
  assert.deepEqual(current.content, baseline.content.map((row) => [row[2]]))
  assert.deepEqual(current.alignment, Array.from({ length: 4 }, () => ['right']))
  const oneColumnSaved = await save()
  assert.deepEqual(savedTable(oneColumnSaved).align, ['right'])
  assert.ok(oneColumnSaved.includes('Head\\|C')); assert.ok(oneColumnSaved.includes('x\\|y'))
  await undo(baselineModel); await waitSelected(8)
  await redo(after); await undo(baselineModel); await waitSelected(8)
  verified.push('multi-column-selection-delete-rich-pipes-align-history-and-selection')

  await selectRectangle(2, 1, 1, 0)
  const rectangleCells = await selectedCells()
  await command('toggle-source-mode'); await ready()
  const sourceSelection = await page.locator('.source-editor .cm-content').evaluate((element) => {
    const selection = element.cmTile.root.view.state.selection.main
    return { anchor: selection.anchor, head: selection.head }
  })
  assert.ok(sourceSelection.anchor > sourceSelection.head, 'Source keeps the reverse range of the restored table rectangle')
  await command('toggle-source-mode'); await ready(); await waitModel(baselineModel); await waitSelected(4)
  assert.deepEqual(await selectedCells(), rectangleCells)
  assert.equal(await save(), original)
  verified.push('reverse-rectangle-selection-survives-source-round-trip-with-original-bytes')

  await command('toggle-source-mode'); await ready()
  await page.keyboard.press('Control+Home')
  await command('toggle-source-mode'); await ready(); await waitModel(baselineModel)
  assert.deepEqual(await selectedCells(), [], 'A new source selection replaces the carried rectangle')
  assert.equal(await save(), original)
  verified.push('source-caret-change-clears-carried-cell-selection-without-content-edits')

  await selectRectangle(1, 0, 2, 1); await action('align-right')
  await page.waitForFunction(() => {
    let allRight = false
    document.querySelector('.ProseMirror').pmViewDesc.node.descendants((node) => {
      if (node.type.name !== 'table') return
      allRight = true; node.forEach((row) => row.forEach((cell) => { if (cell.attrs.alignment !== 'right') allRight = false })); return false
    })
    return allRight
  })
  after = await model(); current = await table()
  assert.deepEqual(current.content, baseline.content)
  assert.deepEqual(current.alignment, Array.from({ length: 4 }, () => ['right', 'right', 'right']))
  await waitSelected(4)
  assert.equal(await toolbar().locator('[data-table-action="align-right"]').getAttribute('aria-pressed'), 'true')
  assert.equal(await toolbar().locator('[data-table-action="align-right"]').isEnabled(), false)
  assert.deepEqual(savedTable(await save()).align, ['right', 'right', 'right'])
  await undo(baselineModel); await waitSelected(4); await redo(after); await undo(baselineModel)
  await focusCell(2, 2); await action('align-center')
  after = await model()
  assert.deepEqual((await table()).alignment, Array.from({ length: 4 }, () => ['left', 'center', 'center']))
  assert.deepEqual(savedTable(await save()).align, ['left', 'center', 'center'])
  await undo(baselineModel); await redo(after); await undo(baselineModel)
  verified.push('single-and-multiple-column-alignment-persist-and-undo')
  await focusCell(2, 1); await action('align-left')
  after = await model()
  assert.deepEqual((await table()).alignment, Array.from({ length: 4 }, () => ['left', 'left', 'right']))
  assert.deepEqual(savedTable(await save()).align, ['left', 'left', 'right'])
  assert.equal(await toolbar().locator('[data-table-action="align-left"]').isEnabled(), false)
  await undo(baselineModel); await redo(after); await undo(baselineModel)
  verified.push('column-left-alignment-persist-and-undo')

  await focusCell(3, 2); await page.keyboard.press('End'); await page.keyboard.press('Tab')
  await waitRows([...baseline.rows, ['', '', '']])
  after = await model(); current = await table()
  assert.deepEqual(current.alignment[4], ['left', 'center', 'right'])
  const focusedCell = () => page.evaluate(() => {
    const selection = window.getSelection(), element = selection?.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection?.focusNode?.parentElement
    const target = element?.closest('th,td'), row = target?.parentElement, table = target?.closest('table')
    return target && row && table ? [Array.from(table.querySelectorAll('tr')).indexOf(row), Array.from(row.querySelectorAll('th,td')).indexOf(target)] : null
  })
  assert.deepEqual(await focusedCell(), [4, 0])
  await page.keyboard.press('Shift+Tab'); assert.deepEqual(await focusedCell(), [3, 2])
  await page.keyboard.press('Tab'); assert.deepEqual(await focusedCell(), [4, 0])
  assert.equal((await table()).rows.length, 5, 'Moving to an existing cell must not add another row')
  assert.equal(savedTable(await save()).children.length, 5)
  await page.keyboard.press('Control+z'); await waitModel(baselineModel)
  await page.keyboard.press('Control+y'); await waitModel(after)
  await undo(baselineModel)
  verified.push('final-cell-tab-inserts-one-aligned-row-shift-tab-and-shortcut-history')

  await focusCell(0, 0)
  await page.evaluate(() => { window.__tableProse = document.querySelector('.ProseMirror'); window.__tableDoc = window.__tableProse.pmViewDesc.node })
  const switchLanguage = async (locale) => {
    await command('preferences'); await page.locator('.preferences fieldset').first().locator('select').selectOption(locale)
    await page.waitForFunction((locale) => document.documentElement.lang === locale, locale)
    await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'Done' : '完成', exact: true }).click()
    documentLanguage = locale
  }
  await switchLanguage('en')
  await toolbar().getByRole('button', { name: 'Insert row above', exact: true }).waitFor()
  assert.equal(await toolbar().getAttribute('aria-label'), 'Table actions')
  await toolbar().getByRole('button', { name: 'Delete selected rows', exact: true }).waitFor()
  await toolbar().getByRole('button', { name: 'Align column center', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__tableProse === document.querySelector('.ProseMirror') && window.__tableDoc === document.querySelector('.ProseMirror').pmViewDesc.node), true)
  assert.equal(await save(), original)
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(640, 560); window.setSize(680, 760); window.show(); window.focus() })
  await page.waitForFunction(() => innerWidth <= 680)
  const compact = await toolbar().evaluate((element) => {
    const bounds = element.getBoundingClientRect(), buttons = [...element.querySelectorAll('button')].map((button) => { const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width } })
    return { left: bounds.left, right: bounds.right, viewport: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, buttons }
  })
  assert.ok(compact.left >= 0 && compact.right <= compact.viewport && compact.scrollWidth <= compact.clientWidth, JSON.stringify(compact))
  assert.ok(compact.buttons.every((button) => button.left >= compact.left && button.right <= compact.right && button.width > 0), JSON.stringify(compact))
  await page.screenshot({ path: path.join(artifacts, `table-tools-${prefix}-compact-en.png`), animations: 'disabled', timeout: 60000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 860))
  await switchLanguage('zh-CN')
  await toolbar().getByRole('button', { name: '向上插入行', exact: true }).waitFor()
  assert.equal(await toolbar().getAttribute('aria-label'), '表格操作')
  assert.equal(await model(), baselineModel)
  verified.push('live-bilingual-labels-document-identity-and-680px-toolbar-layout')

  // Remove body rows one by one until a legal header-only table remains.
  for (let row = 3; row >= 1; row--) { await focusCell(row, 2); await action('delete-row'); await waitRows(baseline.rows.slice(0, row)) }
  const headerOnlyModel = await model()
  assert.equal(savedTable(await save()).children.length, 1)
  assert.deepEqual((await table()).content[0], baseline.content[0])
  await focusCell(0, 1); await action('delete-row')
  await page.locator(documentTableSelector).waitFor({ state: 'detached' })
  assert.equal(await toolbar().count(), 0)
  const removedModel = await model(), removedMarkdown = await save()
  assert.ok(removedMarkdown.includes('Before table.')); assert.ok(removedMarkdown.includes('After table.'))
  await undo(headerOnlyModel); await redo(removedModel); await undo(headerOnlyModel)
  verified.push('delete-all-body-rows-leaves-header-only-last-row-removes-table-and-undo')

  await open(headerNote)
  const headerBaseline = await table(), headerModel = await model()
  assert.equal(await save(), headerOriginal)
  await exercise('header-only-insert-first-column-keeps-header-schema', 0, 0, 'add-column-before', [['', 'Only', 'Other']], (current) => {
    assert.deepEqual(current.types[0], Array(3).fill('table_header'))
    assert.deepEqual(current.content[0].slice(1), headerBaseline.content[0])
    assert.deepEqual(current.alignment[0], ['left', 'left', 'right'])
  })
  await exercise('header-only-insert-last-column-keeps-header-schema', 0, 1, 'add-column-after', [['Only', 'Other', '']], (current) => {
    assert.deepEqual(current.types[0], Array(3).fill('table_header'))
    assert.deepEqual(current.alignment[0], ['left', 'right', 'right'])
  })
  await focusCell(0, 0); await action('delete-table'); await page.locator(documentTableSelector).waitFor({ state: 'detached' })
  after = await model(); const deletedHeader = await save()
  assert.ok(deletedHeader.includes('Before header.')); assert.ok(deletedHeader.includes('After header.'))
  await undo(headerModel); await redo(after); await undo(headerModel)
  assert.equal(await save(), headerOriginal)
  verified.push('header-only-delete-table-toolbar-with-undo-redo')

  await open(singleNote)
  const singleModel = await model()
  assert.equal(await save(), singleOriginal)
  await focusCell(0, 0); await action('delete-column'); await page.locator(documentTableSelector).waitFor({ state: 'detached' })
  after = await model(); const deletedSingle = await save()
  assert.ok(deletedSingle.includes('Before single.')); assert.ok(deletedSingle.includes('After single.'))
  await undo(singleModel); await redo(after); await undo(singleModel)
  assert.equal(await save(), singleOriginal)
  assert.deepEqual((await table()).rows, [['Single|cell']])
  assert.deepEqual((await table()).alignment, [['center']])
  verified.push('one-cell-header-last-column-delete-and-exact-undo')

  await focusCell(0, 0)
  await page.screenshot({ path: path.join(artifacts, `table-tools-${prefix}-writing.png`), animations: 'disabled', timeout: 60000 })
  assert.deepEqual(errors, [])
  await writeFile(path.join(artifacts, `table-tools-${prefix}-verification.json`), JSON.stringify({ variant: packaged ? 'packaged' : 'source', version: await application.evaluate(({ app }) => app.getVersion()), untouchedMarkdownBytes: true, interaction: 'Real mouse clicks, Shift-click rectangular cell selection and keyboard Tab; DOM model read only for assertions', cases: verified, compactToolbar: compact, pageErrors: errors }, null, 2) + '\n')
  console.log(`Table tools acceptance passed: ${verified.length} cases, persisted GFM semantics, shared history, live localization and narrow layout. No page errors.`)
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.locator('body').innerText().catch(() => 'unavailable'))
    console.error('Crepe table DOM:', await page.locator('.ProseMirror .milkdown-table-block table').evaluateAll((elements) => elements.map((element) => ({ className: element.className, dragPreview: Boolean(element.closest('.drag-preview')), html: element.outerHTML }))).catch(() => 'unavailable'))
    await page.screenshot({ path: path.join(artifacts, `table-tools-${prefix}-failure.png`), timeout: 60000 }).catch(() => undefined)
  }
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
