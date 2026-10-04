import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ImageAssetRequest, ImageAssetResult } from '../shared/contracts'
import { normalizeFilePath } from './file-service'
import { resolveDocumentResourceCandidate, type DocumentResourceContext } from './document-resources'
import { createDocumentResourceReference } from './document-resource-references'

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.avif',
  '.svg',
])

const MIME_EXTENSION = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/avif', '.avif'],
  ['image/svg+xml', '.svg'],
])

function safeStem(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName)).normalize('NFKC')
  const safe = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim()
  return safe.slice(0, 120) || 'image'
}

function imageExtension(fileName: string, mimeType: string): string {
  const extension = path.extname(fileName).toLowerCase()
  if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return extension
  const fromMime = MIME_EXTENSION.get(mimeType.toLowerCase())
  if (fromMime) return fromMime
  throw new Error('不支持该图片格式。')
}

function documentPathFor(resources: DocumentResourceContext): string {
  if (!resources.documentPath) throw new Error('文档尚未保存，不能访问本地图片。')
  if (resources.pathFlavor !== (process.platform === 'win32' ? 'win32' : 'posix')) {
    throw new Error('不支持当前平台之外的图片路径。')
  }
  return normalizeFilePath(resources.documentPath)
}

function isInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export async function saveImageAsset(
  resources: DocumentResourceContext,
  request: ImageAssetRequest,
): Promise<ImageAssetResult> {
  if (request.bytes.byteLength === 0 || request.bytes.byteLength > 25 * 1024 * 1024) {
    throw new Error('图片为空或超过 25 MB。')
  }
  const normalizedDocumentPath = documentPathFor(resources)
  const documentDirectory = path.dirname(normalizedDocumentPath)
  const documentStem = path.basename(normalizedDocumentPath, path.extname(normalizedDocumentPath))
  const assetDirectory = path.join(documentDirectory, `${documentStem}.assets`)
  await mkdir(assetDirectory, { recursive: true })
  if (!isInsideOrEqual(await realpath(documentDirectory), await realpath(assetDirectory))) throw new Error('图片资源目录超出文档目录。')

  const extension = imageExtension(request.fileName, request.mimeType)
  const stem = safeStem(request.fileName)
  let suffix = 0
  while (suffix < 10_000) {
    const fileName = `${stem}${suffix === 0 ? '' : `-${suffix}`}${extension}`
    const targetPath = path.join(assetDirectory, fileName)
    // Metadata changes the reference base, never the physical save directory.
    // Validate the lexical roundtrip before creating an asset; access checks
    // above remain independent of this pure formatter.
    const reference = createDocumentResourceReference(resources, targetPath)
    if (reference.kind !== 'reference') throw new Error('无法生成图片引用。')
    try {
      await writeFile(targetPath, request.bytes, { flag: 'wx', mode: 0o600 })
      return {
        path: targetPath,
        markdownUrl: reference.reference,
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        suffix += 1
        continue
      }
      throw error
    }
  }
  throw new Error('无法为图片分配可用文件名。')
}

export async function resolveDocumentImageUrl(
  resources: DocumentResourceContext,
  rawSource: string,
  authorizedRoot?: string,
): Promise<string> {
  const source = rawSource.trim().replace(/^<|>$/g, '')
  if (/^(https?:|data:|blob:)/i.test(source)) return source

  const documentDirectory = path.dirname(documentPathFor(resources))
  const located = resolveDocumentResourceCandidate(resources, source)
  if (located.kind !== 'local') {
    if (located.kind === 'invalid' && located.reason === 'invalid-encoding') throw new Error('图片路径编码无效。')
    throw new Error('图片路径或资源根设置无效或不受支持。')
  }
  if (located.pathFlavor !== (process.platform === 'win32' ? 'win32' : 'posix')) throw new Error('不支持当前平台之外的图片路径。')
  const candidatePath = located.candidatePath

  if (!SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(candidatePath).toLowerCase())) {
    throw new Error('不支持该图片格式。')
  }
  const [realDirectory, realCandidate] = await Promise.all([
    realpath(authorizedRoot ?? documentDirectory),
    realpath(candidatePath),
  ])
  if (!isInsideOrEqual(realDirectory, realCandidate)) {
    throw new Error('图片不在当前文档目录内。')
  }
  const information = await stat(realCandidate)
  if (!information.isFile()) throw new Error('图片不是普通文件。')
  // A file URL can remain in Chromium's decoded-image cache after the document
  // closes. Refresh only changed, authorized files without rewriting Markdown.
  const url = pathToFileURL(realCandidate)
  url.searchParams.set('ttypora-version', `${information.size}-${information.mtimeMs}-${information.ctimeMs}`)
  return url.href
}
