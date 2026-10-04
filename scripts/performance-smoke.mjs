import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { parsePreferences } from '../src/shared/preferences.ts'

// Independent, bounded baseline. Run against an existing build, never in parallel
// with another desktop suite. No product settings, build output or harness changes.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const packaged = process.env.TTYPORA_PACKAGED_EXE
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v${packageVersion}-${packaged ? 'packaged' : 'source'}`
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'), 'Invalid artifact prefix.')
const totalLimitMs = Number(process.env.TTYPORA_PERFORMANCE_TIMEOUT_MS ?? 300_000)
assert(Number.isInteger(totalLimitMs) && totalLimitMs >= 60_000 && totalLimitMs <= 600_000, 'Performance timeout must be between 60,000 and 600,000 ms.')
const artifacts = path.join(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
const reportPath = path.join(artifacts, `performance-${prefix}.json`)
const initialModelPath = path.join(artifacts, `performance-${prefix}-writing-model.json`)
const temporary = await mkdtemp(path.join(tmpdir(), 'ttypora-performance-'))
const workspace = path.join(temporary, 'notes')
await mkdir(workspace)
const goldenPath = path.join(temporary, 'original-unopened.md')
const visualPath = path.join(workspace, 'large-writing.md')
const sourcePath = path.join(workspace, 'large-source.md')
const tailMarker = 'PERFORMANCE FINAL PARAGRAPH'
const targetCharacters = 1_000_000
const digest = (value) => createHash('sha256').update(value).digest('hex')
const round = (value) => Math.round(value * 1000) / 1000

function fixture() {
  let markdown = '# Large document performance fixture\n\n', sections = 0
  const paragraph = '中文正文用于观察长文编辑响应。The baseline mixes Chinese and English prose without external resources. '.repeat(17)
  while (true) {
    const index = sections + 1
    const section = `## Section ${index}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n| 项目 | Value |\n| --- | --- |\n| Row ${index} | 中文表格 |\n| Detail | preserved content |\n\n\`\`\`javascript\nconst section${index} = ${index};\n// Literal code and Chinese 注释 stay intact.\nconsole.log(section${index});\n\`\`\`\n\n`
    if (markdown.length + section.length + tailMarker.length + 6 > targetCharacters) break
    markdown += section; sections++
  }
  const paddingSize = targetCharacters - markdown.length - tailMarker.length - 4
  markdown += '补充正文 baseline fill text。 '.repeat(Math.ceil(paddingSize / 24)).slice(0, paddingSize)
  markdown += `\n\n${tailMarker}\n\n`
  assert.equal(markdown.length, targetCharacters)
  return { markdown, sections }
}
const { markdown: original, sections } = fixture()
await writeFile(goldenPath, original)
await writeFile(visualPath, original)
await writeFile(sourcePath, original)
const parser = unified().use(remarkParse).use(remarkGfm)
function semanticHash(markdown) {
  // Visual Markdown may normalize whitespace. Compare parsed content, including
  // every paragraph/table/code block, without source offsets or line positions.
  return digest(JSON.stringify(parser.parse(markdown), (key, value) => key === 'position' ? undefined : value))
}
const startedAt = performance.now(), deadline = startedAt + totalLimitMs
const report = {
  schemaVersion: 2, status: 'running', startedAt: new Date().toISOString(), prefix,
  packageVersion, executable: packaged ? path.resolve(root, packaged) : 'existing dist via electron .',
  host: { platform: process.platform, architecture: process.arch, osRelease: release(), cpuModel: cpus()[0]?.model ?? null, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  fixture: { generator: 'mixed-markdown-v1', utf16Characters: original.length, utf8Bytes: Buffer.byteLength(original), sha256: digest(original), sections, headings: sections + 1, tables: sections, codeBlocks: sections, files: 2, unopenedOriginalCopy: goldenPath },
  limits: { totalMs: totalLimitMs, phaseMs: 90_000, inputSampleMs: 12_000, inputSamplesPerMode: 10, measuredOpenActions: 2, measuredModeSwitchActions: 2 },
  definitions: {
    openAndSwitchMs: 'Node monotonic clock: immediately before file-tree click or actual app:command dispatch until the requested document/mode model is ready, loading overlay is absent, and two animation frames have elapsed. Includes automation overhead; not application cold-start or complete syntax-highlighting time.',
    rendererKeydownToObservedModelMs: 'Renderer monotonic clock: capture of the actual printable keydown until a MutationObserver or animation-frame probe first sees its expected text in the ProseMirror document or CodeMirror state document. Observation latency is included; this is not an internal transaction timestamp or a paint latency.',
    rendererBeforeInputToObservedModelMs: 'Same observation endpoint, measured from the actual beforeinput event when available. Null means that event was not emitted; it is not replaced with a DOM-read timing.',
    keyboardRoundTripMs: 'Node monotonic clock: immediately before real Playwright keyboard.type of one character until the renderer model probe is reported. Includes keyboard dispatch, transport and polling.',
    memory: 'Main process.memoryUsage values and optional Chromium performance.memory heap estimates are bytes. Electron app.getAppMetrics process memory values are kilobytes, per https://www.electronjs.org/docs/latest/api/structures/memory-info. No forced GC; snapshots are not peak sampling or leak tests.',
    preferences: 'Effective preferences resolve the captured localStorage input through the same shared parsePreferences schema used by App, including defaults and invalid-value fallback. Raw storage is recorded separately. Each memory snapshot also reads actual CodeMirror state.tabSize, view.lineWrapping and visible number gutters; auxiliary preference booleans are not presented as a separate behavior benchmark.',
    completeWritingModel: 'After the first writing open timer ends, save the entire ProseMirror doc.toJSON and its SHA-256. After the source-to-writing timer ends, compare the entire actual model with that baseline plus exactly one paragraph containing the ten source keyboard characters. This verification reads the actual model and does not use adapter getMarkdown or its original-source fallback.',
    deadline: 'The total deadline bounds awaited phase waits after fixture setup. Promise.race does not cancel in-flight actions; synchronous JavaScript, report persistence, fixture setup and shutdown/cleanup can exceed it. This is not a hard whole-process runtime limit.',
    scope: 'One ordered run on one machine, one already launched app, two freshly written local copies (OS cache may be warm), ten printable single-character inputs in each mode. No Typora comparison, performance threshold, percentile population claim or general performance pass conclusion.'
  },
  phases: [], timings: {}, inputSamples: { visual: [], source: [] }, memorySnapshots: [], pageErrors: [], diagnostics: [], correctness: {}
}
let application, page, initialWritingModel, failed = false
const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
await persist()
const timeLeft = () => deadline - performance.now()
async function bounded(label, action, limitMs) {
  const allowed = Math.min(limitMs, timeLeft())
  if (allowed <= 0) throw new Error(`Total performance deadline reached before ${label}; collected measurements are in ${reportPath}.`)
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.ceil(allowed)} ms; collected measurements are in ${reportPath}.`)), allowed) })
    ])
  } finally { clearTimeout(timer) }
}
async function phase(label, action, limitMs = 90_000) {
  const item = { label, status: 'running', startedAfterMs: round(performance.now() - startedAt) }
  report.phases.push(item); await persist()
  const start = performance.now()
  console.log(`Performance phase: ${label}`)
  try { const value = await bounded(label, action, limitMs); item.status = 'completed'; return value }
  catch (error) { item.status = 'failed'; item.error = String(error); throw error }
  finally { item.durationMs = round(performance.now() - start); await persist() }
}
const twoFrames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const command = (value) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', value), value)
const writingModel = () => page.evaluate(() => {
  const doc = document.querySelector('.ProseMirror')?.pmViewDesc?.node
  if (!doc || doc.type.name !== 'doc') throw new Error('A complete ProseMirror document model is unavailable.')
  return doc.toJSON()
})
async function ready(mode, filePath, ending, sourceLength) {
  await page.waitForFunction(({ mode, name, ending, sourceLength }) => {
    if (document.querySelector('.editor-loading') || name && !document.title.includes(name)) return false
    if (mode === 'source') {
      const content = document.querySelector('.source-editor .cm-content'), doc = content?.cmTile?.root?.view?.state?.doc
      return Boolean(doc && (sourceLength === null || doc.length === sourceLength) && doc.sliceString(Math.max(0, doc.length - ending.length)) === ending)
    }
    const doc = document.querySelector('.ProseMirror')?.pmViewDesc?.node
    return Boolean(doc && doc.lastChild?.textContent === ending)
  }, { mode, name: filePath ? path.basename(filePath) : null, ending, sourceLength: sourceLength ?? null }, { timeout: 90_000, polling: 'raf' })
  await twoFrames()
}
async function memorySnapshot(label) {
  const system = await application.evaluate(({ app, BrowserWindow }) => {
    const rendererPid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
    const metrics = app.getAppMetrics()
    return { mainPid: process.pid, rendererPid, mainNodeMemoryBytes: process.memoryUsage(), mainProcessMetricsKilobytes: metrics.find((metric) => metric.pid === process.pid) ?? null, rendererProcessMetricsKilobytes: metrics.find((metric) => metric.pid === rendererPid) ?? null, versions: process.versions, appVersion: app.getVersion() }
  })
  const renderer = await page.evaluate(() => {
    const memory = performance.memory
    const codeMirrorViews = [...document.querySelectorAll('.source-editor .cm-content, .ttypora-code-block .cm-content, .ttypora-math-block .cm-content')].map((content, index) => {
      const view = content.cmTile?.root?.view
      if (!view) throw new Error(`CodeMirror view ${index} is unavailable during the configuration snapshot.`)
      const gutters = [...content.closest('.cm-editor').querySelectorAll('.cm-lineNumbers')]
      return { index, kind: content.closest('.source-editor') ? 'source' : content.closest('.ttypora-math-block') ? 'math' : 'code', docUtf16Characters: view.state.doc.length, tabSize: view.state.tabSize, lineWrapping: view.lineWrapping, contentWrappingClass: content.classList.contains('cm-lineWrapping'), numberGuttersPresent: gutters.length, numberGuttersVisible: gutters.filter((gutter) => getComputedStyle(gutter).display !== 'none').length }
    })
    return { chromiumHeapEstimateBytes: memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null, proseMirrorPresent: Boolean(document.querySelector('.ProseMirror')), sourcePresent: Boolean(document.querySelector('.source-editor .cm-content')), embeddedCodeEditors: document.querySelectorAll('.ttypora-code-block .cm-content').length, codeMirrorViews }
  })
  report.memorySnapshots.push({ label, collectedAfterMs: round(performance.now() - startedAt), ...system, renderer }); await persist()
}
async function sampleInput(mode, character, expected, sourceLength) {
  await page.evaluate(({ mode, character, expected, sourceLength }) => {
    window.__performanceInputCleanup?.()
    const element = document.querySelector(mode === 'visual' ? '.ProseMirror' : '.source-editor .cm-content')
    if (!element) throw new Error('Input target is absent.')
    const probe = { mode, character, keydownAt: null, beforeInputAt: null, observedAt: null, keydownCount: 0, beforeInputCount: 0, matched: false }
    window.__performanceInput = probe
    const keydown = (event) => { if (event.key === character) { probe.keydownCount++; probe.keydownAt ??= performance.now() } }
    const beforeInput = (event) => { if (event.data === character) { probe.beforeInputCount++; probe.beforeInputAt ??= performance.now() } }
    let frame, alive = true
    const check = () => {
      if (!alive || probe.matched || probe.keydownAt === null) return
      const doc = mode === 'visual' ? element.pmViewDesc?.node : element.cmTile?.root?.view?.state?.doc
      const matches = mode === 'visual' ? doc?.lastChild?.textContent === expected : doc?.length === sourceLength && doc.sliceString(Math.max(0, doc.length - expected.length)) === expected
      if (matches) { probe.observedAt = performance.now(); probe.matched = true }
    }
    const observer = new MutationObserver(check)
    observer.observe(element, { subtree: true, childList: true, characterData: true })
    const tick = () => { check(); if (alive && !probe.matched) frame = requestAnimationFrame(tick) }
    frame = requestAnimationFrame(tick)
    element.addEventListener('keydown', keydown, true); element.addEventListener('beforeinput', beforeInput, true)
    window.__performanceInputCleanup = () => { alive = false; cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener('keydown', keydown, true); element.removeEventListener('beforeinput', beforeInput, true) }
  }, { mode, character, expected, sourceLength })
  const start = performance.now()
  // This is the only measured edit: a real keyboard event, never fill, evaluate,
  // synthetic InputEvent, textContent assignment or a direct state transaction.
  await page.keyboard.type(character)
  await page.waitForFunction(() => window.__performanceInput?.matched, null, { timeout: 12_000, polling: 'raf' })
  const elapsed = performance.now() - start
  const probe = await page.evaluate(() => { const probe = { ...window.__performanceInput }; window.__performanceInputCleanup(); return probe })
  assert.equal(probe.keydownCount, 1, 'Each sample must have one actual printable keydown.')
  assert.equal(probe.matched, true)
  const sample = { index: report.inputSamples[mode].length + 1, character, actualKeydownCount: probe.keydownCount, actualBeforeInputCount: probe.beforeInputCount, rendererKeydownToObservedModelMs: round(probe.observedAt - probe.keydownAt), rendererBeforeInputToObservedModelMs: probe.beforeInputAt === null ? null : round(probe.observedAt - probe.beforeInputAt), keyboardRoundTripMs: round(elapsed) }
  report.inputSamples[mode].push(sample); await persist()
  return sample
}
async function save(filePath) {
  await page.evaluate(() => {
    window.__performanceSaveReceived = false
    const remove = window.ttypora.onAppCommand((value) => { if (value === 'save-document') { window.__performanceSaveReceived = true; remove() } })
  })
  await command('save-document')
  await page.waitForFunction(() => window.__performanceSaveReceived && !document.title.startsWith('●') && /已保存：|Saved:|文档没有需要保存的修改|No document changes to save/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, { timeout: 30_000 })
  return readFile(filePath, 'utf8')
}
function inputSummary(samples) {
  const values = samples.map((sample) => sample.rendererKeydownToObservedModelMs).sort((a, b) => a - b)
  return values.length ? { sampleCount: values.length, minMs: values[0], medianMs: round((values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2), maxMs: values.at(-1) } : { sampleCount: 0 }
}

try {
  await phase('launch existing Electron build and open workspace', async () => {
    application = await electron.launch({ ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}), args: packaged ? ['--disable-gpu'] : ['--disable-gpu', '.'], cwd: root, timeout: 45_000, env: { ...process.env, TTYPORA_SMOKE_TEST: '1', TTYPORA_USER_DATA_PATH: temporary, TTYPORA_SMOKE_WORKSPACE_PATH: workspace } })
    page = await application.firstWindow()
    page.setDefaultTimeout(30_000)
    page.on('pageerror', (error) => { report.pageErrors.push({ time: new Date().toISOString(), message: String(error), stack: error.stack }); console.error(error.stack) })
    page.on('crash', () => { report.diagnostics.push('Renderer page crashed.'); console.error('Renderer page crashed.') })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.locator('.ProseMirror').waitFor()
    await page.locator('.editor-loading').waitFor({ state: 'detached' })
    await command('open-workspace'); await page.locator('.file-tree').getByTitle(visualPath, { exact: true }).waitFor()
    const rawStorage = await page.evaluate(() => localStorage.getItem('ttypora.preferences'))
    let storedPreferences, storageParseError = null
    try { storedPreferences = JSON.parse(rawStorage ?? '{}') }
    catch (error) { storedPreferences = {}; storageParseError = String(error) }
    report.preferenceEvidence = { rawStorage, parsedStorage: storedPreferences, storageParseError, resolver: 'src/shared/preferences.ts parsePreferences, as used by App preferences initialization' }
    report.effectivePreferences = parsePreferences(storedPreferences)
    await memorySnapshot('before large document open')
  }, 60_000)
  await phase('open large document directly in writing mode', async () => {
    const start = performance.now()
    await page.locator('.file-tree').getByTitle(visualPath, { exact: true }).click({ timeout: 90_000 })
    await ready('visual', visualPath, tailMarker)
    report.timings.openWritingMs = round(performance.now() - start)
    initialWritingModel = await writingModel()
    const initialModelJson = JSON.stringify(initialWritingModel)
    await writeFile(initialModelPath, initialModelJson)
    report.writingModelBaseline = { jsonPath: initialModelPath, sha256: digest(initialModelJson), jsonUtf16Characters: initialModelJson.length, topLevelNodes: initialWritingModel.content.length }
    assert.equal(await readFile(visualPath, 'utf8'), original, 'Opening must not rewrite the original file.')
    await memorySnapshot('writing open')
  })
  await phase('position real keyboard at writing paragraph end', async () => { await page.locator('.ProseMirror > p').last().click(); await page.keyboard.press('End') })
  const visualCharacters = 'abcdefghij'
  for (let index = 0; index < visualCharacters.length; index++) await phase(`writing keyboard sample ${index + 1}`, () => sampleInput('visual', visualCharacters[index], tailMarker + visualCharacters.slice(0, index + 1)), 12_000)
  const visualSaved = await phase('save writing input and verify complete Markdown content', async () => {
    const saved = await save(visualPath)
    const expected = original.replace(tailMarker, tailMarker + visualCharacters)
    assert.equal(semanticHash(saved), semanticHash(expected), 'Writing save changed content beyond the ten keyboard characters.')
    report.correctness.writingSaved = { typedCharacters: visualCharacters, completeMarkdownSemanticMatch: true, utf16Characters: saved.length, sha256: digest(saved) }
    await memorySnapshot('writing after ten inputs and save')
    return saved
  }, 45_000)
  await phase('switch large writing document to source mode', async () => {
    const start = performance.now(); await command('toggle-source-mode')
    await ready('source', visualPath, visualSaved.slice(-64), visualSaved.length)
    report.timings.writingToSourceMs = round(performance.now() - start)
    await memorySnapshot('writing to source switch')
  })
  await phase('close saved writing copy before independent source open', async () => {
    await command('close-document')
    await page.waitForFunction(() => !document.title.includes('large-writing.md') && Boolean(document.querySelector('.source-editor .cm-content')) && !document.querySelector('.editor-loading'))
    assert.equal(await readFile(sourcePath, 'utf8'), original)
  })
  await phase('open large document directly in source mode', async () => {
    const start = performance.now()
    await page.locator('.file-tree').getByTitle(sourcePath, { exact: true }).click({ timeout: 90_000 })
    await ready('source', sourcePath, original.slice(-64), original.length)
    report.timings.openSourceMs = round(performance.now() - start)
    assert.equal(await readFile(sourcePath, 'utf8'), original)
    await memorySnapshot('source open')
  })
  await phase('position real keyboard at source document end', async () => { await page.locator('.source-editor .cm-content').click(); await page.keyboard.press('Control+End') })
  const sourceCharacters = 'klmnopqrst'
  for (let index = 0; index < sourceCharacters.length; index++) {
    const suffix = sourceCharacters.slice(0, index + 1)
    await phase(`source keyboard sample ${index + 1}`, () => sampleInput('source', sourceCharacters[index], suffix, original.length + suffix.length), 12_000)
  }
  const sourceSaved = await phase('save source input and verify exact bytes', async () => {
    const saved = await save(sourcePath)
    assert.equal(saved, original + sourceCharacters, 'Source save must preserve every original character and append exactly the ten keyboard characters.')
    report.correctness.sourceSaved = { typedCharacters: sourceCharacters, exactOriginalPlusKeyboardCharacters: true, utf16Characters: saved.length, sha256: digest(saved) }
    await memorySnapshot('source after ten inputs and save')
    return saved
  }, 45_000)
  await phase('switch large source document to writing mode', async () => {
    const start = performance.now(); await command('toggle-source-mode')
    await ready('visual', sourcePath, sourceCharacters)
    report.timings.sourceToWritingMs = round(performance.now() - start)
    const paragraph = initialWritingModel.content.at(-1)
    assert.equal(paragraph.type, 'paragraph', 'Initial fixture must end in a plain paragraph.')
    assert.deepEqual(paragraph.content, [{ type: 'text', text: tailMarker }], 'Initial writing model must contain the intact tail marker.')
    const expectedModel = { ...initialWritingModel, content: [...initialWritingModel.content, { ...paragraph, content: [{ type: 'text', text: sourceCharacters }] }] }
    const actualModel = await writingModel(), expectedHash = digest(JSON.stringify(expectedModel)), actualHash = digest(JSON.stringify(actualModel))
    report.correctness.sourceToWritingCompleteModel = { expectedSha256: expectedHash, actualSha256: actualHash, expectedTopLevelNodes: expectedModel.content.length, actualTopLevelNodes: actualModel.content.length, appendedParagraphText: sourceCharacters, matches: actualHash === expectedHash }
    await persist()
    assert.equal(actualHash, expectedHash, 'Source-to-writing conversion changed the complete ProseMirror model beyond the expected new tail paragraph.')
    await memorySnapshot('source to writing switch')
    assert.equal(await save(sourcePath), sourceSaved, 'Switching views must not rewrite the saved source document.')
  })
  await phase('verify unopened original, persisted inputs and renderer errors', async () => {
    assert.equal(await readFile(goldenPath, 'utf8'), original, 'The unopened original copy must remain intact.')
    assert.equal(semanticHash(await readFile(visualPath, 'utf8')), semanticHash(original.replace(tailMarker, tailMarker + visualCharacters)))
    assert.equal(await readFile(sourcePath, 'utf8'), original + sourceCharacters)
    assert.equal(report.inputSamples.visual.length, 10); assert.equal(report.inputSamples.source.length, 10)
    assert.deepEqual(report.pageErrors, [], 'Renderer pageerror was observed.')
    assert.deepEqual(report.diagnostics, [], 'Renderer crash was observed.')
    report.correctness.unopenedOriginalPreserved = true; report.correctness.noPageError = true; report.correctness.allTwentyKeyboardInputsPersisted = true
  }, 30_000)
  report.status = 'completed'
} catch (error) {
  failed = true; report.status = 'failed'; report.error = { message: String(error), stack: error?.stack ?? null }; process.exitCode = 1
  console.error(error)
} finally {
  report.inputSummary = { visual: inputSummary(report.inputSamples.visual), source: inputSummary(report.inputSamples.source) }
  report.finishedAt = new Date().toISOString(); report.totalDurationMs = round(performance.now() - startedAt)
  await persist()
  if (application) {
    let closeTimer
    try {
      await Promise.race([application.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Electron shutdown exceeded 5 seconds.')), 5000) })])
    } catch (error) {
      report.diagnostics.push(String(error)); application.process()?.kill(); failed = true; report.status = 'failed'; process.exitCode = 1
    } finally { clearTimeout(closeTimer) }
  }
  // Keep failing fixtures for inspection. Successful fixtures are removed only
  // after their hashes, saved content and the untouched original were verified.
  if (report.pageErrors.length) { report.correctness.noPageError = false; failed = true; report.status = 'failed'; process.exitCode = 1 }
  if (!failed) {
    try {
      const removalTarget = path.resolve(temporary)
      assert.equal(path.dirname(removalTarget), path.resolve(tmpdir()), 'Cleanup target must remain directly inside the native temporary directory.')
      assert(path.basename(removalTarget).startsWith('ttypora-performance-'), 'Cleanup target must be this script’s generated directory.')
      await rm(removalTarget, { recursive: true, force: true }); report.temporaryFixturesRemoved = true
    } catch (error) { report.diagnostics.push(`Temporary fixture cleanup: ${error}`); failed = true; report.status = 'failed'; process.exitCode = 1 }
  }
  if (failed) report.retainedTemporaryDirectory = temporary
  await persist()
  console.log(`Performance measurements (${report.status}): ${reportPath}`)
  console.log(JSON.stringify({ timings: report.timings, inputSummary: report.inputSummary, correctness: report.correctness }, null, 2))
}
