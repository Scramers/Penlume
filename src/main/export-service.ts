import { randomUUID } from 'node:crypto'
import { open, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow } from 'electron'
import { resolveDocumentImageUrl } from './image-service'
import { embedDocumentMediaHtml } from './media-service'
import type { DocumentResourceContext } from './document-resources'
import type { MediaExportResult } from '../shared/media'
import { pdfOptionsSchema, type PdfOptions } from '../shared/preferences'
import type { InterfaceLanguage } from '../shared/localization'
import { translate } from '../shared/localization'
import type { Root, RootContent } from 'hast'

function escapeText(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }

const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
])

function isRemoteOrEmbedded(source: string): boolean {
  return /^(https?:|data:|blob:)/i.test(source)
}

export async function embedLocalImages(
  html: string,
  resources: DocumentResourceContext,
  authorizedRoot?: string,
): Promise<string> {
  return (await prepareDocumentImages(html, resources, authorizedRoot)).html
}

async function prepareDocumentImages(html: string, resources: DocumentResourceContext, authorizedRoot?: string, mode: 'embed' | 'preview' | 'print' = 'embed', locale: InterfaceLanguage = 'zh-CN') {
  const [{ fromHtml }, { toHtml }] = await Promise.all([import('hast-util-from-html'), import('hast-util-to-html')])
  const tree = fromHtml(html), cache = new Map<string, { url: string; size: number } | null>(), warnings: string[] = []
  let outputBytes = 0
  const resolve = async (source: string) => {
    if (cache.has(source)) return cache.get(source)!
    let result: { url: string; size: number } | null = null
    try {
      const fileUrl = await resolveDocumentImageUrl(resources, source, authorizedRoot)
      const filePath = fileURLToPath(fileUrl), mimeType = IMAGE_MIME.get(path.extname(filePath).toLowerCase())
      if (!mimeType) throw new Error('Unsupported image.')
      const handle = await open(filePath, 'r')
      try {
        const before = await handle.stat()
        if (!before.isFile() || !before.size || before.size > 25 * 1024 * 1024) throw new Error('Image exceeds embedding limit.')
        if (mode === 'preview') result = { url: fileUrl, size: 0 }
        else {
          if (outputBytes + before.size > 100 * 1024 * 1024) throw new Error('Document exceeds image embedding budget.')
          const bytes = Buffer.alloc(before.size + 1)
          let offset = 0
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (!bytesRead) break
            offset += bytesRead
          }
          const after = await handle.stat()
          if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Image changed while reading.')
          result = { url: `data:${mimeType};base64,${bytes.subarray(0, offset).toString('base64')}`, size: offset }
        }
      } finally { await handle.close() }
    } catch { /* Preserve a static source label; never let the browser resolve an unauthorized URL. */ }
    cache.set(source, result)
    return result
  }
  const visit = async (node: Root | RootContent) => {
    if (node.type === 'element' && node.tagName === 'img') {
      // A DOM parser resolves duplicate attributes and encoded values before authorization.
      delete node.properties.srcSet
      const source = typeof node.properties.src === 'string' ? node.properties.src : ''
      if (source && !isRemoteOrEmbedded(source)) {
        const image = await resolve(source)
        if (image && outputBytes + image.size <= 100 * 1024 * 1024) {
          node.properties.src = image.url
          outputBytes += image.size
        } else {
          const label = translate(locale, '图片引用：{source}（源图片需单独提供）', { source })
          const alt = typeof node.properties.alt === 'string' ? node.properties.alt : ''
          node.tagName = 'span'
          node.properties = { className: ['image-reference-placeholder'], dataImageSource: source }
          node.children = [{ type: 'text', value: alt ? `${alt} · ${label}` : label }]
          warnings.push(label)
        }
      }
    }
    if ('children' in node) for (const child of node.children) await visit(child)
  }
  await visit(tree)
  return { html: toHtml(tree), warnings }
}

export async function prepareDocumentAssets(html: string, resources: DocumentResourceContext, authorizedRoot?: string, mode: 'embed' | 'preview' | 'print' = 'embed', locale: InterfaceLanguage = 'zh-CN'): Promise<MediaExportResult> {
  const images = await prepareDocumentImages(html, resources, authorizedRoot, mode, locale)
  const media = await embedDocumentMediaHtml(images.html, resources, authorizedRoot, { mode, locale })
  return { ...media, warnings: [...images.warnings, ...media.warnings] }
}

export async function renderPdf(
  html: string,
  temporaryDirectory: string,
  options?: PdfOptions,
): Promise<Buffer> {
  const settings = pdfOptionsSchema.parse(options ?? {})
  const temporaryPath = path.join(
    temporaryDirectory,
    `ttypora-export-${process.pid}-${randomUUID()}.html`,
  )
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      javascript: false,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  try {
    await writeFile(temporaryPath, html, { encoding: 'utf8', mode: 0o600 })
    await window.loadFile(temporaryPath)
    return await window.webContents.printToPDF({
      printBackground: true,
      pageSize: settings.pageSize,
      landscape: settings.landscape,
      displayHeaderFooter: Boolean(settings.pageNumbers || settings.header || settings.footer),
      headerTemplate: `<div style="font-size:9px;width:100%;text-align:center">${escapeText(settings.header)}</div>`,
      footerTemplate: `<div style="font-size:9px;width:100%;text-align:center">${escapeText(settings.footer)}${settings.pageNumbers ? ' <span class="pageNumber"></span> / <span class="totalPages"></span>' : ''}</div>`,
      generateDocumentOutline: true,
      margins: {
        top: settings.marginMm / 25.4,
        bottom: settings.marginMm / 25.4,
        left: settings.marginMm / 25.4,
        right: settings.marginMm / 25.4,
      },
    })
  } finally {
    if (!window.isDestroyed()) window.destroy()
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export async function renderPng(html: string, temporaryDirectory: string): Promise<Buffer> {
  const temporaryPath = path.join(temporaryDirectory, `ttypora-image-${randomUUID()}.html`)
  const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, backgroundThrottling: false, partition: 'ttypora-export' } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  try {
    // An immutable first CSP blocks document scripts; only our isolated measurement code executes.
    const restrictedHtml = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; img-src data: https: http: file:; style-src \'unsafe-inline\'; font-src data:; base-uri \'none\'; form-action \'none\'">' + html.replace(/<!doctype[^>]*>/i, '')
    await writeFile(temporaryPath, restrictedHtml, { encoding: 'utf8', mode: 0o600 })
    await window.loadFile(temporaryPath)
    const height: number = await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'Math.ceil(document.documentElement.scrollHeight)' }])
    if (height > 16000) throw new Error('文档过长，图片导出最多支持 16,000 像素高度，请使用 PDF 导出。')
    window.setContentSize(1100, Math.max(100, height))
    const capture = await window.webContents.capturePage({ x: 0, y: 0, width: 1100, height: Math.max(100, height) }, { stayHidden: true, stayAwake: true })
    if (capture.isEmpty()) throw new Error('无法捕获文档图片。')
    return capture.toPNG()
  } finally {
    if (!window.isDestroyed()) window.destroy()
    await unlink(temporaryPath).catch(() => undefined)
  }
}
