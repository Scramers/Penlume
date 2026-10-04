import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pandocFormats, pandocImportFormats, pandocSettingsSchema, validatePandocArguments, type PandocExportRequest, type PandocProgress, type PandocResult, type PandocSettings, type PandocStatus } from '../shared/pandoc'
import { resolveDocumentImageUrl } from './image-service'
import { fileURLToPath } from 'node:url'
import { readDocumentSnapshot, saveDocumentAtomically } from './file-service'
import { findImageReferences, rewriteImageUrls } from './image-library'
import { sanitizePandocInput, sanitizePandocHtmlOutput } from './pandoc-html'
import { normalizeMarkdownForPandoc } from '../shared/markdown-extensions'
import { createDocumentResourceContext, type DocumentResourceContext } from './document-resources'

const maximumInput = 100 * 1024 * 1024
const maximumOutput = 100 * 1024 * 1024
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface RunOptions { cwd?: string; timeoutMs?: number; signal?: AbortSignal }
export async function runPandoc(executable: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new Error('转换已取消。')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', settled = false, stopped: Error | null = null
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel)
      if (error) reject(error); else resolve({ stdout, stderr })
    }
    const stop = (error: Error) => { stopped ??= error; child.kill() }
    const cancel = () => stop(new Error('转换已取消。'))
    const timer = setTimeout(() => stop(new Error('转换超时，原文件和现有导出文件均已保留。')), options.timeoutMs ?? 90_000)
    options.signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > 2 * 1024 * 1024) stop(new Error('转换输出过多，已停止。')) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); if (stderr.length > 2 * 1024 * 1024) stop(new Error('转换诊断过多，已停止。')) })
    child.on('error', (error) => finish(new Error(`无法运行 Pandoc：${error.message}`)))
    child.on('close', (code) => finish(stopped ?? (code === 0 ? undefined : new Error(`Pandoc 转换失败（${code ?? '进程终止'}）：${stderr.trim().slice(0, 6000) || '没有错误详情'}`))))
  })
}

export class PandocService {
  private settings: PandocSettings = pandocSettingsSchema.parse({})
  private active = new Map<number, AbortController>()
  constructor(private readonly settingsPath: string, private readonly bundledExecutable?: string) {}
  async load(): Promise<void> { try { this.settings = pandocSettingsSchema.parse(JSON.parse(await readFile(this.settingsPath, 'utf8'))) } catch { this.settings = pandocSettingsSchema.parse({}) } }
  async configure(change: Partial<PandocSettings>): Promise<void> {
    const next = pandocSettingsSchema.parse({ ...this.settings, ...change })
    await mkdir(path.dirname(this.settingsPath), { recursive: true })
    const temporary = this.settingsPath + '.' + randomUUID() + '.tmp'
    try { await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temporary, this.settingsPath); this.settings = next } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }
  async detect(): Promise<PandocStatus> {
    const candidates: { executable: string; source: PandocStatus['source'] }[] = []
    if (this.settings.executablePath) candidates.push({ executable: this.settings.executablePath, source: 'configured' })
    else {
      if (this.bundledExecutable) candidates.push({ executable: this.bundledExecutable, source: 'bundled' })
      for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) candidates.push({ executable: path.join(directory, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc'), source: 'system' })
    }
    let failure = ''
    for (const candidate of candidates) {
      try {
        await access(candidate.executable, constants.X_OK)
        if (!(await stat(candidate.executable)).isFile()) continue
        const executable = await realpath(candidate.executable)
        const version = (await runPandoc(executable, ['--version'], { timeoutMs: 7000 })).stdout.split(/\r?\n/)[0]
        if (!/^pandoc\s+\d/i.test(version)) throw new Error('该程序没有返回 Pandoc 版本。')
        return { available: true, version, executablePath: executable, source: candidate.source, message: '可以离线转换文档', settings: this.settings }
      } catch (error) { if (candidate.source === 'configured') failure = String(error) }
    }
    return { available: false, version: null, executablePath: null, source: null, message: failure || '尚未找到 Pandoc。请选择程序文件，或将 Pandoc 加入系统 PATH。', settings: this.settings }
  }
  cancel(owner: number): void { this.active.get(owner)?.abort() }
  async job<T>(owner: number, operation: (executable: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active.has(owner)) throw new Error('当前窗口已有转换正在进行。')
    const controller = new AbortController(); this.active.set(owner, controller)
    try { const status = await this.detect(); if (!status.executablePath) throw new Error(status.message); if (controller.signal.aborted) throw new Error('转换已取消。'); return await operation(status.executablePath, controller.signal) } finally { this.active.delete(owner) }
  }
  private async stage(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), 'ttypora-pandoc-')) }
  private async readInput(filePath: string): Promise<Buffer> { const info = await stat(filePath); if (!info.isFile() || info.size > maximumInput) throw new Error('导入文件须为普通文件，大小不超过 100 MB。'); return readFile(filePath) }
  private async destinationHash(filePath: string): Promise<string | null> { try { if ((await lstat(filePath)).isSymbolicLink()) throw new Error('转换输出不能覆盖符号链接。'); const info = await stat(filePath); if (!info.isFile() || info.size > maximumOutput) throw new Error('输出目标不是可覆盖的普通文件。'); return hash(await readFile(filePath)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } }
  async exportDocument(owner: number, request: PandocExportRequest, destination: string, authorizedRoot?: string, progress: (progress: PandocProgress) => void = () => {}): Promise<PandocResult> {
    // Resolve every resource against the current, unmodified editor snapshot.
    // Normalization/sanitization may alter metadata; its base never grants access.
    const rawMarkdown = request.markdown
    const resources = createDocumentResourceContext(request.sourcePath, rawMarkdown)
    const args = validatePandocArguments(request.options.extraArgs)
    const format = pandocFormats.find((format) => format.id === request.format)
    if (!format) throw new Error('不支持的导出格式。')
    if (request.sourcePath && path.resolve(request.sourcePath).toLocaleLowerCase() === path.resolve(destination).toLocaleLowerCase()) throw new Error('导出不能覆盖当前 Markdown 原文件。')
    const expected = await this.destinationHash(destination)
    return this.job(owner, async (executable, signal) => {
      progress({ stage: 'preparing', message: '正在准备文档与图片…' })
      const stage = await this.stage()
      let temporary: string | null = null
      try {
        // Explicit local references must reach authorization before the sanitizer
        // removes file/drive protocols. Only authorized raster files become data;
        // the complete result is still sanitized before Pandoc's sandbox sees it.
        const inputWarnings: string[] = []
        const normalizedInput = await normalizeMarkdownForPandoc(rawMarkdown, request.extensions)
        const { markdown: embeddedInput, warnings } = await this.embedImages(normalizedInput, resources, authorizedRoot)
        const markdown = await sanitizePandocInput(embeddedInput, (warning) => inputWarnings.push(warning))
        const input = path.join(stage, 'input.md'), output = path.join(stage, 'output.' + format.extension)
        await writeFile(input, markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        // Match the CommonMark/GFM parser used by the editor and sanitizer. The
        // legacy Markdown reader reinterprets some valid tilde code fences as HTML.
        const reader = 'gfm-emoji+tex_math_dollars-tex_math_gfm+pipe_tables+task_lists+strikeout+yaml_metadata_block+footnotes-raw_attribute' + (request.extensions.superscript ? '+superscript' : '-superscript') + (request.extensions.subscript ? '+subscript' : '-subscript')
        const writer = request.format === 'gfm' ? 'gfm-tex_math_gfm' : request.format
        const command = ['--sandbox', '--from=' + reader, '--to=' + writer, '--wrap=none', '--output=' + output, ...args]
        if (request.options.standalone) command.push('--standalone')
        if (request.options.toc) command.push('--toc')
        if (request.options.numberedSections) command.push('--number-sections')
        if (request.options.useReferenceDocument && request.format === 'docx') {
          if (!this.settings.referenceDocumentPath) throw new Error('请先选择 Word 参考样式文档。')
          const reference = path.join(stage, 'reference.docx'); await writeFile(reference, await this.readInput(this.settings.referenceDocumentPath), { mode: 0o600 }); command.push('--reference-doc=' + reference)
        }
        command.push(input)
        progress({ stage: 'converting', message: '正在转换为 ' + format.label + '…' })
        const result = await runPandoc(executable, command, { cwd: stage, timeoutMs: this.settings.timeoutSeconds * 1000, signal })
        if (signal.aborted) throw new Error('转换已取消。')
        if ((await stat(output)).size > maximumOutput) throw new Error('转换结果超过 100 MB，未覆盖目标文件。')
        const rawBytes = await readFile(output)
        const bytes = request.format === 'html5' ? Buffer.from(await sanitizePandocHtmlOutput(rawBytes.toString('utf8')), 'utf8') : rawBytes
        if (!bytes.length) throw new Error('转换结果为空，未覆盖目标文件。')
        progress({ stage: 'writing', message: '正在安全写入输出文件…' })
        temporary = path.join(path.dirname(destination), '.' + path.basename(destination) + '.' + randomUUID() + '.tmp')
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        if (signal.aborted) throw new Error('转换已取消。')
        if ((await this.destinationHash(destination)) !== expected) throw new Error('转换期间输出文件发生外部修改，已保留外部版本。')
        await rename(temporary, destination); temporary = null
        progress({ stage: 'complete', message: '已导出：' + destination })
        return { path: destination, warnings: [...inputWarnings, warnings, result.stderr.trim()].filter(Boolean).join('\n') }
      } finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); await rm(stage, { recursive: true, force: true }) }
    })
  }
  private async embedImages(markdown: string, resources: DocumentResourceContext, authorizedRoot?: string): Promise<{ markdown: string; warnings: string }> {
    if (!resources.documentPath) return { markdown, warnings: '' }
    const sources = new Set((await findImageReferences(markdown)).map((reference) => reference.url))
    const replacements = new Map<string, string>(), warnings: string[] = []
    let embeddedBytes = Buffer.byteLength(markdown, 'utf8')
    for (const source of sources) {
      if (/^(https?:|data:|blob:)/i.test(source)) continue
      try {
        // findImageReferences already parsed Markdown/HTML entities exactly once.
        const imagePath = fileURLToPath(await resolveDocumentImageUrl(resources, source, authorizedRoot))
        const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp' } as Record<string, string>)[path.extname(imagePath).toLowerCase()]
        if (!mime) { warnings.push('此转换格式未嵌入图片：' + source); continue }
        const info = await stat(imagePath); if (info.size > 25 * 1024 * 1024) throw new Error('图片超过 25 MB')
        const estimatedBytes = Math.ceil(info.size / 3) * 4
        if (embeddedBytes + estimatedBytes > maximumInput) throw new Error('图片总量超过转换输入上限')
        embeddedBytes += estimatedBytes
        replacements.set(source, `data:${mime};base64,${(await readFile(imagePath)).toString('base64')}`)
      } catch { warnings.push('未能嵌入图片：' + source) }
    }
    const output = await rewriteImageUrls(markdown, replacements)
    return { markdown: output, warnings: warnings.join('\n') }
  }
  async importDocument(owner: number, origin: string, destination: string, progress: (progress: PandocProgress) => void = () => {}): Promise<PandocResult> {
    const extension = path.extname(origin).slice(1).toLowerCase(), format = pandocImportFormats[extension]
    if (!format) throw new Error('该文件格式暂不支持导入。')
    if (path.resolve(origin).toLocaleLowerCase() === path.resolve(destination).toLocaleLowerCase()) throw new Error('导入须保存为独立 Markdown 文档。')
    const expected = await this.destinationHash(destination)
    return this.job(owner, async (executable, signal) => {
      const stage = await this.stage()
      let movedAssets: string | null = null
      try {
        progress({ stage: 'preparing', message: '正在读取原文档…' })
        const input = path.join(stage, 'input.' + extension), output = path.join(stage, 'converted.md')
        await writeFile(input, await this.readInput(origin), { mode: 0o600, flag: 'wx' })
        let assetName = path.basename(destination, path.extname(destination)) + '.assets'
        for (let suffix = 1; await stat(path.join(path.dirname(destination), assetName)).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error }); suffix++) assetName = path.basename(destination, path.extname(destination)) + '.' + suffix + '.assets'
        progress({ stage: 'converting', message: '正在转换为 Markdown…' })
        const result = await runPandoc(executable, ['--sandbox', '--from=' + format, '--to=gfm+tex_math_dollars-tex_math_gfm+footnotes+superscript+subscript', '--wrap=none', '--extract-media=' + assetName, '--output=' + output, input], { cwd: stage, timeoutMs: this.settings.timeoutSeconds * 1000, signal })
        if (signal.aborted) throw new Error('转换已取消。')
        if ((await stat(output)).size > 20 * 1024 * 1024) throw new Error('转换后的 Markdown 超过 20 MB。')
        const markdown = await readFile(output, 'utf8')
        if ((await this.destinationHash(destination)) !== expected) throw new Error('转换期间目标 Markdown 发生外部修改，已保留外部版本。')
        progress({ stage: 'writing', message: '正在保存 Markdown 与图片资源…' })
        const stagedAssets = path.join(stage, assetName)
        if (await stat(stagedAssets).then(() => true, () => false)) {
          movedAssets = path.join(path.dirname(destination), assetName)
          // Exclusive reservation prevents an import racing an existing resource folder.
          await mkdir(movedAssets)
          try { await this.moveExtractedAssets(stagedAssets, movedAssets) } catch (error) { throw new Error(`资源提取失败，已有文档保持不变：${String(error)}`) }
        }
        if (signal.aborted) throw new Error('转换已取消。')
        const existing = expected ? await readDocumentSnapshot(destination) : null
        if (existing && existing.version.sha256 !== expected) throw new Error('目标 Markdown 发生外部修改。')
        const saved = await saveDocumentAtomically({ path: destination, markdown, format: { hasBom: false, lineEnding: 'lf' }, expectedVersion: existing?.version ?? null })
        if (saved.status !== 'saved') throw new Error(saved.message + (movedAssets ? ' 提取的资源已保留于 ' + movedAssets : ''))
        progress({ stage: 'complete', message: '已导入：' + destination })
        return { path: destination, snapshot: saved.snapshot, warnings: result.stderr.trim() }
      } finally { await rm(stage, { recursive: true, force: true }) }
    })
  }
  private async moveExtractedAssets(source: string, destination: string): Promise<void> {
    const { readdir } = await import('node:fs/promises')
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('转换资源包含不支持的文件类型。')
      const from = path.join(source, entry.name), to = path.join(destination, entry.name)
      if (entry.isDirectory()) { await mkdir(to); await this.moveExtractedAssets(from, to) }
      else { const handle = await open(to, 'wx', 0o600); try { await handle.writeFile(await readFile(from)) } finally { await handle.close() } }
    }
  }
}
