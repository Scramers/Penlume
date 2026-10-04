import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import { buildImageUploaderArguments, imageUploaderSettingsSchema, imageUploaderConfigurationSchema, imageUploadRequestSchema, applyImageUploadsSchema, type ImageUploaderSettings, type ImageUploaderConfiguration, type ImageUploadRequest, type ImageUploadTask, type ImageUploadProgress, type ImageUploadItem, type ApplyImageUploadsRequest, type ApplyImageUploadsResult } from '../shared/image-uploader'
import type { ImageLibraryItem, ImageLibraryVersion } from '../shared/image-library'
import { findImageReferences, rewriteImageUrls } from './image-library'
import { createDocumentResourceContext, resolveDocumentResourceCandidate, type DocumentResourceContext } from './document-resources'

const imageLimit = 25 * 1024 * 1024, batchLimit = 256 * 1024 * 1024
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'])
function samePath(a: string, b: string): boolean { return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b) }
function inside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) }
function sameVersion(a: ImageLibraryVersion, b: ImageLibraryVersion): boolean { return samePath(a.path, b.path) && a.sha256 === b.sha256 && a.size === b.size && a.mtimeMs === b.mtimeMs }
function uploadUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f<>"\\]/.test(value)) return null
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null; return url.href } catch { return null }
}
/** Accept result fields and URL lines, never interpret uploader output as argv or shell code. */
export function parseImageUploaderOutput(stdout: string): string[] {
  const text = stdout.replace(/\u001b\[[\d;]*[a-z]/gi, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const urls = new Set<string>()
  let explicitFailure = false
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8) return
    if (typeof value === 'string') { const safe = uploadUrl(value); if (safe) urls.add(safe); return }
    if (Array.isArray(value)) { value.forEach((entry) => visit(entry, depth + 1)); return }
    if (!value || typeof value !== 'object') return
    const result = value as Record<string, unknown>
    if (result.success === false || result.status === 'error' || result.status === 'failed') { explicitFailure = true; return }
    for (const key of ['url', 'urls', 'imgUrl', 'imageUrl', 'result', 'data']) if (key in result) visit(result[key], depth + 1)
  }
  const parse = (candidate: string): boolean => { try { visit(JSON.parse(candidate)); return true } catch { return false } }
  if (!parse(text.trim())) for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (parse(value)) continue
    const json = value.match(/(?:SUCCESS|上传成功).*?(\{.*\}|\[.*\])$/i)?.[1]
    if (json && parse(json)) continue
    const candidate = value.match(/^(?:\[(?:PicGo|PicList)\s+SUCCESS\]\s*:?[\s]*|(?:Uploaded|Upload success|URL|上传成功)\s*[:：]\s*)?(https?:\/\/\S+)$/i)?.[1]
    const safe = uploadUrl(candidate); if (safe) urls.add(safe)
  }
  return explicitFailure ? [] : [...urls]
}
export async function runImageUploader(executable: string, args: string[], options: { cwd: string; timeoutMs: number; signal: AbortSignal }): Promise<string> {
  if (options.signal.aborted) throw new Error('上传已取消。')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', diagnostics = '', outputBytes = 0, diagnosticBytes = 0, stopReason: Error | null = null, done = false
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8')
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => { if (stopReason) return; stopReason = error; child.kill(); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000) }
    const cancel = () => stop(new Error('上传已取消。'))
    const timer = setTimeout(() => stop(new Error('上传超时。')), options.timeoutMs)
    options.signal.addEventListener('abort', cancel, { once: true })
    const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(killTimer); options.signal.removeEventListener('abort', cancel); if (error) reject(error); else resolve(output) }
    child.stdout.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 1024 * 1024) stop(new Error('上传器输出超过限制。')); else output += stdoutDecoder.write(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > 1024 * 1024) stop(new Error('上传器诊断超过限制。')); else diagnostics += stderrDecoder.write(chunk) })
    child.once('error', (error) => finish(new Error(`无法启动上传器：${error.message}`)))
    child.once('close', (code) => { output += stdoutDecoder.end(); diagnostics += stderrDecoder.end(); finish(stopReason ?? (code === 0 ? undefined : new Error(`上传器失败（${code ?? '进程终止'}）：${diagnostics.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(-1500) || '没有错误详情'}`))) })
    if (options.signal.aborted) cancel()
  })
}
function isImage(bytes: Buffer, extension: string): boolean {
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (['.jpg', '.jpeg'].includes(extension)) return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (extension === '.gif') return /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))
  if (extension === '.webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
  if (extension === '.bmp') return bytes.subarray(0, 2).toString() === 'BM'
  if (extension === '.avif') return bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 64).toString('ascii'))
  if (extension === '.svg') return /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(bytes.subarray(0, 4096).toString('utf8'))
  return false
}
async function authorizedImagePath(root: string, filePath: string): Promise<string> {
  if (!inside(root, filePath)) throw new Error('图片超出已授权目录。')
  let current = root
  for (const component of path.relative(root, filePath).split(path.sep).filter(Boolean)) { current = path.join(current, component); if ((await lstat(current)).isSymbolicLink()) throw new Error('图片路径含符号链接。') }
  const actual = await realpath(filePath)
  if (!inside(root, actual) || !(await stat(actual)).isFile() || !imageExtensions.has(path.extname(actual).toLowerCase())) throw new Error('图片不是授权目录内受支持的普通图片文件。')
  return actual
}
async function imageBytes(root: string, filePath: string): Promise<{ bytes: Buffer; version: ImageLibraryVersion }> {
  const actual = await authorizedImagePath(root, filePath)
  const handle = await open(actual, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size === 0 || before.size > imageLimit) throw new Error('图片须为非空普通文件，大小不超过 25 MB。')
    const bounded = Buffer.alloc(before.size + 1)
    let received = 0
    while (received < bounded.length) { const { bytesRead } = await handle.read(bounded, received, Math.min(65536, bounded.length - received), received); if (!bytesRead) break; received += bytesRead }
    const after = await handle.stat(), bytes = bounded.subarray(0, received)
    if (received !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('读取期间图片发生变化。')
    const afterPath = await lstat(actual), resolvedAfter = await realpath(actual)
    if (afterPath.isSymbolicLink() || afterPath.dev !== after.dev || afterPath.ino !== after.ino || !samePath(resolvedAfter, actual) || afterPath.size !== after.size || afterPath.mtimeMs !== after.mtimeMs) throw new Error('读取期间图片路径发生变化。')
    if (!isImage(bytes, path.extname(actual).toLowerCase())) throw new Error('文件内容不是受支持的图片。')
    return { bytes, version: { path: actual, size: bytes.length, mtimeMs: after.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex') } }
  } finally { await handle.close() }
}
interface UploadSource { id: string; name: string; path: string; urls: string[]; references: number }
function resourceIdentity(context: DocumentResourceContext): string {
  // Root syntax/status and the logical document location are frozen independently
  // of editable body text. A title/body edit is not a change of resource meaning.
  return createHash('sha256').update(JSON.stringify(context)).digest('hex')
}
/** Keep identity compatible with the image library, without reading unrelated assets or documents. */
async function documentSources(root: string, documentPath: string, markdown: string): Promise<{ documentPath: string; logicalDocumentPath: string; directory: string; resources: DocumentResourceContext; images: Map<string, UploadSource> }> {
  const resources = createDocumentResourceContext(documentPath, markdown)
  if (!resources.documentPath || resources.pathFlavor !== (process.platform === 'win32' ? 'win32' : 'posix')) throw new Error('文档路径须为本机绝对路径。')
  const document = await realpath(path.resolve(documentPath)), directory = path.dirname(document)
  if (!inside(root, document) || !(await stat(document)).isFile()) throw new Error('文档不在已授权目录内。')
  const images = new Map<string, UploadSource>()
  for (const reference of await findImageReferences(markdown)) {
    const located = resolveDocumentResourceCandidate(resources, reference.url)
    if (located.kind !== 'local' || located.pathFlavor !== (process.platform === 'win32' ? 'win32' : 'posix')) continue
    const candidate = located.candidatePath
    const normalized = process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate)
    const id = createHash('sha256').update(`local:${normalized}`).digest('hex').slice(0, 32)
    const source = images.get(id) ?? { id, name: path.basename(candidate), path: candidate, urls: [], references: 0 }
    if (!source.urls.includes(reference.url)) source.urls.push(reference.url)
    source.references += 1; images.set(id, source)
  }
  return { documentPath: document, logicalDocumentPath: resources.documentPath, directory, resources, images }
}
export async function listImageUploadCandidates(documentPath: string, markdown: string, authorizedRoot?: string): Promise<ImageLibraryItem[]> {
  const root = await realpath(authorizedRoot ?? path.dirname(documentPath)), current = await documentSources(root, documentPath, markdown)
  const assets = path.join(current.directory, `${path.basename(current.documentPath, path.extname(current.documentPath))}.assets`), result: ImageLibraryItem[] = []
  for (const source of current.images.values()) {
    try {
      const { version } = await imageBytes(root, source.path)
      result.push({ ...source, path: version.path, status: 'local', version, size: version.size, previewUrl: pathToFileURL(version.path).href, inAssets: inside(assets, version.path), message: null })
    } catch { /* Missing, changed, oversized and unauthorized resources are not upload candidates. */ }
  }
  return result
}
interface Receipt { owner: number; root: string; actualDocumentPath: string; resourceIdentity: string; task: ImageUploadTask }
export class ImageUploaderService {
  private settings = imageUploaderSettingsSchema.parse({})
  private active = new Map<number, AbortController>()
  private receipts = new Map<string, Receipt>()
  constructor(private readonly settingsPath: string) {}
  async load(): Promise<void> { try { this.settings = imageUploaderSettingsSchema.parse(JSON.parse(await readFile(this.settingsPath, 'utf8'))) } catch { this.settings = imageUploaderSettingsSchema.parse({}) } }
  getSettings(): ImageUploaderSettings { return structuredClone(this.settings) }
  async configure(change: ImageUploaderConfiguration): Promise<ImageUploaderSettings> { return this.persist(imageUploaderSettingsSchema.parse({ ...this.settings, ...imageUploaderConfigurationSchema.parse(change) })) }
  async selectExecutable(selectedPath: string | null): Promise<ImageUploaderSettings> {
    let executablePath: string | null = null
    if (selectedPath) {
      if (process.platform === 'win32' && !/\.(exe|com)$/i.test(selectedPath)) throw new Error('请选择真实可执行程序；.cmd/.bat 需要 shell，不能直接使用。Node CLI 请选 node.exe 并把脚本路径放入参数数组。')
      executablePath = await realpath(selectedPath); if (!(await stat(executablePath)).isFile()) throw new Error('上传器不是普通程序文件。'); await access(executablePath, constants.X_OK)
    }
    return this.persist({ ...this.settings, executablePath })
  }
  private async persist(settings: ImageUploaderSettings): Promise<ImageUploaderSettings> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true })
    const temporary = this.settingsPath + '.' + randomUUID() + '.tmp'
    try { await writeFile(temporary, JSON.stringify(settings), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.settingsPath); this.settings = settings; return this.getSettings() } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }
  cancel(owner: number): void { this.active.get(owner)?.abort() }
  private emit(task: ImageUploadTask, progress: (event: ImageUploadProgress) => void, message: string): void { try { progress({ task: structuredClone(task), total: task.items.length, completed: task.items.filter((item) => ['success', 'failed', 'cancelled'].includes(item.status)).length, message }) } catch { /* Notification failure must not discard partial results. */ } }
  async getTask(owner: number, taskId?: string): Promise<ImageUploadTask | null> {
    const receipt = taskId ? this.receipts.get(taskId) : [...this.receipts.values()].reverse().find((item) => item.owner === owner)
    if (!receipt || receipt.owner !== owner) return null
    for (const item of receipt.task.items.filter((entry) => entry.status === 'success')) { try { item.sourceChanged = !sameVersion((await imageBytes(receipt.root, item.sourcePath)).version, item.version) } catch { item.sourceChanged = true } }
    return structuredClone(receipt.task)
  }
  async upload(owner: number, input: ImageUploadRequest, authorizedRoot?: string, progress: (event: ImageUploadProgress) => void = () => {}): Promise<ImageUploadTask> {
    if (this.active.has(owner)) throw new Error('当前窗口已有图片上传任务。')
    const controller = new AbortController()
    this.active.set(owner, controller)
    try { return await this.performUpload(owner, input, authorizedRoot, progress, controller) } finally { this.active.delete(owner) }
  }
  private async performUpload(owner: number, input: ImageUploadRequest, authorizedRoot: string | undefined, progress: (event: ImageUploadProgress) => void, controller: AbortController): Promise<ImageUploadTask> {
    const request = imageUploadRequestSchema.parse(input), settings = this.getSettings()
    if (!settings.executablePath) throw new Error('尚未配置上传器；请选择程序并保存参数后，再明确点击上传。')
    const root = await realpath(authorizedRoot ?? path.dirname(request.documentPath))
    const current = await documentSources(root, request.documentPath, request.markdown)
    const selected = [...new Map(request.images.map((image) => [image.imageId, image])).values()]
    const items: ImageUploadItem[] = []
    for (const selectedImage of selected) {
      const source = current.images.get(selectedImage.imageId)
      if (!source) throw new Error('只能上传当前文档引用的已授权本地图片。')
      let sourcePath: string
      try { sourcePath = await authorizedImagePath(root, source.path) } catch { throw new Error('只能上传当前文档引用的已授权本地图片。') }
      items.push({ id: randomUUID(), imageId: source.id, name: source.name, sourcePath, sourceUrls: source.urls, version: selectedImage.expectedVersion, status: 'queued', url: null, error: null, sourceChanged: false })
    }
    const task: ImageUploadTask = { id: randomUUID(), documentPath: current.logicalDocumentPath, createdAt: new Date().toISOString(), status: 'running', items }
    this.receipts.set(task.id, { owner, root, actualDocumentPath: current.documentPath, resourceIdentity: resourceIdentity(current.resources), task })
    let stage: string
    try { stage = await mkdtemp(path.join(os.tmpdir(), 'ttypora-image-upload-')) }
    catch (error) { task.status = 'complete'; for (const item of task.items) { item.status = 'failed'; item.error = '无法创建安全的上传暂存目录。' } this.emit(task, progress, '无法准备上传，文档与本地图片保持原样。'); throw error }
    const frozen = new Map<string, string>()
    try {
      let frozenBytes = 0
      for (const item of task.items) {
        if (controller.signal.aborted) break
        item.status = 'freezing'; this.emit(task, progress, `正在冻结 ${item.name}…`)
        try {
          const original = await imageBytes(root, item.sourcePath)
          if (!sameVersion(original.version, item.version)) throw new Error('图片已被其他程序修改，请刷新资源列表后重试。')
          if (frozenBytes + original.bytes.length > batchLimit) throw new Error('本批冻结图片总量超过 256 MB。')
          const directory = path.join(stage, item.id); await mkdir(directory)
          const destination = path.join(directory, item.name); await writeFile(destination, original.bytes, { flag: 'wx', mode: 0o600 })
          if (!sameVersion((await imageBytes(root, item.sourcePath)).version, original.version)) throw new Error('冻结期间图片发生变化，已停止该图片上传。')
          frozenBytes += original.bytes.length; frozen.set(item.id, destination)
        } catch (error) { item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error) }
      }
      for (const item of task.items) {
        if (controller.signal.aborted) break
        const copy = frozen.get(item.id); if (!copy) continue
        item.status = 'uploading'; this.emit(task, progress, `正在上传 ${item.name}…`)
        try {
          const output = await runImageUploader(settings.executablePath, buildImageUploaderArguments(settings, copy), { cwd: stage, timeoutMs: settings.timeoutSeconds * 1000, signal: controller.signal })
          const urls = parseImageUploaderOutput(output)
          if (urls.length !== 1) throw new Error(urls.length ? '上传器返回多个不同 URL，无法安全确定当前图片的结果。' : '上传器没有返回可用的 HTTP(S) 图片 URL。')
          item.url = urls[0]; item.status = 'success'
          try { item.sourceChanged = !sameVersion((await imageBytes(root, item.sourcePath)).version, item.version) } catch { item.sourceChanged = true }
        } catch (error) { item.status = controller.signal.aborted ? 'cancelled' : 'failed'; item.error = error instanceof Error ? error.message : String(error) }
        this.emit(task, progress, `${item.name}：${item.status === 'success' ? '上传成功，等待选择应用' : item.error}`)
      }
      task.status = controller.signal.aborted ? 'cancelled' : 'complete'
      for (const item of task.items.filter((entry) => ['queued', 'freezing', 'uploading'].includes(entry.status))) { item.status = 'cancelled'; item.error = '上传已取消。' }
      this.emit(task, progress, task.status === 'cancelled' ? '已取消；成功结果保留供检查。' : '上传任务完成，请逐项选择要应用的结果。')
      return structuredClone(task)
    } finally {
      await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      const old = [...this.receipts.entries()].filter(([, receipt]) => receipt.owner === owner && receipt.task.id !== task.id && receipt.task.status !== 'running'); for (const [id] of old.slice(0, Math.max(0, old.length - 19))) this.receipts.delete(id)
    }
  }
  async apply(owner: number, input: ApplyImageUploadsRequest): Promise<ApplyImageUploadsResult> {
    const request = applyImageUploadsSchema.parse(input), receipt = this.receipts.get(request.taskId)
    if (!receipt || receipt.owner !== owner || !samePath(receipt.task.documentPath, request.documentPath)) throw new Error('上传结果不属于当前窗口和文档。')
    if (receipt.task.status === 'running') throw new Error('请等待上传任务结束后检查结果。')
    // Do this before resolving/reading current sources. Surviving absolute file
    // aliases and allowChangedOriginals cannot authorize a different YAML root.
    const resources = createDocumentResourceContext(request.documentPath, request.markdown)
    if (resourceIdentity(resources) !== receipt.resourceIdentity) throw new Error('文档的图片资源根或保存位置已改变，请重新上传并检查结果。')
    const selected = [...new Set(request.selectedItemIds)].map((id) => receipt.task.items.find((item) => item.id === id))
    if (selected.some((item) => !item || item.status !== 'success' || !uploadUrl(item.url))) throw new Error('只能应用已成功且经过检查的图片结果。')
    const replacements = new Map<string, string>()
    let references = 0, appliedImages = 0
    const current = await documentSources(receipt.root, request.documentPath, request.markdown)
    if (!samePath(current.documentPath, receipt.actualDocumentPath)) throw new Error('文档的保存位置在上传后改变，请重新上传并检查结果。')
    for (const item of selected as ImageUploadItem[]) {
      const source = current.images.get(item.imageId)
      if (!source) throw new Error(`图片引用已改变：${item.name}，请重新检查。`)
      let changed = true; try { changed = !sameVersion((await imageBytes(receipt.root, item.sourcePath)).version, item.version) } catch { /* Explicit review may apply a frozen version after the original was removed. */ }
      if (changed && !request.allowChangedOriginals.includes(item.id)) throw new Error(`原图在上传后发生变化：${item.name}。请刷新结果并明确选择上传时的冻结版本。`)
      source.urls.forEach((url) => replacements.set(url, item.url!)); references += source.references; appliedImages += 1
    }
    return { markdown: await rewriteImageUrls(request.markdown, replacements), appliedImages, replacedReferences: references, notice: `已应用 ${appliedImages} 张图片的上传 URL，更新 ${references} 处图片引用；本地原件保留，可通过文档撤销恢复。` }
  }
}
