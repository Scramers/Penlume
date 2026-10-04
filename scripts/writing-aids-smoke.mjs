import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

// The root builds once and runs desktop suites sequentially. This script never builds.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-writing-aids-'))
const workspace = path.join(temporary, 'notes'), artifacts = path.join(root, 'artifacts')
const packaged = process.env.TTYPORA_PACKAGED_EXE
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v0.6-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'))
await mkdir(workspace); await mkdir(artifacts, { recursive: true })
const note = path.join(workspace, '写作辅助.md')
const original = '---\ntitle: "existing"\n---\n\n# Writing aids\n\nExisting "quotes" -- ... stay unchanged.\n\n```\nconst old = "literal"; // -- ...\n```\n\n$$\na -- b\n$$\n\n<div>"HTML" -- ...</div>\n\nTail.\n'
await writeFile(note, original)
let application, page
const pageErrors = [], checks = []

try {
  application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? ['--disable-gpu'] : ['--disable-gpu', '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  page = await application.firstWindow()
  page.on('pageerror', (error) => { pageErrors.push(String(error)); console.error(error.stack) })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const command = (value) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const prose = () => page.locator('.ProseMirror')
  const source = () => page.locator('.source-editor .cm-content')
  const paragraph = () => page.locator('.ProseMirror > p').last()
  const sourceText = () => source().evaluate((element) => element.cmTile.root.view.state.doc.toString())
  const model = () => page.evaluate(() => JSON.stringify(document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON()))
  const save = async () => {
    await page.evaluate(() => {
      window.__writingSaveReceived = false
      const remove = window.ttypora.onAppCommand((value) => { if (value === 'save-document') { window.__writingSaveReceived = true; remove() } })
    })
    await command('save-document'); await page.waitForFunction(() => window.__writingSaveReceived)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForFunction(() => !document.title.startsWith('●') && /已保存：|文档没有需要保存的修改|Saved:|No document changes to save/.test(document.querySelector('.statusbar')?.textContent ?? ''))
    return readFile(note, 'utf8')
  }
  const changePreferences = async (changes) => {
    await command('preferences')
    const dialog = page.getByRole('dialog', { name: '偏好设置', exact: true })
    await dialog.waitFor()
    const labels = { smartPunctuation: '智能引号、破折号与省略号', autoPair: '自动配对括号与引号', autoLink: '输入和粘贴网址时创建链接', codeWrap: '代码自动换行', codeLineNumbers: '代码行号' }
    for (const [key, value] of Object.entries(changes)) {
      if (key in labels) await dialog.getByRole('checkbox', { name: labels[key], exact: true }).setChecked(value)
      else if (key === 'defaultCodeLanguage') await dialog.getByLabel('新代码块默认语言', { exact: true }).fill(value)
      else if (key === 'tabSize') await dialog.getByLabel('缩进宽度', { exact: true }).fill(String(value))
    }
    await dialog.getByRole('button', { name: '完成', exact: true }).click(); await dialog.waitFor({ state: 'detached' })
    await page.waitForFunction((changes) => { const value = JSON.parse(localStorage.getItem('ttypora.preferences') ?? '{}'); return Object.entries(changes).every(([key, expected]) => value[key] === expected) }, changes)
  }
  const addVisualParagraph = async () => { await paragraph().click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await paragraph().waitFor(); return paragraph() }
  const paste = async (text) => { await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), text); await page.keyboard.press('Control+v') }
  const selectWord = async (target, text) => { await target.click(); if (await target.evaluate((element) => Boolean(element.closest('.source-editor')))) await page.keyboard.press('Control+End'); await page.keyboard.press('Home'); for (let i = 0; i < text.length; i++) await page.keyboard.press('Shift+ArrowRight'); assert.equal(await page.evaluate(() => window.getSelection()?.toString()), text) }
  const composition = async (target, text) => {
    await target.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })))
    await page.keyboard.type(text, { delay: 35 })
    await target.evaluate((element, text) => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text })), text)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const cmStatus = () => page.evaluate(() => [...document.querySelectorAll('.ttypora-code-block .cm-content, .ttypora-math-block .cm-content')].map((content) => ({ text: content.cmTile.root.view.state.doc.toString(), tabSize: content.cmTile.root.view.state.tabSize, wrap: content.classList.contains('cm-lineWrapping'), numbers: [...content.closest('.cm-editor').querySelectorAll('.cm-lineNumbers')].some((gutter) => getComputedStyle(gutter).display !== 'none') })))

  await ready(); await command('open-workspace')
  await page.locator('.file-tree').getByTitle(note, { exact: true }).click(); await ready()
  await page.locator('.ttypora-code-block').scrollIntoViewIfNeeded()
  await page.locator('.ttypora-code-block .cm-content').waitFor()
  await page.locator('.ttypora-math-block .cm-content').waitFor()
  assert.equal(await save(), original)
  const initialModel = await model()
  await page.evaluate(() => { window.__writingProse = document.querySelector('.ProseMirror'); window.__writingDoc = window.__writingProse.pmViewDesc.node; window.__writingCode = document.querySelector('.ttypora-code-block .cm-content'); window.__writingMath = document.querySelector('.ttypora-math-block .cm-content') })
  await changePreferences({ smartPunctuation: true, autoPair: false, autoLink: true, codeWrap: true, codeLineNumbers: false, defaultCodeLanguage: 'python', tabSize: 4 })
  console.log('Updated embedded code settings:', await cmStatus())
  await page.waitForFunction(() => [...document.querySelectorAll('.ttypora-code-block .cm-content, .ttypora-math-block .cm-content')].every((content) => content.cmTile.root.view.state.tabSize === 4 && content.classList.contains('cm-lineWrapping') && [...content.closest('.cm-editor').querySelectorAll('.cm-lineNumbers')].every((gutter) => getComputedStyle(gutter).display === 'none')))
  assert.equal(await page.evaluate(() => document.querySelector('.ProseMirror') === window.__writingProse && window.__writingDoc === window.__writingProse.pmViewDesc.node && window.__writingCode.isConnected && window.__writingMath.isConnected), true)
  assert.equal(await model(), initialModel); assert.equal(await save(), original)
  checks.push('live preferences preserve ProseMirror, code/math DOM, document bytes and clean state')
  console.log('Existing code/math views update wrap, line numbers and tab width immediately, without replacing the document or changing old code languages.')

  let target = await addVisualParagraph()
  await page.keyboard.type('"Hello" -- ... don\'t', { delay: 40 })
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].at(-1)?.textContent === '“Hello” — … don’t')
  const typed = await save(); assert.ok(typed.includes('“Hello” — … don’t')); assert.ok(typed.includes('Existing "quotes" -- ... stay unchanged.'))
  target = await addVisualParagraph(); const beforePaste = await save()
  await paste('"paste" -- ...'); await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].at(-1)?.textContent === '"paste" -- ...')
  const pasted = await save()
  await command('undo-document'); await page.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent?.includes('"paste" -- ...')); assert.equal(await save(), beforePaste)
  await command('redo-document'); await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('"paste" -- ...')); assert.equal(await save(), pasted)
  target = await addVisualParagraph(); await composition(target, '"ime" -- ...')
  await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror > p')].at(-1)?.textContent === '"ime" -- ...')
  checks.push('visual fresh smart punctuation, unconverted paste/composition and exact undo/redo')

  const code = page.locator('.ttypora-code-block .cm-content').first()
  await code.click(); await page.keyboard.press('End'); await page.keyboard.type(' "new" -- ...', { delay: 35 })
  assert.ok((await code.evaluate((element) => element.cmTile.root.view.state.doc.toString())).endsWith(' "new" -- ...'))
  const yaml = page.locator('.front-matter-source')
  await yaml.click(); await page.keyboard.press('End'); await page.keyboard.type(' -- ...', { delay: 35 })
  assert.ok((await yaml.innerText()).includes('"existing" -- ...'))
  const html = page.locator('[data-html-source-editor]')
  await html.click(); await page.keyboard.press('End'); await page.keyboard.type(' -- ...', { delay: 35 })
  assert.ok((await html.inputValue()).endsWith(' -- ...'))
  const formula = page.locator('.ttypora-math-block .cm-content').first()
  await formula.click(); await page.keyboard.press('End'); await page.keyboard.type(' -- ...', { delay: 35 })
  assert.ok((await formula.evaluate((element) => element.cmTile.root.view.state.doc.toString())).endsWith(' -- ...'))
  checks.push('code, YAML, raw HTML and formula keyboard input keep literal punctuation')

  await save(); await changePreferences({ smartPunctuation: false, autoPair: true, codeWrap: false, codeLineNumbers: true })
  await page.waitForFunction(() => [...document.querySelectorAll('.ttypora-code-block .cm-content, .ttypora-math-block .cm-content')].every((content) => !content.classList.contains('cm-lineWrapping') && [...content.closest('.cm-editor').querySelectorAll('.cm-lineNumbers')].some((gutter) => getComputedStyle(gutter).display !== 'none')))
  target = await addVisualParagraph(); await page.keyboard.type('('); assert.equal(await target.innerText(), '()')
  await page.keyboard.type(')'); assert.equal(await target.innerText(), '()')
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Backspace')
  await page.waitForFunction(() => {
    const node = [...document.querySelectorAll('.ProseMirror > p')].at(-1)?.pmViewDesc?.node
    return node?.type.name === 'paragraph' && node.childCount === 0
  })
  assert.equal(await target.textContent(), '')
  await page.keyboard.insertText('label'); await selectWord(target, 'label'); await page.keyboard.type('[')
  assert.equal(await target.innerText(), '[label]'); assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'label')
  target = await addVisualParagraph(); await page.keyboard.insertText('inline'); await selectWord(target, 'inline'); await page.keyboard.type('`')
  await target.locator('code').waitFor(); assert.equal(await target.locator('code').innerText(), 'inline')
  target = await addVisualParagraph(); await page.keyboard.type('`abc`', { delay: 40 }); await target.locator('code').waitFor(); assert.equal(await target.locator('code').innerText(), 'abc')
  await changePreferences({ autoPair: false, autoLink: false })
  target = await addVisualParagraph(); await page.keyboard.type('"raw" -- ... (', { delay: 35 }); assert.equal(await target.innerText(), '"raw" -- ... (')
  await page.keyboard.type(' https://example.com/off ', { delay: 25 }); assert.equal(await target.locator('a').count(), 0)
  checks.push('visual pair wrap/skip/delete, semantic inline code, and disabled input switches')

  await changePreferences({ autoLink: true })
  target = await addVisualParagraph(); await page.keyboard.type('https://example.com/a_(b). ', { delay: 25 })
  await target.locator('a').waitFor(); assert.equal(await target.locator('a').getAttribute('href'), 'https://example.com/a_(b)')
  target = await addVisualParagraph(); await page.keyboard.insertText('keep-label'); await selectWord(target, 'keep-label'); await paste('https://example.com/selected')
  await target.locator('a').waitFor(); assert.equal(await target.locator('a').innerText(), 'keep-label'); assert.equal(await target.locator('a').getAttribute('href'), 'https://example.com/selected')
  target = await addVisualParagraph(); await paste('https://example.com/paste'); await target.locator('a').waitFor()
  checks.push('visual typed URL punctuation boundaries and direct/selected URL clipboard paste')

  await changePreferences({ autoPair: true })
  target = await addVisualParagraph(); await page.keyboard.type('```', { delay: 40 }); await page.keyboard.press('Enter')
  await page.waitForFunction(() => { const nodes = []; document.querySelector('.ProseMirror').pmViewDesc.node.descendants((node) => { if (node.type.name === 'code_block') nodes.push(node.attrs.language) }); return nodes.length === 2 && nodes[0] === '' && nodes[1] === 'python' })
  await page.locator('.ttypora-code-block .cm-content').last().waitFor(); await page.keyboard.insertText('print(1)')
  await page.keyboard.press('Control+Enter')
  checks.push('visual newly typed fence uses default language, existing unlabelled code remains unlabelled')

  await save(); await command('toggle-source-mode'); await ready(); await source().waitFor()
  await changePreferences({ smartPunctuation: true, autoPair: false })
  await source().click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n\n')
  await page.keyboard.type('"Source" -- ... don\'t', { delay: 35 })
  assert.ok((await sourceText()).endsWith('“Source” — … don’t'))
  await page.evaluate(() => { window.__writingSource = document.querySelector('.source-editor .cm-content'); window.__writingSourceDoc = window.__writingSource.cmTile.root.view.state.doc })
  const beforeSettings = await save()
  await changePreferences({ autoPair: true, smartPunctuation: false })
  assert.equal(await page.evaluate(() => document.querySelector('.source-editor .cm-content') === window.__writingSource && window.__writingSource.cmTile.root.view.state.doc === window.__writingSourceDoc), true)
  assert.equal(await save(), beforeSettings)
  await source().click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter')
  await page.keyboard.type('('); assert.ok((await sourceText()).endsWith('()'))
  await page.keyboard.type(')'); assert.ok((await sourceText()).endsWith('()'))
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Backspace'); assert.ok(!(await sourceText()).endsWith('()'))
  await page.keyboard.insertText('source-label'); await selectWord(source(), 'source-label'); await page.keyboard.type('"')
  assert.ok((await sourceText()).endsWith('"source-label"')); assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'source-label')
  await source().click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('selected-source')
  await selectWord(source(), 'selected-source'); await paste('https://example.com/source')
  assert.ok((await sourceText()).endsWith('[selected-source](<https://example.com/source>)'))
  await page.keyboard.press('Enter'); await page.keyboard.type('https://example.com/typed ', { delay: 25 })
  assert.ok((await sourceText()).endsWith('[https://example.com/typed](<https://example.com/typed>) '))
  const sourceLinked = await save()
  await page.keyboard.press('Enter'); const beforeSourcePaste = await save(); await paste('"paste-source" -- ...')
  assert.ok((await sourceText()).endsWith('"paste-source" -- ...'))
  const sourcePasted = await save(); await command('undo-document'); await page.waitForFunction(() => !document.querySelector('.source-editor .cm-content').cmTile.root.view.state.doc.toString().includes('"paste-source"')); assert.equal(await save(), beforeSourcePaste)
  await command('redo-document'); await page.waitForFunction(() => document.querySelector('.source-editor .cm-content').cmTile.root.view.state.doc.toString().includes('"paste-source"')); assert.equal(await save(), sourcePasted)
  assert.ok(sourceLinked.includes('selected-source'))
  await changePreferences({ smartPunctuation: true, autoPair: false })
  await source().click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await composition(source(), '"source-ime" -- ...')
  assert.ok((await sourceText()).endsWith('"source-ime" -- ...'))
  await page.keyboard.press('Enter'); await page.keyboard.type('```', { delay: 35 }); await page.keyboard.press('Enter')
  assert.ok((await sourceText()).endsWith('```python\n'))
  await page.keyboard.type('"code" -- ...', { delay: 35 }); assert.ok((await sourceText()).endsWith('```python\n"code" -- ...'))
  await page.keyboard.press('Enter'); await page.keyboard.type('```', { delay: 35 }); await page.keyboard.press('Enter')
  await changePreferences({ autoLink: false, smartPunctuation: false })
  await source().click(); await page.keyboard.press('Control+End'); await paste('https://example.com/off-source')
  assert.ok((await sourceText()).endsWith('https://example.com/off-source'))
  checks.push('source typed punctuation, pair handling, direct/selected links, composition, literal fence and preference DOM/history preservation')

  await save(); await command('toggle-source-mode'); await ready()
  const codeState = await cmStatus()
  assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: path.join(artifacts, `writing-aids-${prefix}.png`) })
  await writeFile(path.join(artifacts, `writing-aids-${prefix}.json`), JSON.stringify({ mode: packaged ? 'packaged' : 'source', checks, codeState, pageErrors, completedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(`Writing aids desktop verification passed (${checks.length} groups): real keyboard, clipboard, simulated composition events, persistent live preferences and shared undo.`)
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.locator('body').innerText().catch(() => 'unavailable'))
    console.error(await page.evaluate(() => ({ preferences: localStorage.getItem('ttypora.preferences'), source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString(), prose: document.querySelector('.ProseMirror')?.pmViewDesc?.node.toJSON() })).catch(() => 'unavailable'))
    await page.screenshot({ path: path.join(artifacts, `writing-aids-${prefix}-failure.png`) }).catch(() => undefined)
  }
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (application) await application.close().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
