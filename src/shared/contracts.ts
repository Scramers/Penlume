export type LineEnding = 'lf' | 'crlf'

export interface TextFormat {
  lineEnding: LineEnding
  hasBom: boolean
}

export interface FileVersionToken {
  path: string
  size: number
  mtimeMs: number
  sha256: string
}

export interface DocumentSnapshot {
  path: string
  displayName: string
  markdown: string
  format: TextFormat
  version: FileVersionToken
}

export interface SaveDocumentRequest {
  path: string
  markdown: string
  format: TextFormat
  expectedVersion: FileVersionToken | null
  force?: boolean
}

export type SaveDocumentResult =
  | {
      status: 'saved'
      snapshot: DocumentSnapshot
    }
  | {
      status: 'conflict'
      snapshot: DocumentSnapshot | null
      message: string
    }
  | {
      status: 'error'
      code: string
      message: string
    }

export interface SaveDocumentAsRequest {
  markdown: string
  format: TextFormat
  suggestedName: string
  excludedPaths?: string[]
}

export interface RecoveryDraft {
  id: string
  sourcePath: string | null
  displayName: string
  markdown: string
  format: TextFormat
  expectedVersion: FileVersionToken | null
  updatedAt: string
  schemaVersion: 1
}

export interface ExternalFileChange {
  path: string
  kind: 'changed' | 'deleted'
  snapshot: DocumentSnapshot | null
}

export interface WorkspaceEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  children?: WorkspaceEntry[]
}

export interface WorkspaceSnapshot {
  rootPath: string
  displayName: string
  entries: WorkspaceEntry[]
  truncated: boolean
}

export interface WorkspaceSearchRequest {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

export interface WorkspaceSearchMatch {
  path: string
  relativePath: string
  line: number
  column: number
  preview: string
}

export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[]
  scannedFiles: number
  truncated: boolean
}

export interface ImageAssetRequest {
  fileName: string
  mimeType: string
  bytes: Uint8Array
}

export interface ImageAssetResult {
  path: string
  markdownUrl: string
}

/** Raw document snapshot. Resource paths are derived and authorized in the main process. */
export interface ResourceDocumentSnapshot {
  documentPath: string
  markdown: string
}

export interface ExportDocumentRequest {
  html: string
  markdown: string
  sourcePath: string | null
  suggestedName: string
  pdf?: import('./preferences').PdfOptions
}

export interface WorkspaceMutation {
  action: 'create-file' | 'create-directory' | 'rename' | 'delete' | 'restore'
  path?: string
  target?: string
}

export interface RecentEntry { path: string; kind: 'file' | 'directory'; pinned: boolean; openedAt: string }

export interface ExportDocumentResult {
  path: string
  warnings?: string[]
}

export type AppCommand =
  | 'layout-settings'
  | 'toggle-formatting-toolbar'
  | 'reset-layout'
  | 'font-size-up'
  | 'font-size-down'
  | 'font-size-reset'
  | 'interface-zoom-in'
  | 'interface-zoom-out'
  | 'interface-zoom-reset'
  | 'insert-media'
  | 'image-uploader'
  | 'document-conversion'
  | 'theme-library'
  | 'image-library'
  | 'undo-document'
  | 'redo-document'
  | 'command-palette'
  | 'close-document'
  | 'save-all'
  | 'toggle-split-mode'
  | 'writing-goal'
  | 'prepare-window-close'
  | 'request-draft-and-close'
  | 'open-launch'
  | 'copy-markdown'
  | 'copy-html'
  | 'copy-text'
  | 'copy-selection-markdown'
  | 'copy-selection-html'
  | 'copy-selection-text'
  | `format-${import('./formatting').FormatAction}`
  | 'new-document'
  | 'open-document'
  | 'save-document'
  | 'save-document-as'
  | 'open-workspace'
  | 'find-document'
  | 'replace-document'
  | 'quick-open'
  | 'search-workspace'
  | 'insert-image'
  | 'export-html'
  | 'export-pdf'
  | 'export-unstyled-html'
  | 'export-png'
  | 'preferences'
  | 'recent-items'
  | 'toggle-sidebar'
  | 'show-outline'
  | 'show-files'
  | 'toggle-source-mode'
  | 'toggle-focus-mode'
  | 'toggle-typewriter-mode'
  | 'request-save-and-close'

export interface WindowDocumentStatus {
  dirty: boolean
  draftId: string
  displayName: string
  documents?: { dirty: boolean; draftId: string; displayName: string }[]
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

export interface TTyporaApi {
  setInterfaceZoom: (factor: number) => Promise<void>
  setInterfaceLanguage: (locale: import('./localization').InterfaceLanguage) => Promise<void>
  chooseMediaAsset: (document: ResourceDocumentSnapshot) => Promise<import('./media').MediaAssetResult | null>
  saveMediaAsset: (document: ResourceDocumentSnapshot, request: import('./media').MediaAssetRequest) => Promise<import('./media').MediaAssetResult>
  resolveMediaUrl: (document: ResourceDocumentSnapshot, source: string) => Promise<string>
  imageUploaderSettings: () => Promise<import('./image-uploader').ImageUploaderSettings>
  listImageUploadCandidates: (request: { documentPath: string; markdown: string }) => Promise<import('./image-library').ImageLibraryItem[]>
  chooseImageUploaderExecutable: () => Promise<import('./image-uploader').ImageUploaderSettings | null>
  resetImageUploaderExecutable: () => Promise<import('./image-uploader').ImageUploaderSettings>
  configureImageUploader: (configuration: import('./image-uploader').ImageUploaderConfiguration) => Promise<import('./image-uploader').ImageUploaderSettings>
  uploadImages: (request: import('./image-uploader').ImageUploadRequest) => Promise<import('./image-uploader').ImageUploadTask>
  applyImageUploads: (request: import('./image-uploader').ApplyImageUploadsRequest) => Promise<import('./image-uploader').ApplyImageUploadsResult>
  imageUploadTask: (taskId?: string) => Promise<import('./image-uploader').ImageUploadTask | null>
  cancelImageUploads: () => void
  onImageUploadProgress: (listener: (progress: import('./image-uploader').ImageUploadProgress) => void) => () => void
  pandocStatus: () => Promise<import('./pandoc').PandocStatus>
  choosePandocExecutable: () => Promise<import('./pandoc').PandocStatus | null>
  resetPandocExecutable: () => Promise<import('./pandoc').PandocStatus>
  choosePandocReference: () => Promise<import('./pandoc').PandocStatus | null>
  configurePandocTimeout: (seconds: number) => Promise<import('./pandoc').PandocStatus>
  pandocExport: (request: import('./pandoc').PandocExportRequest) => Promise<import('./pandoc').PandocResult | null>
  pandocImport: (excludedPaths: string[]) => Promise<import('./pandoc').PandocResult | null>
  cancelPandoc: () => void
  onPandocProgress: (listener: (progress: import('./pandoc').PandocProgress) => void) => () => void
  listImages: (request: import('./image-library').ImageLibraryRequest) => Promise<import('./image-library').ImageLibrarySnapshot>
  mutateImages: (request: import('./image-library').ImageLibraryRequest & { mutation: import('./image-library').ImageLibraryMutation }) => Promise<import('./image-library').ImageLibraryMutationResult>
  performNativeEdit: (direction: 'undo' | 'redo') => void
  syncOpenDocuments: (paths: string[]) => Promise<void>
  preparePreview: (request: ExportDocumentRequest) => Promise<string>
  requestWindowClose: (cancel?: boolean) => void
  takeLaunchTarget: () => Promise<{ document?: DocumentSnapshot; workspace?: WorkspaceSnapshot } | null>
  writeClipboard: (content: { text: string; html?: string }) => Promise<void>
  prepareSelectionClipboard: (request: ExportDocumentRequest) => Promise<{ html: string; warnings: string[] }>
  mutateWorkspace: (request: WorkspaceMutation) => Promise<{ workspace: WorkspaceSnapshot; path: string | null }>
  listRecent: () => Promise<RecentEntry[]>
  openRecent: (path: string) => Promise<{ document?: DocumentSnapshot; workspace?: WorkspaceSnapshot }>
  pinRecent: (path: string) => Promise<RecentEntry[]>
  clearRecent: () => Promise<RecentEntry[]>
  openLink: (documentPath: string | null, href: string) => Promise<{ document: DocumentSnapshot; anchor: string } | null>
  exportPng: (request: ExportDocumentRequest) => Promise<ExportDocumentResult | null>
  openDocument: () => Promise<DocumentSnapshot | null>
  openWorkspace: () => Promise<WorkspaceSnapshot | null>
  refreshWorkspace: () => Promise<WorkspaceSnapshot | null>
  searchWorkspace: (
    request: WorkspaceSearchRequest,
  ) => Promise<WorkspaceSearchResult>
  openWorkspaceDocument: (filePath: string) => Promise<DocumentSnapshot>
  chooseImageAsset: (document: ResourceDocumentSnapshot) => Promise<ImageAssetResult | null>
  saveImageAsset: (
    document: ResourceDocumentSnapshot,
    request: ImageAssetRequest,
  ) => Promise<ImageAssetResult>
  resolveImageUrl: (document: ResourceDocumentSnapshot, source: string) => Promise<string>
  exportHtml: (request: ExportDocumentRequest) => Promise<ExportDocumentResult | null>
  exportPdf: (request: ExportDocumentRequest) => Promise<ExportDocumentResult | null>
  saveDocument: (request: SaveDocumentRequest) => Promise<SaveDocumentResult>
  saveDocumentAs: (
    request: SaveDocumentAsRequest,
  ) => Promise<SaveDocumentResult | null>
  updateDraft: (draft: RecoveryDraft) => Promise<void>
  clearDraft: (draftId: string) => Promise<void>
  listRecoveryDrafts: () => Promise<RecoveryDraft[]>
  restoreDraft: (draftId: string) => Promise<RecoveryDraft | null>
  confirmUnsaved: (displayName: string) => Promise<UnsavedChoice>
  setWindowDocumentStatus: (status: WindowDocumentStatus) => void
  confirmWindowClose: () => void
  onExternalFileChange: (
    listener: (change: ExternalFileChange) => void,
  ) => () => void
  onAppCommand: (listener: (command: AppCommand) => void) => () => void
}
