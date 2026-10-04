import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
)
const portableExecutablePath = process.env.TTYPORA_PACKAGED_VARIANT === 'portable'
  ? path.join(
      projectRoot,
      packageMetadata.build.directories.output,
      `${packageMetadata.build.productName} Portable ${packageMetadata.version}.exe`,
    )
  : null
const packagedExecutablePath = process.env.TTYPORA_PACKAGED_EXE
  ? path.resolve(projectRoot, process.env.TTYPORA_PACKAGED_EXE)
  : portableExecutablePath
const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'ttypora-smoke-'))
const workspacePath = path.join(userDataPath, 'workspace')
await mkdir(workspacePath)
await writeFile(path.join(workspacePath, 'workspace-note.md'), '# Workspace note\n', 'utf8')
let electronApp
let page

try {
  console.log('Launching Electron smoke test...')
  electronApp = await electron.launch({
    ...(packagedExecutablePath ? { executablePath: packagedExecutablePath } : {}),
    args: packagedExecutablePath ? ['--disable-gpu'] : ['--disable-gpu', '.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      TTYPORA_SMOKE_TEST: '1',
      TTYPORA_USER_DATA_PATH: userDataPath,
      TTYPORA_SMOKE_WORKSPACE_PATH: workspacePath,
    },
  })

  page = await electronApp.firstWindow({ timeout: 15_000 })
  const sendAppCommand = (command) => electronApp.evaluate(
    ({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('app:command', value)
    },
    command,
  )
  page.on('pageerror', (error) => console.error('Renderer error:', error))
  await page
    .locator('.ProseMirror[contenteditable="true"]')
    .waitFor({ timeout: 15_000 })
  await page
    .locator('.editor-loading')
    .waitFor({ state: 'detached', timeout: 15_000 })
  console.log('Editor initialized.')

  assert.equal(await page.title(), `未命名文档 — ${packageMetadata.build.productName}`)

  const apiMethods = await page.evaluate(() =>
    Object.keys(window.ttypora).sort(),
  )
  assert.deepEqual(apiMethods, [
    'setInterfaceLanguage',
    'setInterfaceZoom',
    'listImageUploadCandidates',
    'chooseMediaAsset', 'saveMediaAsset', 'resolveMediaUrl', 'imageUploaderSettings', 'chooseImageUploaderExecutable', 'resetImageUploaderExecutable', 'configureImageUploader', 'uploadImages', 'applyImageUploads', 'imageUploadTask', 'cancelImageUploads', 'onImageUploadProgress',
    'pandocStatus', 'choosePandocExecutable', 'resetPandocExecutable', 'choosePandocReference', 'configurePandocTimeout', 'pandocExport', 'pandocImport', 'cancelPandoc', 'onPandocProgress', 'listImages', 'mutateImages',
    'performNativeEdit',
    'syncOpenDocuments',
    'preparePreview',
    'prepareSelectionClipboard',
    'requestWindowClose',
    'takeLaunchTarget',
    'writeClipboard',
    'clearRecent',
    'exportPng',
    'listRecent',
    'mutateWorkspace',
    'openLink',
    'openRecent',
    'pinRecent',
    'chooseImageAsset',
    'clearDraft',
    'confirmUnsaved',
    'confirmWindowClose',
    'exportHtml',
    'exportPdf',
    'listRecoveryDrafts',
    'onAppCommand',
    'onExternalFileChange',
    'openDocument',
    'openWorkspace',
    'openWorkspaceDocument',
    'refreshWorkspace',
    'resolveImageUrl',
    'restoreDraft',
    'saveDocument',
    'saveDocumentAs',
    'saveImageAsset',
    'searchWorkspace',
    'setWindowDocumentStatus',
    'updateDraft',
  ].sort())

  assert.equal(await page.evaluate(async () => { try { await window.ttypora.setInterfaceLanguage('invalid'); return false } catch { return true } }), true)
  assert.equal(await page.evaluate(async () => { try { await window.ttypora.setInterfaceZoom(0.5); return false } catch { return true } }), true)
  await page.evaluate(() => window.ttypora.setInterfaceLanguage('en'))
  assert.equal(await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].label), 'File')
  await electronApp.evaluate(({ dialog }) => {
    globalThis.originalOpenDialog = dialog.showOpenDialog
    globalThis.originalMessageBox = dialog.showMessageBox
    dialog.showOpenDialog = async (_window, options) => { globalThis.lastOpenOptions = options; return { canceled: true, filePaths: [] } }
    dialog.showMessageBox = async (_window, options) => { globalThis.lastMessageOptions = options; return { response: 2, checkboxChecked: false } }
  })
  await page.evaluate(() => window.ttypora.openDocument())
  assert.equal(await electronApp.evaluate(() => globalThis.lastOpenOptions.title), 'Open Markdown file')
  await page.evaluate(() => window.ttypora.confirmUnsaved('我的笔记.md'))
  const unsaved = await electronApp.evaluate(() => globalThis.lastMessageOptions)
  assert.equal(unsaved.message, '我的笔记.md has unsaved changes.')
  assert.deepEqual(unsaved.buttons, ['Save', 'Discard changes', 'Cancel'])
  await electronApp.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.originalOpenDialog; dialog.showMessageBox = globalThis.originalMessageBox })
  await page.evaluate(() => window.ttypora.setInterfaceLanguage('zh-CN'))
  assert.equal(await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].label), '文件')
  console.log('Native menus and dialogs follow validated interface language, preserving user document names.')

  await sendAppCommand('show-outline')
  await page.getByRole('tab', { name: '文件' }).click()
  await page.getByRole('button', { name: '打开文件夹' }).click()
  await sendAppCommand('quick-open')
  const quickOpen = page.getByLabel('输入文件名')
  await quickOpen.fill('workspace-note')
  await quickOpen.press('Enter')
  await page.waitForFunction(() => document.title.includes('workspace-note.md'))
  console.log('Quick Open opened a workspace document.')

  await sendAppCommand('search-workspace')
  const workspaceSearch = page.getByLabel('输入搜索内容')
  await workspaceSearch.fill('Workspace note')
  await page.locator('.workspace-search-results').waitFor({ timeout: 10_000 })
  assert.match(await page.locator('.workspace-search-results').innerText(), /workspace-note\.md/)
  await workspaceSearch.press('Escape')
  console.log('Workspace full-text search returned a result.')

  const editor = page.locator('.ProseMirror')
  await editor.fill('# 冒烟测试\n\nHello TTypora')
  await page.waitForFunction(() => document.title.startsWith('● '), null, {
    timeout: 10_000,
  })
  assert.match(await page.locator('.statusbar').innerText(), /[1-9]\d*\s*字符/)
  console.log('Editing state updated.')

  await sendAppCommand('find-document')
  const findInput = page.getByRole('textbox', { name: '查找', exact: true })
  await findInput.fill('TTypora')
  await findInput.press('Enter')
  assert.match(await page.locator('.search-panel__count').innerText(), /1\s*\/\s*1/)
  await findInput.press('Escape')

  await sendAppCommand('replace-document')
  await page.getByRole('textbox', { name: '查找', exact: true }).fill('Hello')
  await page.getByRole('textbox', { name: '替换为', exact: true }).fill('Hi')
  await page.getByRole('button', { name: '替换', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Hi TTypora'))
  await page.getByRole('textbox', { name: '查找', exact: true }).press('Escape')
  console.log('Visual editor find and replace works.')

  await page.getByTitle('切换源码模式').click()
  const sourceEditor = page.locator('.cm-content')
  await sourceEditor.waitFor({ timeout: 10_000 })
  await sourceEditor.click()
  await sourceEditor.press('Control+A')
  await sourceEditor.pressSequentially('# 冒烟测试\n\nHello TTypora\n\n## Source mode\n\n```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```')
  await page.waitForFunction(() => document.body.innerText.includes('Markdown 源码'))
  console.log('Source mode editing works.')

  await page.getByTitle('所见即所得', { exact: true }).click()
  await page.locator('.ProseMirror').waitFor({ timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Source mode'))
  const mermaidPreview = page.locator('.mermaid-preview')
  await mermaidPreview.waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => {
    const preview = document.querySelector('.mermaid-preview')
    return preview?.querySelector('svg') || preview?.classList.contains('mermaid-preview--error')
  }, null, { timeout: 45_000 }).catch(async (error) => {
    const diagnostic = await mermaidPreview.evaluate((element) => ({
      stage: element.getAttribute('data-render-stage'),
      text: element.textContent,
      html: element.innerHTML.slice(0, 500),
    }))
    throw new Error(`Mermaid preview timed out: ${JSON.stringify(diagnostic)}`, { cause: error })
  })
  if (await mermaidPreview.locator('svg').count() === 0) {
    throw new Error(await mermaidPreview.innerText())
  }
  console.log('Mermaid preview rendered.')

  await page.getByRole('tab', { name: '大纲' }).click()
  await page.locator('.outline-list').waitFor({ timeout: 10_000 })
  assert.match(await page.locator('.outline-list').innerText(), /冒烟测试[\s\S]*Source mode/)
  console.log('Outline sidebar updated.')

  await page.getByTitle('专注模式（F8）').click()
  await page.getByTitle('打字机模式（F9）').click()
  assert.equal(await page.locator('.app-shell--focus').count(), 1)
  assert.equal(await page.locator('.app-shell--typewriter').count(), 1)

  await page.getByTitle('查看字数、段落和阅读时间').click()
  const writingStats = page.getByRole('region', { name: '字数统计' })
  await writingStats.waitFor()
  assert.match(await writingStats.innerText(), /词数[\s\S]*字符/)
  await page.getByRole('button', { name: '关闭字数统计' }).click()

  await page.waitForFunction(async () => {
    const drafts = await window.ttypora.listRecoveryDrafts()
    return drafts.some((draft) => draft.markdown.includes('冒烟测试'))
  }, null, { timeout: 10_000 })
  console.log('Recovery draft persisted.')

  const unauthorized = await page.evaluate(async (unauthorizedPath) =>
    window.ttypora.saveDocument({
      path: unauthorizedPath,
      markdown: 'must not be written',
      format: { hasBom: false, lineEnding: 'lf' },
      expectedVersion: null,
      force: false,
    }), path.join(userDataPath, 'unauthorized-smoke.md'),
  )
  assert.equal(unauthorized.status, 'error')
  assert.equal(unauthorized.code, 'PATH_NOT_AUTHORIZED')
  console.log('Unauthorized write rejected.')

  await page.getByTitle('命令面板（Ctrl+K）', { exact: true }).click()
  await page.getByPlaceholder('输入操作，例如：导出、专注、保存全部…', { exact: true }).fill('切换明亮')
  await page.keyboard.press('Enter')
  assert.match(
    await page.evaluate(() => document.documentElement.dataset.theme ?? ''),
    /^(light|dark)$/,
  )

  assert.equal(await page.locator('[role="alert"]').count(), 0)
  console.log('Electron smoke test passed: preload, search, workspace, visual/source editing, Mermaid, outline, modes, writing stats, draft, theme, and IPC guard.')
} catch (error) {
  if (page && !page.isClosed()) console.error('Renderer diagnostic:', await page.locator('body').innerText().catch(() => 'unavailable'))
  throw error
} finally {
  if (page && !page.isClosed()) {
    await page
      .evaluate(() => window.ttypora.confirmWindowClose())
      .catch(() => undefined)
  }
  if (electronApp) await electronApp.close().catch(() => undefined)
  await rm(userDataPath, { recursive: true, force: true })
}
