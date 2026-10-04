import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppCommand,
  ExternalFileChange,
  ExportDocumentRequest,
  ExportDocumentResult,
  ImageAssetRequest,
  ImageAssetResult,
  RecoveryDraft,
  ResourceDocumentSnapshot,
  SaveDocumentAsRequest,
  SaveDocumentRequest,
  TTyporaApi,
  WindowDocumentStatus,
  WorkspaceSnapshot,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
} from '../shared/contracts'
import { IPC } from '../shared/ipc'

const api: TTyporaApi = {
  setInterfaceZoom: (factor) => ipcRenderer.invoke(IPC.setInterfaceZoom, factor),
  setInterfaceLanguage: (locale) => ipcRenderer.invoke(IPC.setInterfaceLanguage, locale),
  chooseMediaAsset: (document) => ipcRenderer.invoke(IPC.chooseMediaAsset, document),
  saveMediaAsset: (document, request) => ipcRenderer.invoke(IPC.saveMediaAsset, document, request),
  resolveMediaUrl: (document, source) => ipcRenderer.invoke(IPC.resolveMediaUrl, document, source),
  imageUploaderSettings: () => ipcRenderer.invoke(IPC.imageUploaderSettings),
  listImageUploadCandidates: (request) => ipcRenderer.invoke(IPC.listImageUploadCandidates, request),
  chooseImageUploaderExecutable: () => ipcRenderer.invoke(IPC.chooseImageUploaderExecutable),
  resetImageUploaderExecutable: () => ipcRenderer.invoke(IPC.resetImageUploaderExecutable),
  configureImageUploader: (configuration) => ipcRenderer.invoke(IPC.configureImageUploader, configuration),
  uploadImages: (request) => ipcRenderer.invoke(IPC.uploadImages, request),
  applyImageUploads: (request) => ipcRenderer.invoke(IPC.applyImageUploads, request),
  imageUploadTask: (taskId) => ipcRenderer.invoke(IPC.imageUploadTask, taskId),
  cancelImageUploads: () => ipcRenderer.send(IPC.cancelImageUploads),
  onImageUploadProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: import('../shared/image-uploader').ImageUploadProgress) => listener(progress)
    ipcRenderer.on(IPC.imageUploadProgress, wrapped)
    return () => ipcRenderer.removeListener(IPC.imageUploadProgress, wrapped)
  },
  pandocStatus: () => ipcRenderer.invoke(IPC.pandocStatus),
  choosePandocExecutable: () => ipcRenderer.invoke(IPC.choosePandocExecutable),
  resetPandocExecutable: () => ipcRenderer.invoke(IPC.resetPandocExecutable),
  choosePandocReference: () => ipcRenderer.invoke(IPC.choosePandocReference),
  configurePandocTimeout: (seconds) => ipcRenderer.invoke(IPC.configurePandocTimeout, seconds),
  pandocExport: (request) => ipcRenderer.invoke(IPC.pandocExport, request),
  pandocImport: (excludedPaths) => ipcRenderer.invoke(IPC.pandocImport, excludedPaths),
  cancelPandoc: () => ipcRenderer.send(IPC.cancelPandoc),
  onPandocProgress: (listener) => { const wrapped = (_event: Electron.IpcRendererEvent, progress: import('../shared/pandoc').PandocProgress) => listener(progress); ipcRenderer.on(IPC.pandocProgress, wrapped); return () => ipcRenderer.removeListener(IPC.pandocProgress, wrapped) },
  listImages: (request) => ipcRenderer.invoke(IPC.listImages, request),
  mutateImages: (request) => ipcRenderer.invoke(IPC.mutateImages, request),
  performNativeEdit: (direction) => ipcRenderer.send(IPC.performNativeEdit, direction),
  syncOpenDocuments: (paths) => ipcRenderer.invoke(IPC.syncOpenDocuments, paths),
  preparePreview: (request) => ipcRenderer.invoke(IPC.preparePreview, request),
  requestWindowClose: (cancel = false) => ipcRenderer.send(IPC.requestWindowClose, cancel),
  takeLaunchTarget: () => ipcRenderer.invoke(IPC.takeLaunchTarget),
  writeClipboard: (content) => ipcRenderer.invoke(IPC.writeClipboard, content),
  prepareSelectionClipboard: (request) => ipcRenderer.invoke(IPC.prepareSelectionClipboard, request),
  mutateWorkspace: (request) => ipcRenderer.invoke(IPC.mutateWorkspace, request),
  listRecent: () => ipcRenderer.invoke(IPC.listRecent),
  openRecent: (filePath) => ipcRenderer.invoke(IPC.openRecent, filePath),
  pinRecent: (filePath) => ipcRenderer.invoke(IPC.pinRecent, filePath),
  clearRecent: () => ipcRenderer.invoke(IPC.clearRecent),
  openLink: (documentPath, href) => ipcRenderer.invoke(IPC.openLink, documentPath, href),
  exportPng: (request) => ipcRenderer.invoke(IPC.exportPng, request),
  openDocument: () => ipcRenderer.invoke(IPC.openDocument),
  openWorkspace: (): Promise<WorkspaceSnapshot | null> =>
    ipcRenderer.invoke(IPC.openWorkspace),
  refreshWorkspace: (): Promise<WorkspaceSnapshot | null> =>
    ipcRenderer.invoke(IPC.refreshWorkspace),
  searchWorkspace: (
    request: WorkspaceSearchRequest,
  ): Promise<WorkspaceSearchResult> =>
    ipcRenderer.invoke(IPC.searchWorkspace, request),
  openWorkspaceDocument: (filePath: string) =>
    ipcRenderer.invoke(IPC.openWorkspaceDocument, filePath),
  chooseImageAsset: (document: ResourceDocumentSnapshot): Promise<ImageAssetResult | null> =>
    ipcRenderer.invoke(IPC.chooseImageAsset, document),
  saveImageAsset: (
    document: ResourceDocumentSnapshot,
    request: ImageAssetRequest,
  ): Promise<ImageAssetResult> =>
    ipcRenderer.invoke(IPC.saveImageAsset, document, request),
  resolveImageUrl: (document: ResourceDocumentSnapshot, source: string): Promise<string> =>
    ipcRenderer.invoke(IPC.resolveImageUrl, document, source),
  exportHtml: (
    request: ExportDocumentRequest,
  ): Promise<ExportDocumentResult | null> =>
    ipcRenderer.invoke(IPC.exportHtml, request),
  exportPdf: (
    request: ExportDocumentRequest,
  ): Promise<ExportDocumentResult | null> =>
    ipcRenderer.invoke(IPC.exportPdf, request),
  saveDocument: (request: SaveDocumentRequest) =>
    ipcRenderer.invoke(IPC.saveDocument, request),
  saveDocumentAs: (request: SaveDocumentAsRequest) =>
    ipcRenderer.invoke(IPC.saveDocumentAs, request),
  updateDraft: (draft: RecoveryDraft) =>
    ipcRenderer.invoke(IPC.updateDraft, draft),
  clearDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC.clearDraft, draftId),
  listRecoveryDrafts: () => ipcRenderer.invoke(IPC.listRecoveryDrafts),
  restoreDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC.restoreDraft, draftId),
  confirmUnsaved: (displayName: string) =>
    ipcRenderer.invoke(IPC.confirmUnsaved, displayName),
  setWindowDocumentStatus: (status: WindowDocumentStatus) => {
    ipcRenderer.send(IPC.setWindowDocumentStatus, status)
  },
  confirmWindowClose: () => {
    ipcRenderer.send(IPC.confirmWindowClose)
  },
  onExternalFileChange: (
    listener: (change: ExternalFileChange) => void,
  ) => {
    const wrapped = (_event: Electron.IpcRendererEvent, change: ExternalFileChange) =>
      listener(change)
    ipcRenderer.on(IPC.externalFileChange, wrapped)
    return () => ipcRenderer.removeListener(IPC.externalFileChange, wrapped)
  },
  onAppCommand: (listener: (command: AppCommand) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, command: AppCommand) =>
      listener(command)
    ipcRenderer.on(IPC.appCommand, wrapped)
    return () => ipcRenderer.removeListener(IPC.appCommand, wrapped)
  },
}

contextBridge.exposeInMainWorld('ttypora', api)
