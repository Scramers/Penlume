import { createDocumentResourceContext, resolveDocumentResourceCandidate } from '../src/main/document-resources'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveDocumentImageUrl,
  saveImageAsset,
} from '../src/main/image-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

async function rootFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ttypora-images-root-'))
  temporaryDirectories.push(root)
  const notes = path.join(root, 'notes')
  await mkdir(notes)
  const documentPath = path.join(notes, 'note.md')
  await writeFile(documentPath, '# On disk without metadata')
  return { root, notes, documentPath }
}

function rootMarkdown(value: string) {
  return `---\ntypora-root-url: ${JSON.stringify(value)}\n---\n\n# Snapshot`
}

describe('image service', () => {
  it('copies images into a document asset folder using relative Markdown URLs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-images-'))
    temporaryDirectories.push(root)
    const documentPath = path.join(root, 'note.md')
    await writeFile(documentPath, '# Note')

    const first = await saveImageAsset(createDocumentResourceContext(documentPath, ''), {
      fileName: '示例 image.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71]),
    })
    const second = await saveImageAsset(createDocumentResourceContext(documentPath, ''), {
      fileName: '示例 image.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71]),
    })

    expect(first.markdownUrl).toBe('note.assets/%E7%A4%BA%E4%BE%8B%20image.png')
    expect(second.markdownUrl).toContain('-1.png')
    await expect(resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), first.markdownUrl)).resolves.toMatch(/^file:/)
  })

  it('does not resolve local images outside the document directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-images-'))
    temporaryDirectories.push(root)
    const notes = path.join(root, 'notes')
    const documentPath = path.join(notes, 'note.md')
    await mkdir(notes)
    await writeFile(documentPath, '# Note')
    await writeFile(path.join(root, 'outside.png'), 'image')

    await expect(
      resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), '../outside.png'),
    ).rejects.toThrow(/不在当前文档目录/)
  })
  it('resolves image URL query/fragment suffixes and SVG without weakening the directory boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-images-'))
    temporaryDirectories.push(root)
    const documentPath = path.join(root, 'note.md')
    await writeFile(documentPath, '# Note')
    await writeFile(path.join(root, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const resolved = await resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), 'diagram.svg?raw=1#section')
    expect(fileURLToPath(resolved)).toBe(path.join(root, 'diagram.svg'))
    expect(new URL(resolved).searchParams.has('ttypora-version')).toBe(true)
    await expect(resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), '../outside.svg?raw=1')).rejects.toThrow()
  })

  it('keeps unchanged preview URLs stable and reloads a replaced same-path image without changing its source reference', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-images-'))
    temporaryDirectories.push(root)
    const documentPath = path.join(root, 'note.md'), source = '替换 %.png', imagePath = path.join(root, source)
    const markdown = `![描述](${encodeURIComponent(source)})`
    await writeFile(documentPath, markdown)
    await writeFile(imagePath, 'first image')
    const first = await resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), encodeURIComponent(source))
    expect(await resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), encodeURIComponent(source))).toBe(first)
    expect(fileURLToPath(first)).toBe(imagePath)
    // Image edits can preserve byte length. A new modification timestamp must
    // also invalidate the decoded-image cache, independently of file size.
    await writeFile(imagePath, 'other image')
    const modified = new Date(Date.now() + 1000)
    await utimes(imagePath, modified, modified)
    const sameSizeReplacement = await resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), encodeURIComponent(source))
    expect(sameSizeReplacement).not.toBe(first)
    expect(fileURLToPath(sameSizeReplacement)).toBe(imagePath)
    await writeFile(imagePath, 'replacement image with different dimensions')
    const replaced = await resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), encodeURIComponent(source))
    expect(replaced).not.toBe(first)
    expect(replaced).not.toBe(sameSizeReplacement)
    expect(fileURLToPath(replaced)).toBe(imagePath)
    expect(await resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), replaced)).toBe(replaced)
    expect(await readFile(documentPath, 'utf8')).toBe(markdown)
  })
})

describe('image resource contexts', () => {
  it('uses the supplied raw snapshot for root-relative and slash-prefixed references', async () => {
    const { notes, documentPath } = await rootFixture()
    const images = path.join(notes, 'images'), imagePath = path.join(images, 'cover.png')
    await mkdir(images)
    await writeFile(imagePath, 'root-image')
    await writeFile(path.join(notes, 'cover.png'), 'wrong-document-base')
    const resources = createDocumentResourceContext(documentPath, rootMarkdown('images'))
    for (const source of ['cover.png?raw=1#section', '/cover.png?raw=1#section']) {
      expect(fileURLToPath(await resolveDocumentImageUrl(resources, source))).toBe(imagePath)
    }
    expect(await readFile(documentPath, 'utf8')).toBe('# On disk without metadata')
    expect(await readFile(imagePath, 'utf8')).toBe('root-image')
  })

  it.each([
    '---\ntypora-root-url: [images]\n---\n',
    '---\ntypora-root-url: images\ntypora-root-url: other\n---\n',
    '---\ntypora-root-url: "unterminated\n---\n',
    rootMarkdown('%ZZ'),
  ])('falls back to the document directory for invalid metadata %s', async (markdown) => {
    const { notes, documentPath } = await rootFixture()
    await writeFile(path.join(notes, 'cover.png'), 'fallback')
    const resources = createDocumentResourceContext(documentPath, markdown)
    expect(resources.root.status).toBe('invalid')
    expect(fileURLToPath(await resolveDocumentImageUrl(resources, 'cover.png'))).toBe(path.join(notes, 'cover.png'))
  })

  it.each(['https://example.invalid/images/', '${filename}', 'images?raw=1'])('rejects relative references under unsupported root %s but keeps authorized explicit file URLs', async (rootValue) => {
    const { notes, documentPath } = await rootFixture()
    const imagePath = path.join(notes, 'cover.png')
    await writeFile(imagePath, 'explicit')
    const resources = createDocumentResourceContext(documentPath, rootMarkdown(rootValue))
    expect(resources.root.status).toBe('unsupported')
    await expect(resolveDocumentImageUrl(resources, 'cover.png')).rejects.toThrow(/资源根/)
    await expect(resolveDocumentImageUrl(resources, '/cover.png')).rejects.toThrow(/资源根/)
    expect(fileURLToPath(await resolveDocumentImageUrl(resources, `${pathToFileURL(imagePath).href}?raw=1#section`))).toBe(imagePath)
  })

  it('does not grant access to a metadata root outside the existing document or workspace boundary', async () => {
    const { root, notes, documentPath } = await rootFixture()
    const shared = path.join(root, 'shared')
    await mkdir(shared)
    const imagePath = path.join(shared, 'cover.png')
    await writeFile(imagePath, 'private-unless-workspace-authorized')
    for (const rootValue of ['../shared', pathToFileURL(shared).href]) {
      const resources = createDocumentResourceContext(documentPath, rootMarkdown(rootValue))
      await expect(resolveDocumentImageUrl(resources, 'cover.png')).rejects.toThrow(/不在当前文档目录/)
      expect(fileURLToPath(await resolveDocumentImageUrl(resources, '/cover.png', root))).toBe(imagePath)
    }
    const link = path.join(notes, 'linked')
    await symlink(shared, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveDocumentImageUrl(createDocumentResourceContext(documentPath, rootMarkdown('linked')), 'cover.png')).rejects.toThrow(/不在当前文档目录/)
  })

  it('decodes URI filenames once and preserves explicit absolute references independently of root', async () => {
    const { notes, documentPath } = await rootFixture()
    const name = '图 %20&amp;#.png', imagePath = path.join(notes, name)
    await writeFile(imagePath, 'literal-characters')
    const resources = createDocumentResourceContext(documentPath, rootMarkdown('elsewhere'))
    const encodedAbsolute = imagePath.split(path.sep).map(encodeURIComponent).join('/')
    expect(fileURLToPath(await resolveDocumentImageUrl(resources, `${pathToFileURL(imagePath).href}?raw=1#tail`))).toBe(imagePath)
    // A leading POSIX slash uses the root prefix; drive/UNC are explicit native paths.
    if (process.platform === 'win32') expect(fileURLToPath(await resolveDocumentImageUrl(resources, encodedAbsolute))).toBe(imagePath)
    expect(fileURLToPath(await resolveDocumentImageUrl(createDocumentResourceContext(documentPath, ''), `${encodeURIComponent(name)}?raw=1#tail`))).toBe(imagePath)
  })

  it.each(['images', '../outside-not-created', 'https://example.invalid/images/', '${filename}', '%ZZ'])('saves beside the document and returns a same-context reference with root %s', async (rootValue) => {
    const { root, notes, documentPath } = await rootFixture()
    const markdown = rootMarkdown(rootValue), resources = createDocumentResourceContext(documentPath, markdown)
    const result = await saveImageAsset(resources, { fileName: '图 %20&.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) })
    expect(path.dirname(result.path)).toBe(path.join(notes, 'note.assets'))
    expect(resolveDocumentResourceCandidate(resources, result.markdownUrl)).toMatchObject({ kind: 'local', candidatePath: result.path })
    expect(fileURLToPath(await resolveDocumentImageUrl(resources, result.markdownUrl))).toBe(result.path)
    if (resources.root.status === 'unsupported') expect(result.markdownUrl).toMatch(/^file:/)
    else if (resources.root.status === 'local') expect(result.markdownUrl).toMatch(/^\.\.\//)
    else expect(result.markdownUrl).toMatch(/^note\.assets\//)
    if (rootValue === '%ZZ') expect(resources.root.status).toBe('invalid')
    expect(await readdir(root)).toEqual(['notes'])
    expect(await readFile(documentPath, 'utf8')).toBe('# On disk without metadata')
    expect(await readFile(result.path)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('rejects untitled and foreign-platform document contexts before native filesystem access', async () => {
    const foreignPath = process.platform === 'win32' ? '/foreign/note.md' : 'C:\\foreign\\note.md'
    const foreign = createDocumentResourceContext(foreignPath, '')
    await expect(resolveDocumentImageUrl(foreign, 'cover.png')).rejects.toThrow(/平台/)
    await expect(saveImageAsset(foreign, { fileName: 'cover.png', mimeType: 'image/png', bytes: new Uint8Array([1]) })).rejects.toThrow(/平台/)
    const untitled = createDocumentResourceContext(null, rootMarkdown('file:///tmp/'))
    await expect(resolveDocumentImageUrl(untitled, 'cover.png')).rejects.toThrow(/尚未保存/)
    await expect(saveImageAsset(untitled, { fileName: 'cover.png', mimeType: 'image/png', bytes: new Uint8Array([1]) })).rejects.toThrow(/尚未保存/)
  })

  it('preserves external image policy without reading a local root or requiring a saved document', async () => {
    const resources = createDocumentResourceContext(null, rootMarkdown('https://example.invalid/root/'))
    for (const source of ['https://example.invalid/cover.png?x=1#tail', 'data:image/png;base64,AQ==', 'blob:https://example.invalid/id']) {
      await expect(resolveDocumentImageUrl(resources, source)).resolves.toBe(source)
    }
  })

  it('rejects a foreign local candidate even when its document context is native', async () => {
    const { documentPath } = await rootFixture()
    const foreignPath = process.platform === 'win32' ? '/foreign/note.md' : 'C:\\foreign\\note.md'
    const foreignRoot = createDocumentResourceContext(foreignPath, rootMarkdown('images')).root
    const resources = { ...createDocumentResourceContext(documentPath, ''), root: foreignRoot }
    await expect(resolveDocumentImageUrl(resources, '/cover.png')).rejects.toThrow(/平台/)
  })

  it('does not create an image file when its same-context reference cannot be represented', async () => {
    const { notes, documentPath } = await rootFixture()
    const resources = createDocumentResourceContext(documentPath, rootMarkdown('images'))
    await expect(saveImageAsset(resources, { fileName: '\ud800.png', mimeType: 'image/png', bytes: new Uint8Array([1]) })).rejects.toThrow(/生成图片引用/)
    expect(await readdir(path.join(notes, 'note.assets'))).toEqual([])
  })
})
