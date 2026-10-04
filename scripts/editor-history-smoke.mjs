import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-history-'))
const workspace = path.join(temporary, 'notes')
await mkdir(workspace)
const original = '# 位置测试\n\nAlpha **bold** and [link](b.md).\n\n- first\n- second 中文🙂\n\n| A | B |\n|---|---|\n| C | D |\n'
const a = path.join(workspace, 'a.md'), b = path.join(workspace, 'b.md'), c = path.join(workspace, 'embedded.md')
await writeFile(a, original); await writeFile(b, '# Other\n\nIndependent\n')
await writeFile(c, '---\ntitle: Test\n---\n\n# Embedded editors\n\n```js\nconst value = 42\n```\n\n<div>HTML sample</div>\n')
let app, page
const errors = []
try {
  const packaged = process.env.TTYPORA_PACKAGED_EXE
  app = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: packaged ? ['--disable-gpu'] : ['--disable-gpu', '.'], cwd: root, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version)
  page = await app.firstWindow(); page.on('pageerror', (error) => { errors.push(String(error)); console.error(error.stack) })
  const command = (value) => app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', command), value)
  const ready = async () => { await page.locator('.editor-loading').waitFor({ state: 'detached' }); await page.locator('.ProseMirror, .source-editor .cm-content').waitFor() }
  const source = () => page.locator('.source-editor .cm-content')
  const visual = () => page.locator('.ProseMirror')
  const open = async (name) => { await page.locator('.file-tree .tree-entry--file').filter({ hasText: name }).click(); await page.waitForFunction((name) => document.title.includes(name), name); await ready() }
  const selected = () => page.evaluate(() => window.getSelection()?.toString())
  const save = async () => { await command('save-document'); await page.waitForFunction(() => !document.title.startsWith('●')) }
  await ready(); await command('toggle-formatting-toolbar'); await page.locator('.editor-toolbar').waitFor()
  await command('open-workspace'); await open('a.md')

  // ProseMirror consumes the actual DOM selection before the mode switch captures it.
  for (const [selector, text] of [['.ProseMirror h1', '位置'], ['.ProseMirror strong', 'bold'], ['.ProseMirror li:last-of-type p', '中文🙂'], ['.ProseMirror tbody tr:last-child td:last-child', 'D']]) {
    console.log('Mapping selection:', text)
    const target = page.locator(selector).last()
    if (text === 'bold') {
      await target.dblclick()
      if ((await selected()) === 'bold ') await page.keyboard.press('Shift+ArrowLeft')
    }
    else {
      await target.click()
      if (text === '中文🙂') { await page.keyboard.press('End'); for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowLeft') }
      else { await page.keyboard.press('Home'); for (let index = 0; index < text.length; index++) await page.keyboard.press('Shift+ArrowRight') }
    }
    console.log('DOM selection:', await selected())
    await page.waitForFunction((text) => window.getSelection()?.toString() === text, text)
    if (text === 'bold') { await page.keyboard.press('ArrowRight'); for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowLeft') }
    await command('toggle-source-mode'); await source().waitFor(); await ready()
    assert.equal(await selected(), text)
    await command('toggle-source-mode'); await visual().waitFor(); await ready()
    assert.equal(await selected(), text)
  }
  console.log('Selections round-trip across visual/source headings, marked text, Unicode lists and table cells.')

  await command('toggle-source-mode'); await source().waitFor()
  await source().click(); await source().press('Control+End')
  await page.keyboard.insertText('\nSOURCE STEP\n')
  await command('toggle-source-mode'); await visual().waitFor(); await ready()
  await visual().locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.insertText(' VISUAL STEP')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent?.includes('VISUAL STEP'))
  assert.match(await visual().innerText(), /SOURCE STEP/)
  await visual().click(); await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent?.includes('SOURCE STEP'))
  await save(); assert.equal(await readFile(a, 'utf8'), original)
  await page.keyboard.press('Control+y')
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('SOURCE STEP'))
  await command('toggle-source-mode'); await source().waitFor()
  await page.keyboard.press('Control+Shift+z')
  await page.waitForFunction(() => document.querySelector('.source-editor')?.textContent?.includes('VISUAL STEP'))
  console.log('Native shortcuts and toolbar share one undo/redo timeline across modes; undo returns exact original Markdown.')

  await source().click(); await source().press('Control+End'); await page.keyboard.insertText('\nA ONLY\n')
  await open('b.md')
  await source().click(); await source().press('Control+End'); await page.keyboard.insertText('\nB ONLY\n')
  await page.getByRole('tablist', { name: '打开的文档' }).getByRole('tab', { name: 'a.md' }).click(); await ready()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !document.querySelector('.source-editor')?.textContent?.includes('A ONLY'))
  assert.match(await source().innerText(), /VISUAL STEP/)
  await page.getByRole('tablist', { name: '打开的文档' }).getByRole('tab', { name: 'b.md' }).click(); await ready()
  assert.match(await source().innerText(), /B ONLY/)
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !document.querySelector('.source-editor')?.textContent?.includes('B ONLY'))
  console.log('Each tab retains independent undo/redo and source selections.')

  await source().click(); await source().press('Control+End')
  await source().pressSequentially('abc', { delay: 30 })
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !document.querySelector('.source-editor')?.textContent?.includes('abc'))
  await page.keyboard.press('Control+y')
  await page.waitForFunction(() => document.querySelector('.source-editor')?.textContent?.includes('abc'))
  await page.keyboard.press('Control+z'); await page.keyboard.insertText('branch')
  assert.equal(await page.getByRole('button', { name: '重做', exact: true }).isEnabled(), false)
  console.log('Continuous typing groups into one step and a new edit clears the redo branch.')

  await save()
  await writeFile(b, '# External version\n')
  await page.waitForFunction(() => document.querySelector('.source-editor')?.textContent?.includes('External version'))
  assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).isEnabled(), false)
  await command('preferences')
  await page.getByLabel('页眉', { exact: true }).fill('Settings edit')
  await page.getByLabel('页眉', { exact: true }).press('End')
  await page.keyboard.insertText(' addition')
  await page.getByLabel('页眉', { exact: true }).press('Control+z')
  assert.equal(await page.getByLabel('页眉', { exact: true }).inputValue(), 'Settings edit')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  assert.match(await source().innerText(), /External version/)
  console.log('External reload resets history and settings input undo stays outside document history.')

  await open('embedded.md'); await command('toggle-source-mode'); await visual().waitFor(); await ready()
  await page.locator('.front-matter-source').click(); await page.keyboard.press('Home')
  for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowRight')
  await command('toggle-source-mode'); await source().waitFor(); await ready(); assert.equal(await selected(), 'title')
  await command('toggle-source-mode'); await visual().waitFor(); await ready(); assert.equal(await selected(), 'title')
  await page.locator('.milkdown-code-block').click()
  const embedded = page.locator('.milkdown-code-block .cm-content')
  await embedded.waitFor(); await embedded.click(); await page.keyboard.press('Home')
  for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowRight')
  assert.equal(await selected(), 'const')
  await command('toggle-source-mode'); await source().waitFor(); await ready(); assert.equal(await selected(), 'const')
  await command('toggle-source-mode'); await visual().waitFor(); await ready(); assert.equal(await selected(), 'const')
  await embedded.press('End'); await page.keyboard.insertText(' CODE CHANGE')
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !document.querySelector('.milkdown-code-block')?.textContent?.includes('CODE CHANGE'))
  const html = page.getByLabel('HTML 源码', { exact: true })
  await html.click(); await html.press('Home')
  for (let index = 0; index < 10; index++) await page.keyboard.press('ArrowRight')
  for (let index = 0; index < 6; index++) await page.keyboard.press('Shift+ArrowRight')
  await command('toggle-source-mode'); await source().waitFor(); await ready(); assert.equal(await selected(), 'sample')
  await command('toggle-source-mode'); await visual().waitFor(); await ready()
  assert.equal(await html.evaluate((input) => input.value.slice(input.selectionStart, input.selectionEnd)), 'sample')
  await html.press('End'); await page.keyboard.insertText(' HTML CHANGE'); await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="HTML 源码"]')?.value?.includes('HTML CHANGE'))
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="HTML 源码"]')?.value?.includes('HTML CHANGE'))
  assert.equal(await html.evaluate((input) => input.selectionStart), (await html.inputValue()).length)
  assert.deepEqual(errors, [])
  console.log('YAML, embedded code and HTML editors preserve selections and use document undo.')
  await page.screenshot({ path: path.join(root, 'artifacts/editor-history.png') })
  console.log('Editor history acceptance passed.')
} catch (error) {
  if (page && !page.isClosed()) { console.error(await page.locator('body').innerText().catch(() => 'unavailable')); await page.screenshot({ path: path.join(root, 'artifacts/history-failure.png') }).catch(() => undefined) }
  throw error
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttypora.confirmWindowClose()).catch(() => undefined)
  if (app) await app.close().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
