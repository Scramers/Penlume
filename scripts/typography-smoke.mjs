import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

// Run after a build. All preferences are changed through the public UI;
// evaluations only inspect rendered DOM, styles and persisted preferences.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const artifacts = path.resolve(root, process.env.TTYPORA_UI_ARTIFACTS ?? 'artifacts/ui-v0.12.1')
const variant = process.env.TTYPORA_PACKAGED_EXE ? 'packaged' : 'source'
const temporary = await mkdtemp(path.join(tmpdir(), 'penlume-typography-'))
const workspace = path.join(temporary, 'notes')
const note = path.join(workspace, '排版示例.md')
const original = Buffer.from(`# 一级标题：写作的节奏

第一段普通正文，检查字号与行高是否真实生效。文字应有清楚的段落间距，在窗口变窄时自然换行。

第二段普通正文，与上一段保持一致。设置中的标签、输入框和说明文字应有稳定的阅读大小。

## 二级标题：内容结构

### 三级标题：组织层次

#### 四级标题：细节说明

##### 五级标题：辅助信息

###### 六级标题：末级说明

- 第一项
  - 嵌套第一项
  - 嵌套第二项
- 第二项

> 引用中的文字保持自己的留白。
>
> - 引用列表一
> - 引用列表二

| 名称 | 用途 |
| --- | --- |
| 字号 | 正文文字大小 |
| 行高 | 相邻两行之间的距离 |

\`\`\`javascript
const message = 'Code spacing stays readable';
console.log(message);
\`\`\`
`, 'utf8')

let app, page
const errors = [], checks = [], measurements = []
const screenshots = []
const closeEnough = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.08, `${message}: expected ${expected}, got ${actual}`)
const decreasing = (headings, scope) => {
  assert.equal(headings.length, 6, `${scope} renders all six heading levels`)
  headings.forEach((heading, index) => {
    assert.equal(heading.tag, `H${index + 1}`)
    if (index) assert.ok(headings[index - 1].fontSize > heading.fontSize, `${scope}: H${index} must be larger than H${index + 1}`)
  })
}

try {
  await mkdir(workspace)
  await mkdir(artifacts, { recursive: true })
  await writeFile(note, original)
  const flags = ['--disable-gpu', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  app = await electron.launch({
    ...(process.env.TTYPORA_PACKAGED_EXE ? { executablePath: path.resolve(root, process.env.TTYPORA_PACKAGED_EXE) } : {}),
    args: process.env.TTYPORA_PACKAGED_EXE ? flags : [...flags, '.'], cwd: root,
    env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace },
  })
  page = await app.firstWindow({ timeout: 15000 })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const command = (value) => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, dimensions) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(...dimensions); win.show(); win.focus()
    }, [width, height])
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const capture = async (name) => {
    const output = path.join(artifacts, `${variant}-${name}.png`)
    // Chromium screenshots can be cropped at a non-default Electron zoom.
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    await writeFile(output, Buffer.from(png, 'base64')); screenshots.push(output)
  }
  const preferences = async (english = false) => {
    await command('preferences')
    const dialog = page.getByRole('dialog', { name: english ? 'Preferences' : '偏好设置', exact: true })
    await dialog.waitFor(); return dialog
  }
  const setNumber = async (dialog, label, value, commit = 'Enter') => {
    const input = dialog.getByLabel(label, { exact: true })
    await input.fill(String(value)); await input.press(commit)
    const preferenceKey = { '字号': 'fontSize', '行高': 'lineHeight', '正文宽度': 'contentWidth', '界面缩放（%）': 'interfaceZoom' }[label]
    assert.ok(preferenceKey, `Unknown preference label: ${label}`)
    await page.waitForFunction(({ key, value }) => JSON.parse(localStorage.getItem('ttypora.preferences'))?.[key] === value, { key: preferenceKey, value })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const closePreferences = async (dialog, english = false) => {
    await dialog.getByRole('button', { name: english ? 'Done' : '完成', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
  }
  const settingsStyles = async (dialog) => dialog.locator('.preferences').evaluate((container) => {
    const font = (node) => parseFloat(getComputedStyle(node).fontSize)
    return {
      labels: Array.from(container.querySelectorAll('label')).map(font),
      controls: Array.from(container.querySelectorAll('input:not([type="checkbox"]), select, textarea')).map(font),
      legends: Array.from(container.querySelectorAll('legend')).map(font),
      help: Array.from(container.querySelectorAll('p')).map(font),
    }
  })
  const assertSettingsStyles = (styles) => {
    for (const [kind, expected] of Object.entries({ labels: 14, controls: 14, legends: 15, help: 13 })) {
      assert.ok(styles[kind].length > 0, `Settings ${kind} exist`)
      styles[kind].forEach((actual) => closeEnough(actual, expected, `Settings ${kind} size`))
    }
  }
  const assertDescriptions = async (dialog) => {
    const rows = await dialog.locator('.setting-row').evaluateAll((elements) => elements.map((row) => {
      const input = row.querySelector('input')
      const references = (input?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      const isDisplayed = (node) => !!node && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden'
      return {
        label: row.querySelector('label')?.textContent?.trim(),
        referenceCount: references.length,
        descriptions: references.map((id) => {
          const node = document.getElementById(id)
          return { text: node?.textContent?.trim() ?? '', displayed: isDisplayed(node), insideRow: !!node && row.contains(node) }
        }),
        unit: row.querySelector('.setting-unit')?.textContent?.trim(),
        unitDisplayed: isDisplayed(row.querySelector('.setting-unit')),
        range: row.querySelector('.setting-range')?.textContent?.trim(),
        rangeDisplayed: isDisplayed(row.querySelector('.setting-range')),
        minimum: input?.getAttribute('min'), maximum: input?.getAttribute('max'),
      }
    }))
    assert.ok(rows.length >= 3)
    for (const row of rows) {
      assert.equal(row.referenceCount, 2, `${row.label} references its explanation and range`)
      row.descriptions.forEach((description) => assert.ok(description.text && description.displayed && description.insideRow, `${row.label} has a displayed, associated description`))
      assert.ok(row.unit && row.unitDisplayed, `${row.label} has a displayed unit`)
      assert.ok(row.rangeDisplayed && row.range.includes(row.minimum) && row.range.includes(row.maximum), `${row.label} displays its valid range`)
    }
  }
  const footerInside = async (dialog) => {
    const geometry = await dialog.locator('.modal__footer').evaluate((footer) => {
      const box = footer.getBoundingClientRect()
      const body = footer.closest('.modal').querySelector('.modal__body')
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: innerWidth, height: innerHeight, bodyHeight: body.clientHeight, bodyScroll: body.scrollHeight }
    })
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height + .5 && geometry.left >= 0 && geometry.right <= geometry.width + .5, `Footer inside viewport: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.bodyHeight > 0)
    return geometry
  }
  const readProse = () => page.locator('.ProseMirror').evaluate((editor) => {
    const style = (element) => ({ tag: element.tagName, fontSize: parseFloat(getComputedStyle(element).fontSize), lineHeight: parseFloat(getComputedStyle(element).lineHeight), marginTop: parseFloat(getComputedStyle(element).marginTop) })
    return {
      headings: Array.from(editor.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(style),
      paragraphs: Array.from(editor.querySelectorAll('p')).filter((p) => /^(第一段普通正文|第二段普通正文)/.test(p.textContent)).map(style),
      nestedList: !!editor.querySelector('ul ul'), quote: !!editor.querySelector('blockquote'), table: !!editor.querySelector('table'),
      code: !!editor.querySelector('.milkdown-code-block, .ttypora-code-block, pre'),
      topLevel: Array.from(editor.children).map((element) => ({ tag: element.tagName, class: element.className })),
    }
  })

  await size(1180, 760)
  await page.locator('.ProseMirror').waitFor()
  await command('open-workspace')
  await page.locator('.file-tree').getByTitle(note, { exact: true }).click()
  await page.getByLabel('关闭侧栏', { exact: true }).click()
  await page.locator('.ProseMirror h6').waitFor()
  const baseline = await readProse()
  decreasing(baseline.headings, 'Visual editor')
  closeEnough(baseline.headings[0].marginTop, 0, 'First heading has no extra top margin before the document')
  measurements.push({ baseline })
  assert.equal(baseline.paragraphs.length, 2)
  assert.ok(baseline.nestedList && baseline.quote && baseline.table && baseline.code, 'Fixture includes rendered nested lists, quotes, tables and code')
  await capture('1180-typography-writing')
  let dialog = await preferences()
  assertSettingsStyles(await settingsStyles(dialog))
  await assertDescriptions(dialog); await footerInside(dialog)
  await capture('1180-typography-settings')
  checks.push('Settings use 14 px labels and controls, 15 px group headings and 13 px explanations; numbers show associated help, units and valid ranges')

  for (const [fontSize, lineHeight] of [[12, 1.2], [12, 2.5], [32, 1.2], [32, 2.5]]) {
    await setNumber(dialog, '字号', fontSize)
    await setNumber(dialog, '行高', lineHeight, 'Tab')
    const prose = await readProse()
    decreasing(prose.headings, `Visual editor at ${fontSize} px / ${lineHeight}`)
    closeEnough(prose.headings[0].marginTop, 0, 'First heading remains flush with document padding')
    assert.equal(prose.paragraphs.length, 2)
    prose.paragraphs.forEach((paragraph) => {
      closeEnough(paragraph.fontSize, fontSize, 'Ordinary paragraph font size')
      closeEnough(paragraph.lineHeight, fontSize * lineHeight, 'Ordinary paragraph line height')
    })
    assertSettingsStyles(await settingsStyles(dialog))
    measurements.push({ fontSize, lineHeight, visual: prose })
  }
  checks.push('Real visual-editor H1–H6 sizes strictly decrease; two ordinary paragraphs honor all 12/32 px × 1.2/2.5 line-height combinations without changing settings text size')

  await setNumber(dialog, '正文宽度', 600)
  await closePreferences(dialog)
  await command('toggle-split-mode')
  const previewBody = page.frameLocator('.live-preview iframe').locator('body')
  await page.frameLocator('.live-preview iframe').locator('h6').waitFor()
  await page.waitForFunction(() => document.querySelector('.live-preview .pane-header small')?.textContent === '已同步')
  const preview = await previewBody.evaluate((body) => {
    const style = (element) => ({ tag: element.tagName, fontSize: parseFloat(getComputedStyle(element).fontSize), lineHeight: parseFloat(getComputedStyle(element).lineHeight) })
    return {
      headings: Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(style),
      paragraphs: Array.from(body.querySelectorAll(':scope > p')).filter((p) => /^(第一段普通正文|第二段普通正文)/.test(p.textContent)).map(style),
      boxSizing: getComputedStyle(body).boxSizing,
      maximumWidth: parseFloat(getComputedStyle(body).maxWidth), width: body.getBoundingClientRect().width,
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      nestedList: !!body.querySelector('ul ul'), quote: !!body.querySelector('blockquote'), table: !!body.querySelector('table'), code: !!body.querySelector('pre, .code-export'),
    }
  })
  decreasing(preview.headings, 'Split preview')
  assert.equal(preview.paragraphs.length, 2)
  preview.paragraphs.forEach((paragraph) => {
    closeEnough(paragraph.fontSize, 32, 'Preview paragraph font size')
    closeEnough(paragraph.lineHeight, 80, 'Preview paragraph line height')
  })
  assert.equal(preview.boxSizing, 'border-box')
  closeEnough(preview.maximumWidth, 600, 'Preview document maximum width')
  assert.ok(preview.width <= 600 + .5 && preview.width <= preview.viewport + .5)
  assert.ok(preview.documentWidth <= preview.viewport, `Preview must not overflow horizontally: ${JSON.stringify(preview)}`)
  assert.ok(preview.nestedList && preview.quote && preview.table && preview.code)
  measurements.push({ preview })
  checks.push('Split preview preserves heading order and paragraph sizing, contains nested content, and fits a 600 px border-box maximum without horizontal overflow')
  await page.getByRole('button', { name: '所见即所得', exact: true }).click()
  await page.locator('.ProseMirror h6').waitFor()

  dialog = await preferences()
  await dialog.getByLabel('界面语言', { exact: true }).selectOption('en')
  dialog = page.getByRole('dialog', { name: 'Preferences', exact: true }); await dialog.waitFor()
  await page.waitForFunction(() => document.documentElement.lang === 'en')
  const englishExplanations = await dialog.locator('p, legend, label, .setting-range').evaluateAll((elements) => elements.map((element) => {
    // The language selector intentionally keeps native language names.
    const copy = element.cloneNode(true)
    copy.querySelectorAll('select, input, textarea').forEach((control) => control.remove())
    return copy.textContent ?? ''
  }))
  assert.ok(englishExplanations.length > 0)
  assert.equal(englishExplanations.some((text) => /[\u3400-\u9fff]/.test(text)), false, 'English settings explanations and labels must not fall back to Chinese')
  assertSettingsStyles(await settingsStyles(dialog)); await assertDescriptions(dialog)
  await capture('1180-typography-settings-en')
  await dialog.getByLabel('Interface language', { exact: true }).selectOption('zh-CN')
  dialog = page.getByRole('dialog', { name: '偏好设置', exact: true }); await dialog.waitFor()
  await closePreferences(dialog)
  checks.push('English preferences retain readable fixed text sizes and translated explanations, with no Chinese fallback; Chinese can be restored live')

  await size(640, 420)
  await command('layout-settings')
  dialog = page.getByRole('dialog', { name: '布局与尺寸', exact: true }); await dialog.waitFor()
  await setNumber(dialog, '界面缩放（%）', 150)
  await page.waitForFunction(() => innerWidth < 440)
  const smallLayout = await footerInside(dialog)
  assert.ok(smallLayout.bodyScroll > smallLayout.bodyHeight, 'Short layout panel scrolls its body while preserving its footer')
  assertSettingsStyles(await settingsStyles(dialog)); await assertDescriptions(dialog)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await capture('640-typography-layout-150')
  await closePreferences(dialog)
  dialog = await preferences()
  await footerInside(dialog); assertSettingsStyles(await settingsStyles(dialog))
  await closePreferences(dialog)
  checks.push('At a 640 × 420 window and 150% interface zoom, layout and preferences keep their footer inside the viewport, scroll independently, and their Done button remains clickable')
  await command('interface-zoom-reset')
  await page.waitForFunction(() => innerWidth > 600)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1)
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  assert.deepEqual(await readFile(note), original, 'Changing typography and UI language must preserve the original document bytes')
  assert.deepEqual(errors, [], 'No renderer page errors')
  checks.push('The original Markdown bytes are unchanged; no page errors; final locale is Chinese and interface zoom is reset')
  console.log(checks.join('\n'))
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.evaluate(() => ({
      inner: [innerWidth, innerHeight],
      modal: document.querySelector('.modal')?.getBoundingClientRect().toJSON(),
      footer: document.querySelector('.modal__footer')?.getBoundingClientRect().toJSON(),
      preferences: localStorage.getItem('ttypora.preferences'),
    })).catch(() => null))
    const failureCapture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')).catch(() => null)
    if (failureCapture) await writeFile(path.join(artifacts, `${variant}-typography-failure.png`), Buffer.from(failureCapture, 'base64'))
  }
  throw error
} finally {
  try { if (app) await app.close() } finally {
    const resolved = path.resolve(temporary)
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()))
    assert.ok(path.basename(resolved).startsWith('penlume-typography-'))
    await rm(resolved, { recursive: true, force: true })
  }
}

// No success report is emitted until application shutdown and fixture cleanup pass.
assert.deepEqual(errors, [], 'No renderer errors during shutdown')
await writeFile(path.join(artifacts, `${variant}-typography-verification.json`), JSON.stringify({ completedAt: new Date().toISOString(), variant, checks, measurements, screenshots, errors, cleanupCompleted: true }, null, 2))
