import { constants } from 'node:fs'
import { mkdir, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Element, Root, RootContent, Text } from 'hast'
import { normalizeFilePath } from './file-service'
import { resolveDocumentImageUrl } from './image-service'
import { resolveDocumentResourceCandidate, type DocumentResourceContext } from './document-resources'
import { createDocumentResourceReference } from './document-resource-references'
import { translate, type TranslationParams } from '../shared/localization'
import { base64Bytes, maximumEmbeddedMediaBytes, maximumEmbeddedMediaTotalBytes, maximumMediaBytes, mediaAssetRequestSchema, mediaDataBytes, mediaFormat, mediaReferenceLabel, normalizeMediaHtml, remoteMediaUrl, type MediaAssetRequest, type MediaAssetResult, type MediaExportResult, type MediaExportOptions } from '../shared/media'

function inside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
function stem(fileName: string): string { const value = path.basename(fileName, path.extname(fileName)).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100); return !value || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value) ? 'media' : value }
function documentPathFor(resources: DocumentResourceContext): string {
  if (!resources.documentPath) throw new Error('文档尚未保存，不能访问本地媒体。')
  if (resources.pathFlavor !== (process.platform === 'win32' ? 'win32' : 'posix')) throw new Error('不支持当前平台之外的媒体路径。')
  return normalizeFilePath(resources.documentPath)
}

async function destination(resources: DocumentResourceContext, fileName: string, mimeType: string) {
  const format = mediaFormat(fileName, mimeType)
  if (!format) throw new Error('不支持该音视频格式。')
  const normalized = documentPathFor(resources), directory = await realpath(path.dirname(normalized))
  const assets = path.join(path.dirname(normalized), `${path.basename(normalized, path.extname(normalized))}.assets`)
  await mkdir(assets, { recursive: true })
  const realAssets = await realpath(assets)
  if (!inside(directory, realAssets)) throw new Error('媒体资源目录超出文档目录。')
  for (let index = 0; index < 10000; index++) {
    const target = path.join(realAssets, `${stem(fileName)}${index ? `-${index}` : ''}${format.extension}`)
    // I/O follows the checked real asset directory; Markdown retains the
    // document's lexical alias. The metadata root cannot relocate the asset.
    const urlPath = path.join(assets, path.basename(target))
    const reference = createDocumentResourceReference(resources, urlPath)
    if (reference.kind !== 'reference') throw new Error('无法生成媒体引用。')
    try {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      return { handle, target, result: { path: target, markdownUrl: reference.reference, kind: format.kind, mimeType: format.mimeType, size: 0 } satisfies MediaAssetResult }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  throw new Error('无法分配可用的媒体文件名。')
}

export async function saveMediaAsset(resources: DocumentResourceContext, rawRequest: MediaAssetRequest): Promise<MediaAssetResult> {
  const request = mediaAssetRequestSchema.parse(rawRequest)
  const target = await destination(resources, request.fileName, request.mimeType)
  let success = false
  try { await target.handle.writeFile(request.bytes); await target.handle.sync(); success = true; return { ...target.result, size: request.bytes.byteLength } }
  finally { await target.handle.close(); if (!success) await unlink(target.target).catch(() => undefined) }
}

/** Caller must authorize the selected source path through a native chooser/file drop. */
export async function copyMediaAsset(resources: DocumentResourceContext, selectedPath: string): Promise<MediaAssetResult> {
  documentPathFor(resources)
  const sourcePath = await realpath(normalizeFilePath(selectedPath))
  const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let target: Awaited<ReturnType<typeof destination>> | undefined, success = false
  try {
    const before = await source.stat()
    if (!before.isFile() || !before.size || before.size > maximumMediaBytes) throw new Error('媒体须为普通文件，大小在 1 字节至 100 MB 之间。')
    target = await destination(resources, path.basename(selectedPath), '')
    let bytes = 0
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, maximumMediaBytes + 1 - bytes), bytes)
      if (!bytesRead) break
      bytes += bytesRead
      if (bytes > maximumMediaBytes) throw new Error('媒体在复制时超过 100 MB。')
      await target.handle.writeFile(buffer.subarray(0, bytesRead))
    }
    const after = await source.stat()
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('源媒体在复制期间发生变化，请重新插入。')
    await target.handle.sync(); success = true; return { ...target.result, size: bytes }
  } finally { await source.close(); if (target) { await target.handle.close(); if (!success) await unlink(target.target).catch(() => undefined) } }
}

export async function resolveDocumentMediaUrl(resources: DocumentResourceContext, source: string, authorizedRoot?: string): Promise<string> {
  const remote = remoteMediaUrl(source)
  if (remote) return remote // No request/download occurs here; renderer requires explicit activation.
  const value = source.trim()
  if (/^data:/i.test(value)) {
    if (mediaDataBytes(value) === null) throw new Error('不支持或过大的媒体数据。')
    return value
  }
  if (/^[a-z][\w+.-]*:/i.test(value) && !/^file:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error('不支持该媒体协议。')
  const documentDirectory = path.dirname(documentPathFor(resources))
  const located = resolveDocumentResourceCandidate(resources, value)
  if (located.kind !== 'local') {
    if (located.kind === 'external' || located.kind === 'unsupported' && located.reason === 'unsupported-scheme') throw new Error('不支持该媒体协议。')
    if (located.kind === 'invalid' && located.reason === 'invalid-encoding') throw new Error('媒体路径编码无效。')
    throw new Error('媒体路径或资源根设置无效或不受支持。')
  }
  if (located.pathFlavor !== (process.platform === 'win32' ? 'win32' : 'posix')) throw new Error('不支持当前平台之外的媒体路径。')
  const candidate = located.candidatePath
  if (!mediaFormat(candidate)) throw new Error('不支持该音视频格式。')
  const [root, realCandidate] = await Promise.all([realpath(authorizedRoot ?? documentDirectory), realpath(candidate)])
  if (!inside(root, realCandidate)) throw new Error('媒体不在已授权的文档目录或工作区内。')
  const info = await stat(realCandidate)
  if (!info.isFile() || !info.size || info.size > maximumMediaBytes) throw new Error('媒体须为普通文件，大小在 1 字节至 100 MB 之间。')
  return pathToFileURL(realCandidate).href
}

async function boundedRead(handle: FileHandle, limit: number): Promise<Buffer> {
  const before = await handle.stat()
  if (!before.isFile() || !before.size || before.size > limit) throw new Error('超出离线媒体嵌入上限（单文件 8 MB，总计 24 MB）。')
  const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1))
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  const after = await handle.stat()
  if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('媒体在导出期间发生变化。')
  return buffer.subarray(0, offset)
}

/** Preview uses authorized local URLs; HTML embeds within a fixed budget;
 * print keeps an identifiable, static reference instead of a native player. */
export async function embedDocumentMediaHtml(html: string, resources: DocumentResourceContext, authorizedRoot?: string, options: MediaExportOptions = {}): Promise<MediaExportResult> {
  const [{ fromHtml }, { toHtml }] = await Promise.all([import('hast-util-from-html'), import('hast-util-to-html')])
  const tree = fromHtml(normalizeMediaHtml(html)), warnings: string[] = [], embedded = new Map<string, string>()
  const mode = options.mode ?? 'embed'
  const t = (key: string, params?: TranslationParams) => translate(options.locale ?? 'zh-CN', key, params)
  let total = 0
  const text = (value: string): Text => ({ type: 'text', value })
  const embedFile = async (url: string, mimeType: string) => {
    const cached = embedded.get(url)
    if (cached) {
      const bytes = cached.slice(cached.indexOf(',') + 1), size = bytes.length / 4 * 3 - (bytes.endsWith('==') ? 2 : bytes.endsWith('=') ? 1 : 0)
      if (total + size > maximumEmbeddedMediaTotalBytes) throw new Error('超出离线媒体嵌入上限（单文件 8 MB，总计 24 MB）。')
      total += size
      return cached
    }
    const handle = await open(fileURLToPath(url), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const bytes = await boundedRead(handle, Math.min(maximumEmbeddedMediaBytes, maximumEmbeddedMediaTotalBytes - total))
      const result = `data:${mimeType};base64,${bytes.toString('base64')}`
      embedded.set(url, result); total += bytes.length
      return result
    } finally { await handle.close() }
  }
  const visit = async (node: Root | RootContent, parent?: Root | Element) => {
    if (node.type === 'element' && ['iframe', 'object', 'embed', 'applet', 'script', 'base', 'meta', 'link', 'track'].includes(node.tagName) && parent) {
      // Keep trusted export metadata, stylesheets and CSP in the document head.
      if (!['meta', 'link'].includes(node.tagName) || parent.type !== 'element' || parent.tagName !== 'head') { parent.children.splice(parent.children.indexOf(node), 1); return }
    }
    if (node.type === 'element') for (const attribute of Object.keys(node.properties)) if (/^on/i.test(attribute) || /^(?:srcdoc|autoplay)$/i.test(attribute)) delete node.properties[attribute]
    if (node.type === 'element' && node.tagName === 'source' && (parent?.type !== 'element' || !['audio', 'video'].includes(parent.tagName))) {
      delete node.properties.src; delete node.properties.srcSet; delete node.properties.dataMediaRemote
    }
    if (node.type === 'element' && (node.tagName === 'audio' || node.tagName === 'video')) {
      node.properties.controls = true; node.properties.preload = 'none'
      const references = [node, ...node.children.filter((child): child is Element => child.type === 'element' && child.tagName === 'source')]
      let playable = false
      const originals: string[] = []
      for (const reference of references) {
        const source = typeof reference.properties.src === 'string' ? reference.properties.src : typeof reference.properties.dataMediaRemote === 'string' ? reference.properties.dataMediaRemote : ''
        delete reference.properties.srcSet
        if (!source) continue
        originals.push(source)
        if (remoteMediaUrl(source)) { reference.properties.dataMediaRemote = remoteMediaUrl(source)!; delete reference.properties.src; continue }
        if (mode === 'print') { delete reference.properties.src; continue }
        try {
          if (/^data:/i.test(source)) {
            const bytes = mediaDataBytes(source)
            if (bytes === null) throw new Error('不支持或过大的媒体数据。')
            if (mode === 'embed') { if (bytes > maximumEmbeddedMediaBytes || total + bytes > maximumEmbeddedMediaTotalBytes) throw new Error('超出离线媒体嵌入上限（单文件 8 MB，总计 24 MB）。'); total += bytes }
            reference.properties.src = source; playable = true; continue
          }
          const url = await resolveDocumentMediaUrl(resources, source, authorizedRoot)
          reference.properties.src = mode === 'preview' ? url : await embedFile(url, mediaFormat(fileURLToPath(url))!.mimeType)
          playable = true
        } catch (reason) { delete reference.properties.src; warnings.push(`${mediaReferenceLabel(source)}: ${String(reason)}`) }
      }
      if (typeof node.properties.poster === 'string') {
        const poster = node.properties.poster
        try {
          if (remoteMediaUrl(poster)) delete node.properties.poster
          else if (/^data:image\//i.test(poster)) {
            // Poster data is counted as part of the standalone document budget.
            const match = poster.match(/^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml);base64,/i)
            const bytes = match ? base64Bytes(poster.slice(match[0].length)) ?? Infinity : Infinity
            if (mode === 'preview') { if (bytes > 25 * 1024 * 1024) throw new Error('封面超过预览上限。') }
            else { if (bytes > maximumEmbeddedMediaBytes || total + bytes > maximumEmbeddedMediaTotalBytes) throw new Error('封面超过嵌入上限。'); total += bytes }
          } else {
            const url = await resolveDocumentImageUrl(resources, poster, authorizedRoot)
            const extension = path.extname(fileURLToPath(url)).slice(1).toLowerCase()
            node.properties.poster = mode === 'preview' ? url : await embedFile(url, `image/${extension === 'jpg' ? 'jpeg' : extension === 'svg' ? 'svg+xml' : extension}`)
          }
        } catch (reason) { delete node.properties.poster; warnings.push(`${mediaReferenceLabel(poster)}: ${String(reason)}`) }
      }
      if ((mode === 'print' || !playable) && parent) {
        const note: Element = { type: 'element', tagName: 'figure', properties: { className: ['media-reference-placeholder'], dataMediaKind: node.tagName }, children: [] }
        if (typeof node.properties.poster === 'string') note.children.push({ type: 'element', tagName: 'img', properties: { src: node.properties.poster, alt: t('视频封面') }, children: [] })
        const sources = originals.map((source) => /^data:/i.test(source) ? t('嵌入的媒体数据') : mediaReferenceLabel(source)).join(' · ') || t('未指定源文件')
        const caption = node.tagName === 'audio' ? mode === 'print' ? '音频引用：{sources}（在原文档中播放）' : '音频引用：{sources}（源媒体需单独提供）' : mode === 'print' ? '视频引用：{sources}（在原文档中播放）' : '视频引用：{sources}（源媒体需单独提供）'
        note.children.push({ type: 'element', tagName: 'figcaption', properties: {}, children: [text(t(caption, { sources }))] })
        for (const source of originals) { const remote = remoteMediaUrl(source); if (remote) note.children.push({ type: 'element', tagName: 'a', properties: { href: remote, rel: ['noopener', 'noreferrer'] }, children: [text(t('打开远程媒体'))] }) }
        const index = parent.children.indexOf(node); parent.children.splice(index, 1, note)
        return
      }
    }
    if ('children' in node) for (const child of [...node.children]) await visit(child, node)
  }
  await visit(tree)
  return { html: toHtml(tree), warnings, embeddedBytes: total }
}
