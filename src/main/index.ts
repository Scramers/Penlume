import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import {
  app,
  clipboard,
  ClipboardItem,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron'
import type {
  AppCommand,
  ExportDocumentRequest,
  ImageAssetRequest,
  RecoveryDraft,
  SaveDocumentAsRequest,
  SaveDocumentRequest,
  SaveDocumentResult,
  WorkspaceSearchRequest,
  WindowDocumentStatus,
} from '../shared/contracts'
import { IPC } from '../shared/ipc'
import { APP_NAME, APP_TAGLINE, LEGACY_USER_DATA_DIRECTORY } from '../shared/branding'
import { formatLabels, type FormatAction } from '../shared/formatting'
import { translate, translateMessage, type InterfaceLanguage } from '../shared/localization'
import { mediaAssetRequestSchema, mediaFormats } from '../shared/media'
import { copyMediaAsset, resolveDocumentMediaUrl, saveMediaAsset } from './media-service'
import { ImageUploaderService, listImageUploadCandidates } from './image-uploader'
import { applyImageUploadsSchema, imageUploadRequestSchema, imageUploaderConfigurationSchema } from '../shared/image-uploader'
import {
  recoveryDraftSchema,
  resourceDocumentSnapshotSchema,
  exportDocumentRequestSchema,
  imageAssetRequestSchema,
  saveDocumentAsRequestSchema,
  saveDocumentRequestSchema,
  windowDocumentStatusSchema,
  workspaceDocumentPathSchema,
  workspaceSearchRequestSchema,
  workspaceMutationSchema,
} from '../shared/schemas'
import { DocumentWatcherRegistry } from './document-watcher'
import { DraftStore } from './draft-store'
import { prepareDocumentAssets, renderPdf, renderPng } from './export-service'
import { RecentStore } from './recent-store'
import { WorkspaceMutations } from './workspace-mutations'
import { PandocService } from './pandoc-service'
import { createDocumentResourceContext } from './document-resources'
import { pandocExportSchema, pandocFormats, pandocImportFormats } from '../shared/pandoc'
import { imageLibraryRequestSchema, imageLibraryMutationRequestSchema } from '../shared/image-library'
import { listImageLibrary, mutateImageLibrary } from './image-library'
import {
  resolveDocumentImageUrl,
  saveImageAsset,
} from './image-service'
import {
  normalizeFilePath,
  readDocumentSnapshot,
  saveDocumentAtomically,
  tryReadDocumentSnapshot,
} from './file-service'
import {
  readWorkspaceSnapshot,
  resolveAuthorizedWorkspaceFile,
  searchWorkspace,
  isPathInsideRoot,
} from './workspace-service'

interface WindowRuntimeState {
  document: WindowDocumentStatus
  allowClose: boolean
  closePromptOpen: boolean
  closePrepared: boolean
}

const windowStates = new Map<number, WindowRuntimeState>()
const authorizedPaths = new Map<number, Set<string>>()
const openDocumentPaths = new Map<number, Set<string>>()
const workspaceRoots = new Map<number, string>()
const interfaceLanguages = new Map<number, InterfaceLanguage>()
const watcherRegistry = new DocumentWatcherRegistry()
let draftStore: DraftStore
let recentStore: RecentStore
let pandocService: PandocService
let imageUploaderService: ImageUploaderService
const workspaceMutations = new WorkspaceMutations()
const smokeTestMode = process.env.TTYPORA_SMOKE_TEST === '1'
const smokeWorkspacePath = process.env.TTYPORA_SMOKE_WORKSPACE_PATH
const userDataOverride = process.env.TTYPORA_USER_DATA_PATH
const portableSmokeReadyFile = smokeTestMode
  ? process.env.TTYPORA_PORTABLE_SMOKE_READY_FILE
  : undefined
const portableSmokeAutoExit =
  smokeTestMode && process.env.TTYPORA_PORTABLE_SMOKE_AUTO_EXIT === '1'

app.setName(APP_NAME)
const persistentDataPath = userDataOverride ?? path.join(app.getPath('appData'), LEGACY_USER_DATA_DIRECTORY)
mkdirSync(persistentDataPath, { recursive: true })
app.setPath('userData', persistentDataPath)
app.setPath('sessionData', persistentDataPath)

const launchTargets: string[] = []
function enqueueLaunch(args: string[], cwd = process.cwd()): void {
  const start = process.defaultApp ? 2 : 1
  const target = args.slice(start).find((argument) => argument && !argument.startsWith('-') && argument !== '.')
  if (target) launchTargets.push(path.resolve(cwd, target))
}
if (!smokeTestMode) {
  enqueueLaunch(process.argv)
  if (!app.requestSingleInstanceLock()) app.quit()
  app.on('second-instance', (_event, argv, cwd) => {
    enqueueLaunch(argv, cwd)
    const window = focusedWindow()
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); sendCommand(window, 'open-launch') }
  })
  app.on('open-file', (event, filePath) => { event.preventDefault(); launchTargets.push(filePath); const window = focusedWindow(); if (window) sendCommand(window, 'open-launch') })
}

if (smokeTestMode) {
  app.disableHardwareAcceleration()
}

function getWindowState(window: BrowserWindow): WindowRuntimeState {
  const existing = windowStates.get(window.id)
  if (existing) return existing

  const state: WindowRuntimeState = {
    document: {
      dirty: false,
      draftId: 'uninitialized',
      displayName: '未命名文档',
    },
    allowClose: false,
    closePromptOpen: false,
    closePrepared: false,
  }
  windowStates.set(window.id, state)
  return state
}

function authorizePath(contentsId: number, filePath: string): string {
  const normalized = normalizeFilePath(filePath)
  const paths = authorizedPaths.get(contentsId) ?? new Set<string>()
  paths.add(normalized)
  authorizedPaths.set(contentsId, paths)
  return normalized
}

function isPathAuthorized(contentsId: number, filePath: string): boolean {
  const normalized = normalizeFilePath(filePath)
  return authorizedPaths.get(contentsId)?.has(normalized) ?? false
}

function sendCommand(window: BrowserWindow, command: AppCommand): void {
  if (!window.isDestroyed()) {
    window.webContents.send(IPC.appCommand, command)
  }
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

function windowLanguage(window: BrowserWindow | null): InterfaceLanguage {
  return window ? interfaceLanguages.get(window.webContents.id) ?? 'zh-CN' : 'zh-CN'
}

function localizedDialog<T extends Electron.OpenDialogOptions | Electron.SaveDialogOptions | Electron.MessageBoxOptions>(window: BrowserWindow, options: T): T {
  const t = (text: string) => translate(windowLanguage(window), text)
  return {
    ...options,
    ...(options.title ? { title: t(options.title) } : {}),
    ...('message' in options && options.message ? { message: t(options.message) } : {}),
    ...('detail' in options && options.detail ? { detail: t(options.detail) } : {}),
    ...('buttons' in options && options.buttons ? { buttons: options.buttons.map(t) } : {}),
    ...('filters' in options && options.filters ? { filters: options.filters.map((filter) => ({ ...filter, name: t(filter.name) })) } : {}),
  } as T
}
const showOpenDialog = (window: BrowserWindow, options: Electron.OpenDialogOptions) => dialog.showOpenDialog(window, localizedDialog(window, options))
const showSaveDialog = (window: BrowserWindow, options: Electron.SaveDialogOptions) => dialog.showSaveDialog(window, localizedDialog(window, options))
const showMessageBox = (window: BrowserWindow, options: Electron.MessageBoxOptions) => dialog.showMessageBox(window, localizedDialog(window, options))

function buildApplicationMenu(): void {
  const action = (label: string, command: AppCommand, accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, click: () => { const window = focusedWindow(); if (window) sendCommand(window, command) } })
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        action('关闭文档', 'close-document', 'CmdOrCtrl+W'),
        action('保存全部', 'save-all', 'CmdOrCtrl+Alt+S'),
        action('最近项目…', 'recent-items', 'CmdOrCtrl+Shift+O'),
        {
          label: '新建',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'new-document')
          },
        },
        {
          label: '打开…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'open-document')
          },
        },
        {
          label: '打开文件夹…',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'open-workspace')
          },
        },
        {
          label: '快速打开…',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'quick-open')
          },
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'save-document')
          },
        },
        {
          label: '另存为…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'save-document-as')
          },
        },
        { type: 'separator' },
        {
          label: '导出为 HTML…',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'export-html')
          },
        },
        {
          label: '导出为 PDF…',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'export-pdf')
          },
        },
        { type: 'separator' },
        action('导出无样式 HTML…', 'export-unstyled-html'),
        action('导出为 PNG 图片…', 'export-png'),
        action('文档转换 / 导入…', 'document-conversion'),
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        action('偏好设置…', 'preferences', 'CmdOrCtrl+,'),
        action('主题库…', 'theme-library'),
        action('管理文档图片…', 'image-library'),
        action('上传文档图片…', 'image-uploader'),
        action('插入音视频…', 'insert-media'),
        action('复制文档为 Markdown', 'copy-markdown'),
        action('复制文档为 HTML', 'copy-html'),
        action('复制选区为 Markdown', 'copy-selection-markdown', 'CmdOrCtrl+Shift+C'),
        action('复制选区为 HTML', 'copy-selection-html'),
        action('复制选区为纯文本', 'copy-selection-text', 'CmdOrCtrl+Alt+C'),
        action('复制文档为纯文本', 'copy-text'),
        action('撤销', 'undo-document', 'CmdOrCtrl+Z'),
        action('重做', 'redo-document', 'CmdOrCtrl+Y'),
        { ...action('重做', 'redo-document', 'CmdOrCtrl+Shift+Z'), visible: false },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        {
          label: '插入图片…',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'insert-image')
          },
        },
        { type: 'separator' },
        {
          label: '查找…',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'find-document')
          },
        },
        {
          label: '替换…',
          accelerator: 'CmdOrCtrl+H',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'replace-document')
          },
        },
        {
          label: '在文件夹中查找…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'search-workspace')
          },
        },
      ],
    },
    {
      label: '格式',
      submenu: Object.entries(formatLabels).map(([name, label]) => action(label, `format-${name as FormatAction}`, ({ bold: 'CmdOrCtrl+B', italic: 'CmdOrCtrl+I', inlineCode: 'CmdOrCtrl+E', heading1: 'CmdOrCtrl+1', heading2: 'CmdOrCtrl+2', heading3: 'CmdOrCtrl+3' } as Record<string, string>)[name])),
    },
    {
      label: '视图',
      submenu: [
        action('命令面板…', 'command-palette', 'CmdOrCtrl+K'),
        action('布局与尺寸…', 'layout-settings'),
        action('切换格式工具栏', 'toggle-formatting-toolbar'),
        action('恢复面板默认尺寸', 'reset-layout'),
        action('增大正文字号', 'font-size-up', 'CmdOrCtrl+Alt+='),
        action('减小正文字号', 'font-size-down', 'CmdOrCtrl+Alt+-'),
        action('恢复正文字号', 'font-size-reset', 'CmdOrCtrl+Alt+0'),
        action('源码与预览并排', 'toggle-split-mode', 'CmdOrCtrl+Shift+V'),
        action('写作目标…', 'writing-goal'),
        {
          label: '切换侧栏',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'toggle-sidebar')
          },
        },
        {
          label: '文档大纲',
          accelerator: 'CmdOrCtrl+Shift+1',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'show-outline')
          },
        },
        {
          label: '文件树',
          accelerator: 'CmdOrCtrl+Shift+3',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'show-files')
          },
        },
        { type: 'separator' },
        {
          label: '源码模式',
          accelerator: 'CmdOrCtrl+/',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'toggle-source-mode')
          },
        },
        {
          label: '专注模式',
          accelerator: 'F8',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'toggle-focus-mode')
          },
        },
        {
          label: '打字机模式',
          accelerator: 'F9',
          click: () => {
            const window = focusedWindow()
            if (window) sendCommand(window, 'toggle-typewriter-mode')
          },
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        action('恢复界面缩放', 'interface-zoom-reset', 'CmdOrCtrl+0'),
        action('放大界面', 'interface-zoom-in', 'CmdOrCtrl+='),
        action('缩小界面', 'interface-zoom-out', 'CmdOrCtrl+-'),
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]
  template.push({
    label: '帮助',
    submenu: [{
      label: '关于 Penlume',
      click: () => {
        const window = focusedWindow()
        if (window) void showMessageBox(window, {
          type: 'info', title: APP_NAME, message: APP_TAGLINE,
          detail: translate(windowLanguage(window), '版本 {value1}', { value1: app.getVersion() }),
          buttons: ['确定'], noLink: true,
        })
      },
    }],
  })
  const t = (text: string) => translate(windowLanguage(focusedWindow()), text)
  const localizeMenu = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => items.map((item) => ({ ...item, ...(item.label ? { label: t(item.label) } : {}), ...(Array.isArray(item.submenu) ? { submenu: localizeMenu(item.submenu) } : {}) }))
  Menu.setApplicationMenu(Menu.buildFromTemplate(localizeMenu(template)))
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol)
  } catch {
    return false
  }
}

function configureWindowSecurity(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
  })

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

function installCloseGuard(window: BrowserWindow): void {
  const contentsId = window.webContents.id
  window.on('close', (event) => {
    const state = getWindowState(window)
    if (state.allowClose) return
    if (state.document.draftId !== 'uninitialized' && !state.closePrepared) {
      event.preventDefault()
      if (!state.closePromptOpen) { state.closePromptOpen = true; sendCommand(window, 'prepare-window-close') }
      return
    }
    state.closePrepared = false
    if (!state.document.dirty) return

    event.preventDefault()
    if (state.closePromptOpen) return
    state.closePromptOpen = true

    void showMessageBox(window, {
        type: 'warning',
        title: '文档尚未保存',
        message: translate(windowLanguage(window), '{name} 有未保存的修改。', { name: state.document.documents?.filter((item) => item.dirty).map((item) => item.displayName).join(', ') || state.document.displayName }),
        detail: '你可以保存、保留恢复草稿后退出，或者放弃修改。',
        buttons: ['保存全部', '保留草稿并退出', '放弃并退出', '取消'],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
      })
      .then(async ({ response }) => {
        state.closePromptOpen = false
        if (response === 0) {
          sendCommand(window, 'request-save-and-close')
          return
        }
        if (response === 1) {
          sendCommand(window, 'request-draft-and-close')
          return
        }
        if (response === 2) {
          await Promise.all((state.document.documents ?? [state.document]).map((item) => draftStore.clear(item.draftId)))
          state.allowClose = true
          window.close()
        }
      })
  })

  window.on('closed', () => {
    windowStates.delete(window.id)
    authorizedPaths.delete(contentsId)
    openDocumentPaths.delete(contentsId)
    pandocService.cancel(contentsId)
    imageUploaderService.cancel(contentsId)
    workspaceRoots.delete(contentsId)
    interfaceLanguages.delete(contentsId)
    void watcherRegistry.unwatch(contentsId)
  })
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: APP_NAME,
    backgroundColor: '#f6f5f2',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  getWindowState(window)
  window.on('focus', buildApplicationMenu)
  configureWindowSecurity(window)
  installCloseGuard(window)
  if (!smokeTestMode) {
    window.once('ready-to-show', () => window.show())
  }

  const developmentUrl = process.env.VITE_DEV_SERVER_URL
  if (developmentUrl) {
    await window.loadURL(developmentUrl)
  } else {
    await window.loadFile(path.join(__dirname, '../../renderer/index.html'))
  }

  if (portableSmokeReadyFile) {
    const rendererReady = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const selector = '.ProseMirror[contenteditable="true"]'
        const isReady = () => Boolean(document.querySelector(selector))
        if (isReady()) {
          resolve(true)
          return
        }
        const observer = new MutationObserver(() => {
          if (!isReady()) return
          observer.disconnect()
          clearTimeout(timeout)
          resolve(true)
        })
        const timeout = setTimeout(() => {
          observer.disconnect()
          reject(new Error('Renderer editor did not become ready.'))
        }, 30000)
        observer.observe(document.documentElement, { childList: true, subtree: true })
      })
    `, true)
    await writeFile(portableSmokeReadyFile, JSON.stringify({
      rendererReady,
      pid: process.pid,
      executablePath: process.execPath,
      portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR ?? null,
    }), 'utf8')
    if (portableSmokeAutoExit) {
      getWindowState(window).allowClose = true
      window.close()
    }
  }

  return window
}

function unauthorizedSaveResult(): SaveDocumentResult {
  return {
    status: 'error',
    code: 'PATH_NOT_AUTHORIZED',
    message: '应用没有写入该路径的授权，请使用“另存为”。',
  }
}

function handleIpc(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const result = await handler(event, ...args)
      if (result && typeof result === 'object' && result.status === 'error' && typeof result.message === 'string') {
        return { ...result, message: translateMessage(interfaceLanguages.get(event.sender.id) ?? 'zh-CN', result.message) }
      }
      return result
    } catch (reason) {
      if (reason instanceof Error) throw new Error(translateMessage(interfaceLanguages.get(event.sender.id) ?? 'zh-CN', reason.message), { cause: reason })
      throw reason
    }
  })
}

function registerIpcHandlers(): void {
  handleIpc(IPC.setInterfaceZoom, (event, input: unknown) => {
    event.sender.setZoomFactor(z.number().min(0.75).max(1.5).parse(input))
  })
  handleIpc(IPC.setInterfaceLanguage, (event, input: unknown) => {
    interfaceLanguages.set(event.sender.id, z.enum(['zh-CN', 'en']).parse(input))
    if (focusedWindow()?.webContents.id === event.sender.id) buildApplicationMenu()
  })
  handleIpc(IPC.writeClipboard, (_event, input: unknown) => {
    const value = z.object({ text: z.string().max(20 * 1024 * 1024), html: z.string().max(20 * 1024 * 1024).optional() }).parse(input)
    return clipboard.write([new ClipboardItem({ 'text/plain': value.text, ...(value.html ? { 'text/html': value.html } : {}) })])
  })
  handleIpc(IPC.prepareSelectionClipboard, async (event, input: unknown) => {
    const request = exportDocumentRequestSchema.parse(input)
    if (request.sourcePath && !isPathAuthorized(event.sender.id, request.sourcePath)) throw new Error('文档路径未获授权。')
    const prepared = await prepareDocumentAssets(request.html, createDocumentResourceContext(request.sourcePath, request.markdown), imageRoot(event.sender.id, request.sourcePath), 'embed', windowLanguage(BrowserWindow.fromWebContents(event.sender)))
    if (prepared.html.length > 20 * 1024 * 1024) throw new Error('选区超过剪贴板大小限制。')
    // Preparation never writes the system clipboard; the renderer validates its
    // original document/mount/content lease before submitting the final write.
    return { html: prepared.html, warnings: prepared.warnings }
  })
  handleIpc(IPC.takeLaunchTarget, async (event) => {
    const target = launchTargets[0]
    if (!target) return null
    try {
      if ((await stat(target)).isDirectory()) {
        const workspace = await readWorkspaceSnapshot(target)
        workspaceRoots.set(event.sender.id, workspace.rootPath)
        await recentStore.remember(workspace.rootPath, 'directory')
        return { workspace }
      }
      if (!/\.(md|markdown|txt)$/i.test(target)) throw new Error('命令行仅支持 Markdown、文本文件和文件夹。')
      const snapshot = await readDocumentSnapshot(target)
      authorizePath(event.sender.id, snapshot.path)
      await watcherRegistry.watch(event.sender, snapshot.path, snapshot.version.sha256)
      await recentStore.remember(snapshot.path, 'file')
      return { document: snapshot }
    } finally { launchTargets.shift() }
  })
  const imageRoot = (contentsId: number, documentPath: string | null): string | undefined => {
    const root = workspaceRoots.get(contentsId)
    return root && documentPath && isPathInsideRoot(root, documentPath) ? root : undefined
  }
  const authorizedDocument = (contentsId: number, input: unknown): string => {
    const documentPath = workspaceDocumentPathSchema.parse(input)
    if (!isPathAuthorized(contentsId, documentPath)) throw new Error('当前文档路径未获授权，请先保存文档。')
    return documentPath
  }
  const resourceDocument = (contentsId: number, input: unknown) => {
    const snapshot = resourceDocumentSnapshotSchema.parse(input)
    const documentPath = authorizedDocument(contentsId, snapshot.documentPath)
    return createDocumentResourceContext(documentPath, snapshot.markdown)
  }
  handleIpc(IPC.chooseMediaAsset, async (event, input: unknown) => {
    const resources = resourceDocument(event.sender.id, input)
    const window = BrowserWindow.fromWebContents(event.sender); if (!window) return null
    const chosen = await showOpenDialog(window, { title: '插入本地音视频', properties: ['openFile'], filters: [{ name: '音视频', extensions: mediaFormats.map((format) => format.extension.slice(1)) }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const asset = await copyMediaAsset(resources, chosen.filePaths[0])
    authorizePath(event.sender.id, asset.path)
    return asset
  })
  handleIpc(IPC.saveMediaAsset, async (event, input: unknown, rawRequest: unknown) => {
    const resources = resourceDocument(event.sender.id, input)
    const asset = await saveMediaAsset(resources, mediaAssetRequestSchema.parse(rawRequest))
    authorizePath(event.sender.id, asset.path)
    return asset
  })
  handleIpc(IPC.resolveMediaUrl, (event, input: unknown, rawSource: unknown) => {
    const resources = resourceDocument(event.sender.id, input)
    const source = z.string().min(1).max(140 * 1024 * 1024).parse(rawSource)
    return resolveDocumentMediaUrl(resources, source, imageRoot(event.sender.id, resources.documentPath))
  })
  handleIpc(IPC.imageUploaderSettings, () => imageUploaderService.getSettings())
  handleIpc(IPC.listImageUploadCandidates, (event, input: unknown) => {
    const request = z.object({ documentPath: workspaceDocumentPathSchema, markdown: z.string().max(20 * 1024 * 1024) }).parse(input)
    authorizedDocument(event.sender.id, request.documentPath)
    return listImageUploadCandidates(request.documentPath, request.markdown, imageRoot(event.sender.id, request.documentPath))
  })
  handleIpc(IPC.chooseImageUploaderExecutable, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender); if (!window) return null
    const chosen = await showOpenDialog(window, { title: '选择图片上传程序', properties: ['openFile'], filters: [{ name: '可执行程序', extensions: process.platform === 'win32' ? ['exe', 'com'] : ['*'] }] })
    return chosen.canceled || !chosen.filePaths[0] ? null : imageUploaderService.selectExecutable(chosen.filePaths[0])
  })
  handleIpc(IPC.resetImageUploaderExecutable, () => imageUploaderService.selectExecutable(null))
  handleIpc(IPC.configureImageUploader, (_event, input: unknown) => imageUploaderService.configure(imageUploaderConfigurationSchema.parse(input)))
  handleIpc(IPC.uploadImages, (event, input: unknown) => {
    const request = imageUploadRequestSchema.parse(input)
    authorizedDocument(event.sender.id, request.documentPath)
    return imageUploaderService.upload(event.sender.id, request, imageRoot(event.sender.id, request.documentPath), (progress) => { if (!event.sender.isDestroyed()) event.sender.send(IPC.imageUploadProgress, progress) })
  })
  handleIpc(IPC.applyImageUploads, (event, input: unknown) => {
    const request = applyImageUploadsSchema.parse(input)
    authorizedDocument(event.sender.id, request.documentPath)
    return imageUploaderService.apply(event.sender.id, request)
  })
  handleIpc(IPC.imageUploadTask, (event, input: unknown) => imageUploaderService.getTask(event.sender.id, input === undefined ? undefined : z.string().uuid().parse(input)))
  ipcMain.on(IPC.cancelImageUploads, (event) => imageUploaderService.cancel(event.sender.id))
  handleIpc(IPC.pandocStatus, () => pandocService.detect())
  handleIpc(IPC.choosePandocExecutable, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender); if (!window) return null
    const chosen = await showOpenDialog(window, { title: '选择 Pandoc 程序', properties: ['openFile'], filters: [{ name: 'Pandoc 可执行程序', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    await pandocService.configure({ executablePath: normalizeFilePath(chosen.filePaths[0]) })
    return pandocService.detect()
  })
  handleIpc(IPC.resetPandocExecutable, async () => { await pandocService.configure({ executablePath: null }); return pandocService.detect() })
  handleIpc(IPC.choosePandocReference, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender); if (!window) return null
    const chosen = await showOpenDialog(window, { title: '选择 Word 参考样式文档', properties: ['openFile'], filters: [{ name: 'Word 文档', extensions: ['docx'] }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    if (!/\.docx$/i.test(chosen.filePaths[0])) throw new Error('参考样式须为 DOCX 文件。')
    await pandocService.configure({ referenceDocumentPath: normalizeFilePath(chosen.filePaths[0]) })
    return pandocService.detect()
  })
  handleIpc(IPC.configurePandocTimeout, async (_event, input: unknown) => { await pandocService.configure({ timeoutSeconds: z.number().int().min(10).max(300).parse(input) }); return pandocService.detect() })
  ipcMain.on(IPC.cancelPandoc, (event) => pandocService.cancel(event.sender.id))
  const conversionProgress = (sender: Electron.WebContents) => (progress: import('../shared/pandoc').PandocProgress) => { if (!sender.isDestroyed()) sender.send(IPC.pandocProgress, progress) }
  const assertConversionTarget = (contentsId: number, target: string, excluded: string[]) => {
    const normalized = normalizeFilePath(target).toLocaleLowerCase()
    if ([...(openDocumentPaths.get(contentsId) ?? []), ...excluded].some((filePath) => normalizeFilePath(filePath).toLocaleLowerCase() === normalized)) throw new Error('目标是已打开的文档，请选择其他输出路径。')
  }
  handleIpc(IPC.pandocExport, async (event, input: unknown) => {
    const request = pandocExportSchema.parse(input)
    if (request.sourcePath && !isPathAuthorized(event.sender.id, request.sourcePath)) throw new Error('转换文档路径未获授权。')
    const window = BrowserWindow.fromWebContents(event.sender); if (!window) return null
    const format = pandocFormats.find((format) => format.id === request.format)!
    const chosen = await showSaveDialog(window, { title: translate(windowLanguage(window), '导出 {format}', { format: format.label }), defaultPath: request.suggestedName.replace(/\.[^.]+$/, '') + '.' + format.extension, filters: [{ name: format.label, extensions: [format.extension] }] })
    if (chosen.canceled || !chosen.filePath) return null
    const target = normalizeFilePath(chosen.filePath); assertConversionTarget(event.sender.id, target, request.excludedPaths)
    return pandocService.exportDocument(event.sender.id, request, target, imageRoot(event.sender.id, request.sourcePath), (progress) => { if (progress.stage === 'writing') assertConversionTarget(event.sender.id, target, request.excludedPaths); conversionProgress(event.sender)(progress) })
  })
  handleIpc(IPC.pandocImport, async (event, input: unknown) => {
    const excluded = z.array(z.string().min(1).max(32768)).max(256).parse(input)
    const window = BrowserWindow.fromWebContents(event.sender); if (!window) return null
    const origin = await showOpenDialog(window, { title: '选择要转换的文档', properties: ['openFile'], filters: [{ name: '支持的文档', extensions: Object.keys(pandocImportFormats) }] })
    if (origin.canceled || !origin.filePaths[0]) return null
    const inputPath = normalizeFilePath(origin.filePaths[0])
    const chosen = await showSaveDialog(window, { title: '将导入内容保存为 Markdown', defaultPath: path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)) + '.converted.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (chosen.canceled || !chosen.filePath) return null
    const target = normalizeFilePath(chosen.filePath); assertConversionTarget(event.sender.id, target, excluded)
    if (!/\.(md|markdown)$/i.test(target)) throw new Error('导入内容请保存为 .md 或 .markdown 文件。')
    const result = await pandocService.importDocument(event.sender.id, inputPath, target, (progress) => { if (progress.stage === 'writing') assertConversionTarget(event.sender.id, target, excluded); conversionProgress(event.sender)(progress) })
    if (result.snapshot) { authorizePath(event.sender.id, result.snapshot.path); await watcherRegistry.watch(event.sender, result.snapshot.path, result.snapshot.version.sha256); await recentStore.remember(result.snapshot.path, 'file') }
    return result
  })
  const authorizeImageRequest = (contentsId: number, request: import('../shared/image-library').ImageLibraryRequest) => {
    if (!isPathAuthorized(contentsId, request.documentPath) || request.relatedDocuments?.some((document) => !isPathAuthorized(contentsId, document.path))) throw new Error('图片管理文档路径未获授权。')
  }
  handleIpc(IPC.listImages, (event, input: unknown) => { const request = imageLibraryRequestSchema.parse(input); authorizeImageRequest(event.sender.id, request); return listImageLibrary(request.documentPath, request.markdown, imageRoot(event.sender.id, request.documentPath), request.relatedDocuments) })
  handleIpc(IPC.mutateImages, (event, input: unknown) => { const request = imageLibraryMutationRequestSchema.parse(input); authorizeImageRequest(event.sender.id, request); return mutateImageLibrary(request.documentPath, request.markdown, request.mutation, imageRoot(event.sender.id, request.documentPath), request.relatedDocuments) })
  handleIpc(IPC.exportPng, async (event, input: unknown) => {
    const request = exportDocumentRequestSchema.parse(input)
    if (request.sourcePath && !isPathAuthorized(event.sender.id, request.sourcePath)) throw new Error('文档路径未获授权。')
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await showSaveDialog(window, { title: '导出为 PNG', defaultPath: request.suggestedName, filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
    if (result.canceled || !result.filePath) return null
    const assets = await prepareDocumentAssets(request.html, createDocumentResourceContext(request.sourcePath, request.markdown), imageRoot(event.sender.id, request.sourcePath), 'print', windowLanguage(window))
    const bytes = await renderPng(assets.html, app.getPath('temp'))
    await writeFile(result.filePath, bytes, { mode: 0o600 })
    return { path: result.filePath, warnings: assets.warnings }
  })
  handleIpc(IPC.listRecent, () => recentStore.list())
  handleIpc(IPC.pinRecent, (_event, input: unknown) => recentStore.pin(workspaceDocumentPathSchema.parse(input)))
  handleIpc(IPC.clearRecent, () => recentStore.clear())
  handleIpc(IPC.openRecent, async (event, input: unknown) => {
    const requested = workspaceDocumentPathSchema.parse(input)
    const entry = (await recentStore.list()).find((item) => item.path === requested)
    if (!entry) throw new Error('此项目不在最近项目中。')
    if (entry.kind === 'directory') {
      const workspace = await readWorkspaceSnapshot(entry.path)
      workspaceRoots.set(event.sender.id, workspace.rootPath)
      await recentStore.remember(entry.path, entry.kind)
      return { workspace }
    }
    const snapshot = await readDocumentSnapshot(entry.path)
    authorizePath(event.sender.id, snapshot.path)
    await watcherRegistry.watch(event.sender, snapshot.path, snapshot.version.sha256)
    await recentStore.remember(snapshot.path, 'file')
    return { document: snapshot }
  })
  handleIpc(IPC.mutateWorkspace, async (event, input: unknown) => {
    const request = workspaceMutationSchema.parse(input)
    const root = workspaceRoots.get(event.sender.id)
    if (!root) throw new Error('请先打开文件夹。')
    const result = await workspaceMutations.run(root, request)
    if (request.path && (request.action === 'rename' || request.action === 'delete')) authorizedPaths.get(event.sender.id)?.delete(normalizeFilePath(request.path))
    return { workspace: await readWorkspaceSnapshot(root), path: result }
  })
  handleIpc(IPC.openLink, async (event, rawPath: unknown, rawHref: unknown) => {
    const href = workspaceDocumentPathSchema.parse(rawHref)
    if (/^(https?:\/\/|mailto:)/i.test(href)) { await shell.openExternal(href); return null }
    const documentPath = workspaceDocumentPathSchema.parse(rawPath)
    if (!isPathAuthorized(event.sender.id, documentPath)) throw new Error('文档路径未获授权。')
    const hash = href.indexOf('#')
    const linkPath = hash >= 0 ? href.slice(0, hash) : href
    const anchor = hash >= 0 ? decodeURIComponent(href.slice(hash + 1)) : ''
    const candidate = /^file:/i.test(linkPath) ? fileURLToPath(linkPath) : path.resolve(path.dirname(documentPath), decodeURIComponent(linkPath))
    const root = workspaceRoots.get(event.sender.id) ?? path.dirname(documentPath)
    const authorized = await resolveAuthorizedWorkspaceFile(root, candidate)
    const snapshot = await readDocumentSnapshot(authorized)
    authorizePath(event.sender.id, snapshot.path)
    await watcherRegistry.watch(event.sender, snapshot.path, snapshot.version.sha256)
    await recentStore.remember(snapshot.path, 'file')
    return { document: snapshot, anchor }
  })
  handleIpc(IPC.openDocument, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null

    const result = await showOpenDialog(window, {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown 与文本', extensions: ['md', 'markdown', 'txt'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = authorizePath(event.sender.id, result.filePaths[0])
    const snapshot = await readDocumentSnapshot(filePath)
    await recentStore.remember(snapshot.path, 'file')
    await watcherRegistry.watch(
      event.sender,
      snapshot.path,
      snapshot.version.sha256,
    )
    return snapshot
  })

  handleIpc(IPC.openWorkspace, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    let rootPath = smokeTestMode ? smokeWorkspacePath : undefined
    if (!rootPath) {
      const result = await showOpenDialog(window, {
        title: '打开文件夹',
        properties: ['openDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      rootPath = result.filePaths[0]
    }

    const snapshot = await readWorkspaceSnapshot(rootPath)
    workspaceRoots.set(event.sender.id, snapshot.rootPath)
    await recentStore.remember(snapshot.rootPath, 'directory')
    return snapshot
  })

  handleIpc(IPC.refreshWorkspace, async (event) => {
    const rootPath = workspaceRoots.get(event.sender.id)
    return rootPath ? readWorkspaceSnapshot(rootPath) : null
  })

  handleIpc(
    IPC.searchWorkspace,
    async (event, input: WorkspaceSearchRequest) => {
      const request = workspaceSearchRequestSchema.parse(input)
      const rootPath = workspaceRoots.get(event.sender.id)
      if (!rootPath) throw new Error('尚未打开工作区。')
      return searchWorkspace(rootPath, request)
    },
  )

  handleIpc(IPC.openWorkspaceDocument, async (event, input: unknown) => {
    const requestedPath = workspaceDocumentPathSchema.parse(input)
    const rootPath = workspaceRoots.get(event.sender.id)
    if (!rootPath) throw new Error('尚未打开工作区。')

    const filePath = await resolveAuthorizedWorkspaceFile(rootPath, requestedPath)
    authorizePath(event.sender.id, filePath)
    const snapshot = await readDocumentSnapshot(filePath)
    await recentStore.remember(snapshot.path, 'file')
    await watcherRegistry.watch(event.sender, snapshot.path, snapshot.version.sha256)
    return snapshot
  })

  handleIpc(IPC.chooseImageAsset, async (event, input: unknown) => {
    const resources = resourceDocument(event.sender.id, input)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await showOpenDialog(window, {
      title: '插入本地图片',
      properties: ['openFile'],
      filters: [{
        name: '图片',
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'],
      }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const sourcePath = result.filePaths[0]
    const asset = await saveImageAsset(resources, {
      fileName: path.basename(sourcePath),
      mimeType: '',
      bytes: await readFile(sourcePath),
    })
    authorizePath(event.sender.id, asset.path)
    return asset
  })

  handleIpc(
    IPC.saveImageAsset,
    async (event, rawDocument: unknown, input: ImageAssetRequest) => {
      const resources = resourceDocument(event.sender.id, rawDocument)
      const asset = await saveImageAsset(
        resources,
        imageAssetRequestSchema.parse(input),
      )
      authorizePath(event.sender.id, asset.path)
      return asset
    },
  )

  handleIpc(
    IPC.resolveImageUrl,
    async (event, rawDocument: unknown, rawSource: unknown) => {
      const resources = resourceDocument(event.sender.id, rawDocument)
      if (typeof rawSource !== 'string' || rawSource.length > 32_768) {
        throw new Error('图片地址无效。')
      }
      return resolveDocumentImageUrl(resources, rawSource, imageRoot(event.sender.id, resources.documentPath))
    },
  )

  handleIpc(
    IPC.exportHtml,
    async (event, input: ExportDocumentRequest) => {
      const request = exportDocumentRequestSchema.parse(input)
      if (request.sourcePath && !isPathAuthorized(event.sender.id, request.sourcePath)) {
        throw new Error('当前文档路径未获授权。')
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return null
      const result = await showSaveDialog(window, {
        title: '导出为 HTML',
        defaultPath: request.sourcePath
          ? path.join(path.dirname(request.sourcePath), request.suggestedName)
          : request.suggestedName,
        filters: [{ name: 'HTML', extensions: ['html'] }],
      })
      if (result.canceled || !result.filePath) return null
      const assets = await prepareDocumentAssets(request.html, createDocumentResourceContext(request.sourcePath, request.markdown), imageRoot(event.sender.id, request.sourcePath), 'embed', windowLanguage(window))
      await writeFile(result.filePath, assets.html, { encoding: 'utf8', mode: 0o600 })
      return { path: result.filePath, warnings: assets.warnings }
    },
  )

  handleIpc(
    IPC.exportPdf,
    async (event, input: ExportDocumentRequest) => {
      const request = exportDocumentRequestSchema.parse(input)
      if (request.sourcePath && !isPathAuthorized(event.sender.id, request.sourcePath)) {
        throw new Error('当前文档路径未获授权。')
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return null
      const result = await showSaveDialog(window, {
        title: '导出为 PDF',
        defaultPath: request.sourcePath
          ? path.join(path.dirname(request.sourcePath), request.suggestedName)
          : request.suggestedName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (result.canceled || !result.filePath) return null
      const assets = await prepareDocumentAssets(request.html, createDocumentResourceContext(request.sourcePath, request.markdown), imageRoot(event.sender.id, request.sourcePath), 'print', windowLanguage(window))
      const pdf = await renderPdf(assets.html, app.getPath('temp'), request.pdf)
      await writeFile(result.filePath, pdf, { mode: 0o600 })
      return { path: result.filePath, warnings: assets.warnings }
    },
  )

  handleIpc(
    IPC.saveDocument,
    async (event, input: SaveDocumentRequest): Promise<SaveDocumentResult> => {
      const request = saveDocumentRequestSchema.parse(input)
      if (!isPathAuthorized(event.sender.id, request.path)) {
        return unauthorizedSaveResult()
      }

      const result = await saveDocumentAtomically(request)
      if (result.status === 'saved') {
        await recentStore.remember(result.snapshot.path, 'file')
        watcherRegistry.updateKnownVersion(
          event.sender.id,
          result.snapshot.path,
          result.snapshot.version.sha256,
        )
      }
      return result
    },
  )

  handleIpc(
    IPC.saveDocumentAs,
    async (
      event,
      input: SaveDocumentAsRequest,
    ): Promise<SaveDocumentResult | null> => {
      const request = saveDocumentAsRequestSchema.parse(input)
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return null

      const result = await showSaveDialog(window, {
        title: '另存为 Markdown 文件',
        defaultPath: request.suggestedName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (result.canceled || !result.filePath) return null

      const filePath = authorizePath(event.sender.id, result.filePath)
      if (request.excludedPaths?.some((item) => normalizeFilePath(item).toLocaleLowerCase() === filePath.toLocaleLowerCase())) {
        return { status: 'error', code: 'OPEN_TAB', message: '目标文件已在另一个标签中打开，请选择其他文件名。' }
      }
      const existing = await tryReadDocumentSnapshot(filePath)
      const saveResult = await saveDocumentAtomically({
        path: filePath,
        markdown: request.markdown,
        format: request.format,
        expectedVersion: existing?.version ?? null,
      })

      if (saveResult.status === 'saved') {
        await recentStore.remember(saveResult.snapshot.path, 'file')
        await watcherRegistry.watch(
          event.sender,
          saveResult.snapshot.path,
          saveResult.snapshot.version.sha256,
        )
      }
      return saveResult
    },
  )

  handleIpc(IPC.updateDraft, async (_event, input: RecoveryDraft) => {
    await draftStore.write(recoveryDraftSchema.parse(input))
  })

  handleIpc(IPC.clearDraft, async (_event, draftId: unknown) => {
    if (typeof draftId !== 'string' || draftId.length > 128) {
      throw new Error('无效的草稿 ID。')
    }
    await draftStore.clear(draftId)
  })

  handleIpc(IPC.listRecoveryDrafts, async () => draftStore.list())

  handleIpc(IPC.restoreDraft, async (event, draftId: unknown) => {
    if (
      typeof draftId !== 'string' ||
      draftId.length === 0 ||
      draftId.length > 128
    ) {
      throw new Error('无效的草稿 ID。')
    }

    const draft = await draftStore.get(draftId)
    if (draft?.sourcePath) {
      authorizePath(event.sender.id, draft.sourcePath)
      if (draft.expectedVersion) {
        await watcherRegistry.watch(
          event.sender,
          draft.sourcePath,
          draft.expectedVersion.sha256,
        )
      }
    }
    return draft
  })

  handleIpc(
    IPC.confirmUnsaved,
    async (event, displayName: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return 'cancel'
      const safeName =
        typeof displayName === 'string' && displayName.length <= 255
          ? displayName
          : '当前文档'
      const { response } = await showMessageBox(window, {
        type: 'warning',
        title: '未保存的修改',
        message: translate(windowLanguage(window), '{name} 有未保存的修改。', { name: safeName }),
        detail: '继续前请选择如何处理。',
        buttons: ['保存', '放弃修改', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
    },
  )

  handleIpc(IPC.syncOpenDocuments, async (event, input: unknown) => {
    if (!Array.isArray(input) || input.length > 256 || input.some((item) => typeof item !== 'string' || !isPathAuthorized(event.sender.id, item))) throw new Error('无效的文档会话。')
    openDocumentPaths.set(event.sender.id, new Set(input as string[]))
    await watcherRegistry.retain(event.sender.id, input)
  })
  handleIpc(IPC.preparePreview, async (event, input) => {
    const request = exportDocumentRequestSchema.parse(input)
    if (request.sourcePath && !isPathAuthorized(event.sender.id, request.sourcePath)) throw new Error('无权读取预览资源。')
    return (await prepareDocumentAssets(request.html, createDocumentResourceContext(request.sourcePath, request.markdown), imageRoot(event.sender.id, request.sourcePath), 'preview', windowLanguage(BrowserWindow.fromWebContents(event.sender)))).html
  })
  ipcMain.on(IPC.requestWindowClose, (event, cancel: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    const state = getWindowState(window)
    state.closePromptOpen = false
    if (cancel === true) { state.closePrepared = false; return }
    state.closePrepared = true
    window.close()
  })
  ipcMain.on(IPC.performNativeEdit, (event, direction: unknown) => {
    if (direction === 'undo') event.sender.undo()
    if (direction === 'redo') event.sender.redo()
  })
  ipcMain.on(IPC.setWindowDocumentStatus, (event, input) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    getWindowState(window).document = windowDocumentStatusSchema.parse(input)
  })

  ipcMain.on(IPC.confirmWindowClose, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    getWindowState(window).allowClose = true
    window.close()
  })
}

app.whenReady().then(async () => {
  draftStore = new DraftStore(path.join(app.getPath('userData'), 'drafts'))
  recentStore = new RecentStore(path.join(app.getPath('userData'), 'recent.json'))
  const bundledPandoc = process.platform === 'win32' ? app.isPackaged ? path.join(process.resourcesPath, 'tools/pandoc/pandoc.exe') : path.join(app.getAppPath(), '.tools/pandoc/pandoc-3.12/pandoc.exe') : undefined
  pandocService = new PandocService(path.join(app.getPath('userData'), 'pandoc.json'), bundledPandoc)
  await pandocService.load()
  imageUploaderService = new ImageUploaderService(path.join(app.getPath('userData'), 'image-uploader.json'))
  await imageUploaderService.load()
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  )
  registerIpcHandlers()
  buildApplicationMenu()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void watcherRegistry.closeAll()
})

