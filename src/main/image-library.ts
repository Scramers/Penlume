import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ImageLibraryDocument, ImageLibraryItem, ImageLibraryMutation, ImageLibraryMutationResult, ImageLibraryRecovery, ImageLibrarySnapshot, ImageLibraryVersion } from '../shared/image-library'
import { z } from 'zod'
import { createDocumentResourceContext, resolveDocumentResourceCandidate, type DocumentResourceContext } from './document-resources'
import { createDocumentResourceReference } from './document-resource-references'

const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'])
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const MAX_SCAN_DOCUMENTS = 2_000
const MAX_ASSETS = 5_000
type Node = { type: string; url?: string; alt?: string; value?: string; identifier?: string; title?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
export interface ImageReference { url: string; from: number; to: number; replacementFrom: number; replacementTo: number; kind: 'url' | 'image-reference' | 'html'; alt: string; title?: string }
type Reference = ImageReference
interface ResolvedSource { key: string; path: string | null; status: ImageLibraryItem['status']; message: string | null; suffix: string; unknown: boolean }
interface Context { documentPath: string; logicalDocumentPath: string; directory: string; root: string; assets: string; resources: DocumentResourceContext }
const queue = new Map<string, Promise<unknown>>()

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
function keyPath(value: string): string { const normalized = path.resolve(value); return process.platform === 'win32' ? normalized.toLowerCase() : normalized }
function idFor(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32) }
function entityDecode(value: string): string {
  return value.replace(/&(?:#(x[\da-f]+|\d+)|amp|quot|apos|lt|gt);/gi, (whole, code: string | undefined) => {
    if (code) { const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole }
    return ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' } as Record<string, string>)[whole.toLowerCase()] ?? whole
  })
}
function escapeAlt(value: string): string { return value.replace(/[\\[\]*_`]/g, '\\$&') }
function safeUrl(value: string): string { return value.replace(/[()<>"'\s]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) }
function localMarkdownUrl(value: string): string {
  // The formatter already encodes the native path. Escape only Markdown syntax;
  // percent-encoding its raw suffix would change the parsed query/fragment.
  return value.replace(/[\\()<>"'&\s]/g, (character) => character === '&' ? '&amp;' : /\s/.test(character) ? `&#${character.charCodeAt(0)};` : `\\${character}`)
}
function localHtmlUrl(value: string): string {
  // Covers quoted and unquoted attributes, including literal entity-looking
  // text. collectImageReferences will decode exactly this one syntax layer.
  return value.replace(/[&<>"'\s]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' } as Record<string, string>)[character] ?? `&#${character.charCodeAt(0)};`)
}
function imageMarkdown(reference: Reference, url: string): string {
  const title = reference.title ? ` "${reference.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''
  return `![${escapeAlt(reference.alt)}](${url}${title})`
}
function urlDestination(source: string, offset: number): { from: number; to: number } | null {
  let index = 2, brackets = 1
  for (; index < source.length && brackets; index += 1) {
    if (source[index] === '\\') index += 1
    else if (source[index] === '[') brackets += 1
    else if (source[index] === ']') brackets -= 1
  }
  while (/\s/.test(source[index] ?? '') && index < source.length) index += 1
  if (source[index] !== '(') return null
  index += 1
  while (/\s/.test(source[index] ?? '') && index < source.length) index += 1
  if (source[index] === '<') {
    const from = ++index
    for (; index < source.length; index += 1) { if (source[index] === '\\') index += 1; else if (source[index] === '>') return { from: offset + from, to: offset + index } }
    return null
  }
  const from = index
  let depth = 0
  for (; index < source.length; index += 1) {
    if (source[index] === '\\') { index += 1; continue }
    if (source[index] === '(') depth += 1
    else if (source[index] === ')' && depth) depth -= 1
    else if (source[index] === ')' || /\s/.test(source[index])) break
  }
  return { from: offset + from, to: offset + index }
}

// Parse Markdown before locating URL spans: code, YAML, links and escaped image syntax stay intact.
export async function collectImageReferences(markdown: string): Promise<Reference[]> {
  const [{ unified }, { default: parse }, { default: frontmatter }] = await Promise.all([import('unified'), import('remark-parse'), import('remark-frontmatter')])
  const tree = unified().use(parse).use(frontmatter).parse(markdown) as Node
  const definitions = new Map<string, Node>()
  const collect = (node: Node) => { if (node.type === 'definition' && node.identifier) definitions.set(node.identifier.toLowerCase(), node); node.children?.forEach(collect) }
  collect(tree)
  const references: Reference[] = []
  const walk = (node: Node) => {
    const from = node.position?.start.offset, to = node.position?.end.offset
    if (typeof from === 'number' && typeof to === 'number') {
      if (node.type === 'image' && node.url) {
        const destination = urlDestination(markdown.slice(from, to), from)
        if (destination) references.push({ url: node.url, from, to, replacementFrom: destination.from, replacementTo: destination.to, kind: 'url', alt: node.alt ?? '', title: node.title })
      } else if (node.type === 'imageReference' && node.identifier) {
        const definition = definitions.get(node.identifier.toLowerCase())
        if (definition?.url) references.push({ url: definition.url, from, to, replacementFrom: from, replacementTo: to, kind: 'image-reference', alt: node.alt ?? '', title: definition.title })
      } else if (node.type === 'text') {
        // Pandoc and several Markdown editors accept backslash-escaped destination spaces.
        // CommonMark reports them as text. Only inspect actual text nodes (never code/HTML/YAML).
        const source = markdown.slice(from, to)
        for (const match of source.matchAll(/!\[/g)) {
          const start = from + (match.index ?? 0)
          let slashCount = 0
          for (let cursor = start - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor -= 1) slashCount += 1
          if (slashCount % 2) continue
          const destination = urlDestination(markdown.slice(start, to), start)
          if (!destination) continue
          const rawUrl = markdown.slice(destination.from, destination.to)
          if (!/\\ /.test(rawUrl)) continue
          const tail = markdown.slice(destination.to, to).match(/^\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')?\s*\)/)
          if (!tail) continue
          const altEnd = markdown.lastIndexOf(']', destination.from)
          references.push({ url: entityDecode(rawUrl.replace(/\\([()[\]<> ])/g, '$1')), from: start, to: destination.to + tail[0].length, replacementFrom: destination.from, replacementTo: destination.to, kind: 'url', alt: markdown.slice(start + 2, altEnd), title: tail[1] ?? tail[2] })
        }
      } else if (node.type === 'html' && node.value) {
        const source = node.value
        // Video posters are image references too. Ignore comments and raw-text literals.
        const tags = /<!--[\s\S]*?-->|<(script|style|textarea|pre)\b[^>]*>[\s\S]*?<\/\1\s*>|<(?:img|video)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
        for (const match of source.matchAll(tags)) {
          if (!/^<(?:img|video)\b/i.test(match[0])) continue
          const poster = /^<video\b/i.test(match[0])
          const attributes = /([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
          let src: { url: string; start: number; end: number; attributeStart: number; attributeEnd: number } | null = null, alt = ''
          for (const attribute of match[0].matchAll(attributes)) {
            const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? ''
            if (attribute[1].toLowerCase() === 'alt') alt = entityDecode(value)
            if (attribute[1].toLowerCase() !== (poster ? 'poster' : 'src') || src) continue
            const nameEnd = attribute[0].indexOf('=') + 1
            const valuePrefix = attribute[0].slice(nameEnd).match(/^\s*["']?/)?.[0].length ?? 0
            const start = from + (match.index ?? 0) + (attribute.index ?? 0) + nameEnd + valuePrefix
            const attributeStart = from + (match.index ?? 0) + (attribute.index ?? 0)
            src = { url: entityDecode(value), start, end: start + value.length, attributeStart, attributeEnd: attributeStart + attribute[0].length }
          }
          // Removing a poster removes only its attribute; the video and its source stay intact.
          if (src) references.push({ url: src.url, from: poster ? src.attributeStart : from + (match.index ?? 0), to: poster ? src.attributeEnd : from + (match.index ?? 0) + match[0].length, replacementFrom: src.start, replacementTo: src.end, kind: 'html', alt: poster ? '' : alt })
        }
      }
    }
    node.children?.forEach(walk)
  }
  walk(tree)
  return references
}

export const findImageReferences = collectImageReferences

// A shared image definition may also back a regular link. Replace the image use itself.
export async function rewriteImageUrls(markdown: string, replacements: ReadonlyMap<string, string>): Promise<string> {
  const edits: Array<{ from: number; to: number; value: string }> = []
  for (const reference of await collectImageReferences(markdown)) {
    const destination = replacements.get(reference.url)
    if (destination === undefined) continue
    const next = safeUrl(destination)
    edits.push({ from: reference.replacementFrom, to: reference.replacementTo, value: reference.kind === 'image-reference' ? imageMarkdown(reference, next) : reference.kind === 'html' ? next.replace(/&/g, '&amp;') : next })
  }
  for (const edit of edits.sort((a, b) => b.from - a.from)) markdown = markdown.slice(0, edit.from) + edit.value + markdown.slice(edit.to)
  return markdown
}

async function context(documentPath: string, markdown: string, authorizedRoot?: string): Promise<Context> {
  // Logical Markdown location and filesystem authorization are independent.
  // A selected file alias must not silently change the document's resource base.
  const resources = createDocumentResourceContext(documentPath, markdown)
  if (!resources.documentPath || resources.pathFlavor !== (process.platform === 'win32' ? 'win32' : 'posix')) throw new Error('文档路径须为本机绝对路径。')
  const actual = await realpath(path.resolve(documentPath))
  const root = await realpath(authorizedRoot ?? path.dirname(actual))
  if (!inside(root, actual) || !(await stat(actual)).isFile()) throw new Error('文档不在已授权目录内。')
  const directory = path.dirname(actual)
  return { documentPath: actual, logicalDocumentPath: resources.documentPath, directory, root, assets: path.join(directory, `${path.basename(actual, path.extname(actual))}.assets`), resources }
}
function resolveSource(resources: DocumentResourceContext, url: string): ResolvedSource {
  const located = resolveDocumentResourceCandidate(resources, url)
  if (located.kind === 'external') {
    if (located.sourceKind === 'http' || located.sourceKind === 'https') return { key: `remote:${url}`, path: null, status: 'remote', message: null, suffix: '', unknown: false }
    if (located.sourceKind === 'data' && /^data:image\//i.test(url)) return { key: `embedded:${idFor(url)}`, path: null, status: 'embedded', message: null, suffix: '', unknown: false }
    return { key: `blocked:${url}`, path: null, status: 'blocked', message: '图片 URL 协议不受支持。', suffix: '', unknown: false }
  }
  if (located.kind !== 'local' || located.pathFlavor !== (process.platform === 'win32' ? 'win32' : 'posix')) {
    return { key: `blocked:${url}`, path: null, status: 'blocked', message: resources.root.status === 'unsupported' ? '文档的图片资源根不受支持。' : '图片路径或编码不受支持。', suffix: located.suffix, unknown: true }
  }
  return { key: `local:${keyPath(located.candidatePath)}`, path: located.candidatePath, status: 'local', message: null, suffix: located.suffix, unknown: false }
}
async function safeFile(root: string, candidate: string): Promise<string> {
  if (!inside(root, candidate)) throw new Error('图片超出已授权目录。')
  const relative = path.relative(root, candidate)
  let current = root
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('图片路径含符号链接，已拒绝操作。')
  }
  const actual = await realpath(candidate)
  if (!inside(root, actual) || !(await stat(actual)).isFile()) throw new Error('图片不是授权目录内的普通文件。')
  if (!EXTENSIONS.has(path.extname(actual).toLowerCase())) throw new Error('图片文件类型不受支持。')
  return actual
}
async function fingerprint(filePath: string): Promise<ImageLibraryVersion> {
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat(), hash = createHash('sha256')
    if (!before.isFile()) throw new Error('图片不是普通文件。')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('检查期间图片发生变化，请刷新后重试。')
    return { path: filePath, size: after.size, mtimeMs: after.mtimeMs, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}
function matches(actual: ImageLibraryVersion, expected: ImageLibraryVersion): boolean { return keyPath(actual.path) === keyPath(expected.path) && actual.sha256 === expected.sha256 && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs }
async function unchanged(root: string, filePath: string, expected: ImageLibraryVersion): Promise<ImageLibraryVersion> {
  const actual = await safeFile(root, filePath)
  const version = await fingerprint(actual)
  if (!matches(version, expected)) throw new Error('图片已被其他程序修改，请刷新图片管理后重试。')
  return version
}
async function ensureAssets(ctx: Context): Promise<void> {
  await mkdir(ctx.assets, { recursive: true })
  if ((await lstat(ctx.assets)).isSymbolicLink() || !inside(ctx.directory, await realpath(ctx.assets))) throw new Error('图片资源目录含符号链接或越界。')
}

const recoverySchema = z.object({ id: z.string().regex(/^[a-f0-9-]{36}$/), relative: z.string().min(1).max(32768), size: z.number().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), removedAt: z.iso.datetime() })
async function recoveryDirectory(ctx: Context, create = false): Promise<string | null> {
  if (create) await ensureAssets(ctx)
  const directory = path.join(ctx.assets, '.ttypora-recovery')
  if (create) await mkdir(directory, { recursive: true })
  const metadata = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!metadata) return null
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !inside(ctx.assets, await realpath(directory))) throw new Error('图片恢复目录无效。')
  return directory
}
async function listRecovery(ctx: Context): Promise<ImageLibraryRecovery[]> {
  const directory = await recoveryDirectory(ctx)
  if (!directory) return []
  const result: ImageLibraryRecovery[] = []
  for (const name of (await readdir(directory)).filter((value) => /^[a-f0-9-]{36}\.json$/.test(value)).slice(0, MAX_ASSETS)) {
    try {
      if ((await lstat(path.join(directory, name))).isSymbolicLink()) continue
      const entry = recoverySchema.parse(JSON.parse(await readFile(path.join(directory, name), 'utf8')))
      const stored = await lstat(path.join(directory, `${entry.id}.asset`))
      if (!stored.isFile() || stored.isSymbolicLink()) continue
      result.push({ id: entry.id, name: entry.relative, size: entry.size, removedAt: entry.removedAt })
    } catch { /* Invalid recovery records remain on disk for manual recovery. */ }
  }
  return result.sort((a, b) => b.removedAt.localeCompare(a.removedAt))
}

async function inspect(ctx: Context, markdown: string, relatedDocuments: ImageLibraryDocument[]): Promise<ImageLibrarySnapshot> {
  const references = await collectImageReferences(markdown)
  const grouped = new Map<string, { source: ResolvedSource; references: Reference[] }>()
  for (const reference of references) {
    const source = resolveSource(ctx.resources, reference.url)
    const entry = grouped.get(source.key) ?? { source, references: [] }
    entry.references.push(reference); grouped.set(source.key, entry)
  }
  const warnings: string[] = [], items: ImageLibraryItem[] = []
  for (const [key, entry] of grouped) {
    const source = entry.source
    let version: ImageLibraryVersion | null = null, previewUrl: string | null = null, message = source.message, status = source.status
    if (source.path) {
      try { const actual = await safeFile(ctx.root, source.path); version = await fingerprint(actual); previewUrl = pathToFileURL(actual).href }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        status = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'blocked'
        message = status === 'missing' ? '图片文件不存在。' : error instanceof Error ? error.message : '图片不可读取。'
      }
    }
    items.push({ id: idFor(key), name: source.path ? path.basename(source.path) : status === 'embedded' ? '内嵌图片' : entry.references[0].alt || entry.references[0].url, urls: [...new Set(entry.references.map((ref) => ref.url))], path: source.path, status, references: entry.references.length, size: version?.size ?? null, version, previewUrl, inAssets: source.path ? inside(ctx.assets, source.path) : false, message })
  }
  const overrides = new Map<string, { path: string; markdown: string }>([[keyPath(ctx.logicalDocumentPath), { path: ctx.logicalDocumentPath, markdown }]])
  for (const document of relatedDocuments) {
    const candidate = document.path
    // IPC authorizes every related document before reaching this service. A live
    // buffer may be outside this workspace; only its supplied text is parsed.
    // The disk walk below remains confined to ctx.root and never reads its path.
    if (keyPath(candidate) !== keyPath(ctx.logicalDocumentPath)) overrides.set(keyPath(candidate), { path: candidate, markdown: document.markdown })
  }
  const used = new Set<string>(), seenDocuments = new Set<string>()
  let scanComplete = ctx.resources.root.status !== 'unsupported', scannedDocuments = 0
  const record = async (candidate: string, text: string) => {
    const resources = createDocumentResourceContext(candidate, text)
    if (!resources.documentPath || resources.root.status === 'unsupported') scanComplete = false
    for (const reference of await collectImageReferences(text)) {
      const source = resolveSource(resources, reference.url)
      if (source.unknown) scanComplete = false
      if (source.path) {
        used.add(keyPath(source.path))
        // Do not inspect outside the authorization root to discover aliases.
        // Unknown external filesystem relationships cannot justify an orphan move.
        if (!inside(ctx.root, source.path)) scanComplete = false
      }
    }
    if (!seenDocuments.has(keyPath(candidate))) scannedDocuments += 1
    seenDocuments.add(keyPath(candidate))
  }
  const scan = async (directory: string, depth: number): Promise<void> => {
    if (depth > 24 || scannedDocuments >= MAX_SCAN_DOCUMENTS) { scanComplete = false; return }
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { scanComplete = false; return }
    for (const entry of entries) {
      if (['.git', 'node_modules', '.ttypora-trash', '.ttypora-recovery'].includes(entry.name)) continue
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) { scanComplete = false; continue }
      if (entry.isDirectory()) { await scan(candidate, depth + 1); continue }
      if (!entry.isFile() || !/\.(md|markdown|txt)$/i.test(entry.name)) continue
      if (scannedDocuments >= MAX_SCAN_DOCUMENTS) { scanComplete = false; continue }
      try {
        if ((await stat(candidate)).size > MAX_DOCUMENT_BYTES) scanComplete = false
        else await record(candidate, await readFile(candidate, 'utf8'))
      } catch { scanComplete = false }
    }
  }
  await scan(ctx.root, 0)
  // An unsaved removal must not invalidate a still-saved sibling (or a discarded draft).
  // Union the on-disk references with every live buffer, rather than replacing disk text.
  for (const document of overrides.values()) await record(document.path, document.markdown)
  const orphans: ImageLibrarySnapshot['orphans'] = []
  let assetCount = 0
  const scanAssets = async (directory: string, depth = 0): Promise<void> => {
    if (depth > 24 || assetCount >= MAX_ASSETS) { scanComplete = false; return }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.ttypora-recovery') continue
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) { scanComplete = false; continue }
      if (entry.isDirectory()) { await scanAssets(candidate, depth + 1); continue }
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue
      assetCount += 1
      if (assetCount > MAX_ASSETS) { scanComplete = false; break }
      if (!used.has(keyPath(candidate))) { const version = await fingerprint(candidate); orphans.push({ path: candidate, name: path.relative(ctx.assets, candidate), size: version.size, version, previewUrl: pathToFileURL(candidate).href }) }
    }
  }
  try {
    const assets = await lstat(ctx.assets)
    if (assets.isSymbolicLink() || !assets.isDirectory() || !inside(ctx.directory, await realpath(ctx.assets))) { scanComplete = false; warnings.push('资源目录无效，已停用孤立资源操作。') }
    else await scanAssets(ctx.assets)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { scanComplete = false; warnings.push('部分图片资源不可读取。') } }
  if (!scanComplete) warnings.push('引用检查不完整（资源根或路径不受支持、读取失败、符号链接或超出扫描上限），已禁止移入恢复区。')
  return { documentPath: ctx.documentPath, assetDirectory: ctx.assets, items, orphans: orphans.sort((a, b) => a.name.localeCompare(b.name)), recovery: await listRecovery(ctx), scanComplete, scannedDocuments, warnings }
}

export async function listImageLibrary(documentPath: string, markdown: string, authorizedRoot?: string, relatedDocuments: ImageLibraryDocument[] = []): Promise<ImageLibrarySnapshot> {
  return inspect(await context(documentPath, markdown, authorizedRoot), markdown, relatedDocuments)
}
function validName(name: string, original: string): string {
  if (name !== name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(name) || name.startsWith('.') || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('请输入有效的图片文件名，不能包含路径。')
  const extension = path.extname(name)
  const result = extension ? name : name + path.extname(original)
  if (path.extname(result).toLowerCase() !== path.extname(original).toLowerCase()) throw new Error('重命名不能改变图片扩展名。')
  return result
}
async function exclusiveCopy(ctx: Context, source: string, destination: string, expected: ImageLibraryVersion): Promise<void> {
  const before = await unchanged(ctx.root, source, expected)
  if (before.size > MAX_IMAGE_BYTES) throw new Error('图片超过 25 MB，无法复制。')
  const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.ttypora-copy`)
  await copyFile(source, staging, constants.COPYFILE_EXCL)
  try {
    await unchanged(ctx.root, source, before)
    if ((await fingerprint(staging)).sha256 !== before.sha256) throw new Error('复制期间图片发生变化，已取消操作。')
    await link(staging, destination) // EEXIST protects unrelated or independently recreated files.
  } finally { await unlink(staging).catch(() => undefined) }
}
async function rewrite(markdown: string, resources: DocumentResourceContext, item: ImageLibraryItem, destination: string | null): Promise<string> {
  const edits: Array<{ from: number; to: number; value: string }> = []
  const originalReferences = await collectImageReferences(markdown), expectedReferences = new Map<number, string>()
  for (const [index, reference] of originalReferences.entries()) {
    const source = resolveSource(resources, reference.url)
    if (idFor(source.key) !== item.id) continue
    if (destination === null) edits.push({ from: reference.from, to: reference.to, value: reference.kind === 'html' ? reference.alt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : escapeAlt(reference.alt) })
    else {
      const formatted = createDocumentResourceReference(resources, destination, reference.url)
      if (formatted.kind !== 'reference') throw new Error('无法在当前图片资源根下生成指向目标的引用，已取消文件复制。')
      // The formatter proves lexical identity in this same context. It does not
      // replace the caller's independent destination containment/file checks.
      const next = reference.kind === 'html' ? localHtmlUrl(formatted.reference) : localMarkdownUrl(formatted.reference)
      expectedReferences.set(index, formatted.reference)
      edits.push({ from: reference.replacementFrom, to: reference.replacementTo, value: reference.kind === 'image-reference' ? imageMarkdown(reference, next) : next })
    }
  }
  for (const edit of edits.sort((a, b) => b.from - a.from)) markdown = markdown.slice(0, edit.from) + edit.value + markdown.slice(edit.to)
  if (destination !== null) {
    const rewrittenReferences = await collectImageReferences(markdown)
    if (rewrittenReferences.length !== originalReferences.length || [...expectedReferences].some(([index, reference]) => rewrittenReferences[index].url !== reference)) throw new Error('无法在当前图片资源根下生成指向目标的引用，已取消文件复制。')
  }
  return markdown
}

export async function mutateImageLibrary(documentPath: string, markdown: string, mutation: ImageLibraryMutation, authorizedRoot?: string, relatedDocuments: ImageLibraryDocument[] = []): Promise<ImageLibraryMutationResult> {
  const ctx = await context(documentPath, markdown, authorizedRoot)
  const queueKey = keyPath(ctx.root)
  const run = (queue.get(queueKey) ?? Promise.resolve()).then(async () => {
    const snapshot = await inspect(ctx, markdown, relatedDocuments)
    let notice: string
    if (mutation.action === 'restore') {
      const directory = await recoveryDirectory(ctx)
      if (!directory || !snapshot.recovery.some((item) => item.id === mutation.recoveryId)) throw new Error('恢复记录不存在，请刷新后重试。')
      const metadataPath = path.join(directory, `${mutation.recoveryId}.json`)
      if ((await lstat(metadataPath)).isSymbolicLink()) throw new Error('恢复记录无效。')
      const entry = recoverySchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')))
      if (entry.id !== mutation.recoveryId || entry.relative.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('恢复路径无效。')
      const destination = path.resolve(ctx.assets, entry.relative)
      if (!inside(ctx.assets, destination) || !EXTENSIONS.has(path.extname(destination).toLowerCase())) throw new Error('恢复路径超出资源目录。')
      let parent = ctx.assets
      for (const component of path.relative(ctx.assets, path.dirname(destination)).split(path.sep).filter(Boolean)) { parent = path.join(parent, component); await mkdir(parent, { recursive: true }); if ((await lstat(parent)).isSymbolicLink()) throw new Error('恢复路径含符号链接。') }
      const source = path.join(directory, `${entry.id}.asset`)
      if (!(await lstat(source)).isFile() || (await lstat(source)).isSymbolicLink()) throw new Error('恢复文件无效。')
      const stored = await fingerprint(source)
      if (stored.sha256 !== entry.sha256 || stored.size !== entry.size) throw new Error('恢复文件已被外部修改，原记录已保留。')
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      if ((await fingerprint(destination)).sha256 !== entry.sha256) throw new Error('恢复校验失败，恢复区原件已保留。')
      await unlink(source); await unlink(metadataPath)
      notice = `已恢复 ${entry.relative}，文档引用未改变。`
    } else if (mutation.action === 'quarantine') {
      if (!snapshot.scanComplete) throw new Error('引用检查不完整，不能移动可能仍被使用的图片。')
      const orphan = snapshot.orphans.find((item) => keyPath(item.path) === keyPath(mutation.path))
      if (!orphan) throw new Error('图片仍被文档引用，或不在当前文档的资源目录。')
      await unchanged(ctx.root, orphan.path, mutation.expectedVersion)
      const directory = (await recoveryDirectory(ctx, true))!
      const id = randomUUID(), source = path.join(directory, `${id}.asset`), metadata = path.join(directory, `${id}.json`)
      await exclusiveCopy(ctx, orphan.path, source, mutation.expectedVersion)
      await writeFile(metadata, JSON.stringify({ id, relative: path.relative(ctx.assets, orphan.path), size: orphan.size, sha256: orphan.version.sha256, removedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
      try {
        const beforeRemove = await inspect(ctx, markdown, relatedDocuments)
        if (!beforeRemove.scanComplete || !beforeRemove.orphans.some((item) => keyPath(item.path) === keyPath(orphan.path))) throw new Error('移动期间出现新的文档引用或引用检查不完整，已保留原图片。')
        await unchanged(ctx.root, orphan.path, mutation.expectedVersion); await unlink(orphan.path)
      }
      catch (error) { await unlink(source).catch(() => undefined); await unlink(metadata).catch(() => undefined); throw error }
      notice = `已将 ${orphan.name} 移入恢复区，可随时恢复。`
    } else {
      const item = snapshot.items.find((entry) => entry.id === mutation.imageId)
      if (!item) throw new Error('图片引用已改变，请刷新后重试。')
      if (mutation.action === 'remove-reference') {
        markdown = await rewrite(markdown, ctx.resources, item, null)
        notice = `已移除 ${item.references} 处图片引用并保留说明文字，资源文件未删除。`
      } else {
        if (item.status !== 'local' || !item.path || !item.version) throw new Error('只能复制或重命名已授权的本地图片。')
        await unchanged(ctx.root, item.path, mutation.expectedVersion)
        let destination: string
        if (mutation.action === 'rename') destination = path.join(path.dirname(item.path), validName(mutation.name, item.path))
        else {
          await ensureAssets(ctx)
          if (item.inAssets) throw new Error('图片已在当前文档资源目录内。')
          const stem = path.basename(item.path, path.extname(item.path)), extension = path.extname(item.path)
          destination = path.join(ctx.assets, path.basename(item.path))
          for (let count = 1; await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error }); count += 1) { if (count > 10_000) throw new Error('无法分配图片文件名。'); destination = path.join(ctx.assets, `${stem}-${count}${extension}`) }
        }
        if (keyPath(destination) === keyPath(item.path)) throw new Error('新文件名与当前文件名相同。')
        if (!inside(ctx.root, destination)) throw new Error('目标图片超出已授权目录。')
        if (keyPath(await realpath(path.dirname(destination))) !== keyPath(path.dirname(destination))) throw new Error('目标图片目录含符号链接。')
        const rewritten = await rewrite(markdown, ctx.resources, item, destination)
        await exclusiveCopy(ctx, item.path, destination, mutation.expectedVersion)
        markdown = rewritten
        notice = mutation.action === 'rename' ? `已将引用更新为 ${path.basename(destination)}。原文件保留，文档撤销后仍可使用。${item.inAssets ? '保存文档并确认无引用后，可将原件移入恢复区。' : ''}` : '已复制到文档资源目录并更新全部图片引用，原文件保留。'
      }
    }
    return { markdown, snapshot: await inspect(ctx, markdown, relatedDocuments), notice }
  })
  const tail = run.catch(() => undefined)
  queue.set(queueKey, tail)
  try { return await run } finally { if (queue.get(queueKey) === tail) queue.delete(queueKey) }
}
