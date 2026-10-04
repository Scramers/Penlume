import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectImageReferences, listImageLibrary, mutateImageLibrary, rewriteImageUrls } from '../src/main/image-library'
import { imageLibraryMutationSchema } from '../src/shared/image-library'
import { createDocumentResourceContext, resolveDocumentResourceCandidate } from '../src/main/document-resources'
import * as resourceReferences from '../src/main/document-resource-references'

const mutationHook = vi.hoisted(() => ({ afterCopy: null as null | ((source: string) => Promise<void>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: async (source: string, destination: string, flags?: number) => { await actual.copyFile(source, destination, flags); await mutationHook.afterCopy?.(source) } }
})

function withResourceRoot(root: unknown, body: string): string {
  return `---\ntypora-root-url: ${JSON.stringify(root)}\n---\n\n${body}`
}
function imageFileUrl(value: string): string {
  return pathToFileURL(value).href.replace(/[!'()*&]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

describe('image library document resource roots', () => {
  it('groups ordinary, single-slash, file and HTML aliases under the current unsaved metadata root', async () => {
    const { root, document, assets } = await fixture(), image = path.join(assets, 'photo name.png')
    await writeFile(image, 'photo')
    const file = pathToFileURL(image).href
    const markdown = withResourceRoot('note.assets', `![relative](photo%20name.png)\n![prefix](/photo%20name.png?#)\n![absolute](${file}?download=1#view)\n\n<img src="/photo%20name.png?a=1&amp;b=2">`)
    const snapshot = await listImageLibrary(document, markdown, root)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({ path: image, status: 'local', references: 4, inAssets: true })
    expect(snapshot.items[0].version!.path).toBe(await realpath(image))
    expect(snapshot.orphans).toEqual([]); expect(snapshot.scanComplete).toBe(true)
    expect(await readFile(document, 'utf8')).toBe('# Note')
  })

  it('copies into the existing assets directory while inverse-formatting every reference in the same root', async () => {
    const { root, document, assets } = await fixture(), shared = path.join(root, 'shared')
    await mkdir(shared)
    const original = path.join(shared, 'old name(.png'); await writeFile(original, 'original')
    const file = imageFileUrl(original)
    const body = `![relative](old%20name%28.png?x=1#view)\n![prefix](/old%20name%28.png?#)\n![absolute](${file}?download)\n![reference][p]\n[ordinary][p]\n\n[p]: old%20name%28.png "caption"\n\n<img src="old%20name%28.png?a=1&amp;b=2">\n\n\`![literal](old%20name%28.png)\``
    const markdown = withResourceRoot('shared', body), before = await collectImageReferences(markdown)
    const item = (await listImageLibrary(document, markdown, root)).items[0]
    expect(item.references).toBe(5); expect(item.inAssets).toBe(false)
    const result = await mutateImageLibrary(document, markdown, { action: 'copy', imageId: item.id, expectedVersion: item.version! }, root)
    const destination = path.join(assets, 'old name(.png'), after = await collectImageReferences(result.markdown)
    expect(result.snapshot.assetDirectory).toBe(assets)
    expect(after).toHaveLength(before.length)
    const resources = createDocumentResourceContext(document, result.markdown)
    for (let index = 0; index < after.length; index++) {
      const actual = resolveDocumentResourceCandidate(resources, after[index].url), previous = resolveDocumentResourceCandidate(resources, before[index].url)
      expect(actual.kind).toBe('local'); expect(previous.kind).toBe('local')
      if (actual.kind !== 'local' || previous.kind !== 'local') throw new Error('Expected local inverse references')
      expect(actual.candidatePath).toBe(destination); expect(actual.suffix).toBe(previous.suffix)
    }
    expect(after[0].url).toBe('../note.assets/old%20name%28.png?x=1#view')
    expect(after[1].url).toBe('/../note.assets/old%20name%28.png?#')
    expect(after[2].url).toBe(imageFileUrl(destination) + '?download')
    expect(result.markdown).toContain('[ordinary][p]\n\n[p]: old%20name%28.png "caption"')
    expect(result.markdown).toContain('`![literal](old%20name%28.png)`')
    expect(result.markdown).toContain('typora-root-url: "shared"')
    expect(await readFile(destination, 'utf8')).toBe('original'); expect(await readFile(original, 'utf8')).toBe('original')
  })

  it('renames rooted aliases while retaining their styles, exact suffixes and original for undo', async () => {
    const { root, document, assets } = await fixture(), original = path.join(assets, 'old.png')
    await writeFile(original, 'original')
    const markdown = withResourceRoot('note.assets', `![a](old.png?x=1#view)\n![b](/old.png?#)\n![c](${pathToFileURL(original).href}?download)`)
    const item = (await listImageLibrary(document, markdown, root)).items[0]
    const result = await mutateImageLibrary(document, markdown, { action: 'rename', imageId: item.id, expectedVersion: item.version!, name: 'new #%.png' }, root)
    const destination = path.join(assets, 'new #%.png'), refs = await collectImageReferences(result.markdown)
    expect(refs.map((reference) => reference.url)).toEqual(['new%20%23%25.png?x=1#view', '/new%20%23%25.png?#', pathToFileURL(destination).href + '?download'])
    for (const reference of refs) expect(resolveDocumentResourceCandidate(createDocumentResourceContext(document, result.markdown), reference.url)).toMatchObject({ kind: 'local', candidatePath: destination })
    expect(await readFile(original, 'utf8')).toBe('original'); expect(await readFile(destination, 'utf8')).toBe('original')
  })

  it('prevalidates all rewritten references before copying a file', async () => {
    const { root, document, assets } = await fixture(), original = path.join(root, 'old.png')
    await writeFile(original, 'original')
    const markdown = '![a](old.png)', item = (await listImageLibrary(document, markdown, root)).items[0]
    let copies = 0; mutationHook.afterCopy = async () => { copies++ }
    const format = vi.spyOn(resourceReferences, 'createDocumentResourceReference').mockReturnValue({ kind: 'unsupported', reason: 'unrepresentable-target', originalReference: 'old.png' })
    try {
      await expect(mutateImageLibrary(document, markdown, { action: 'copy', imageId: item.id, expectedVersion: item.version! }, root)).rejects.toThrow('取消文件复制')
      expect(copies).toBe(0)
      await expect(stat(path.join(assets, 'old.png'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(original, 'utf8')).toBe('original')
    } finally { format.mockRestore() }
  })

  it('retains parsed query/fragment bytes through Markdown and quoted/unquoted HTML syntax while copying', async () => {
    const { root, document, assets } = await fixture(), shared = path.join(root, 'images'), original = path.join(shared, 'old.png')
    await mkdir(shared); await writeFile(original, 'original')
    const markdown = withResourceRoot('images', '![markdown](<old.png?label="(one)"&literal=&amp;amp;#a(1)>)\n\n<img src="old.png?label=&quot;(two)&quot;&amp;literal=&amp;amp;#b(2)">\n<img src=old.png?label=a&#32;b#(3)>')
    const before = await collectImageReferences(markdown), item = (await listImageLibrary(document, markdown, root)).items[0]
    expect(before).toHaveLength(3); expect(item.references).toBe(3)
    const result = await mutateImageLibrary(document, markdown, { action: 'copy', imageId: item.id, expectedVersion: item.version! }, root)
    const after = await collectImageReferences(result.markdown), resources = createDocumentResourceContext(document, result.markdown)
    expect(after).toHaveLength(3)
    for (let index = 0; index < after.length; index++) {
      const previous = resolveDocumentResourceCandidate(resources, before[index].url), current = resolveDocumentResourceCandidate(resources, after[index].url)
      expect(current).toMatchObject({ kind: 'local', candidatePath: path.join(assets, 'old.png'), suffix: previous.suffix })
    }
    expect(after[0].url).toContain('?label="(one)"&literal=&amp;#a(1)')
    expect(after[1].url).toContain('?label="(two)"&literal=&amp;#b(2)')
    expect(after[2].url).toContain('?label=a b#(3)')
    expect(await readFile(path.join(assets, 'old.png'), 'utf8')).toBe('original'); expect(await readFile(original, 'utf8')).toBe('original')
  })

  it('unions each saved and live document using its own metadata and original logical path', async () => {
    const { root, document, assets } = await fixture(), nested = path.join(root, 'nested'), sibling = path.join(nested, 'sibling.md')
    await mkdir(nested)
    for (const name of ['saved.png', 'live.png', 'orphan.png']) await writeFile(path.join(assets, name), name)
    await writeFile(sibling, withResourceRoot('../note.assets', '![saved](/saved.png)'))
    const external = await mkdtemp(path.join(tmpdir(), 'ttypora-rooted-live-buffer-')); directories.push(external)
    const externalBuffer = path.join(external, 'not-on-disk.md')
    const related = [{ path: sibling, markdown: withResourceRoot('../note.assets', '![live](live.png)') }, { path: externalBuffer, markdown: withResourceRoot(pathToFileURL(assets).href, '![external](/live.png)') }]
    const snapshot = await listImageLibrary(document, '# Current', root, related)
    expect(snapshot.orphans.map((item) => item.name)).toEqual(['orphan.png'])
    expect(snapshot.scannedDocuments).toBe(3); expect(snapshot.scanComplete).toBe(true)
    await expect(stat(externalBuffer)).rejects.toMatchObject({ code: 'ENOENT' })
    const version = (await listImageLibrary(document, withResourceRoot('note.assets', '![here](saved.png)'), root)).items[0].version!
    await expect(mutateImageLibrary(document, '# Current', { action: 'quarantine', path: path.join(assets, 'saved.png'), expectedVersion: version }, root, related)).rejects.toThrow('仍被文档引用')
  })

  it.each(['current', 'saved', 'live'] as const)('disables orphan moves for unsupported metadata in the %s document, even without parsed image references', async (location) => {
    for (const resourceRoot of ['https://example.com/assets/', '${filename}.assets', 'note.assets?query=1']) {
      const { root, document, assets } = await fixture(), image = path.join(assets, 'orphan.png'), sibling = path.join(root, 'sibling.md')
      await writeFile(image, 'orphan')
      const unsupported = withResourceRoot(resourceRoot, '# No image syntax'), markdown = location === 'current' ? unsupported : '# Current'
      await writeFile(sibling, location === 'saved' ? unsupported : '# Saved')
      const related = location === 'live' ? [{ path: sibling, markdown: unsupported }] : []
      const snapshot = await listImageLibrary(document, markdown, root, related)
      expect(snapshot.scanComplete).toBe(false); expect(snapshot.warnings.join(' ')).toContain('资源根')
      expect(snapshot.orphans).toHaveLength(1)
      await expect(mutateImageLibrary(document, markdown, { action: 'quarantine', path: image, expectedVersion: snapshot.orphans[0].version }, root, related)).rejects.toThrow('检查不完整')
      expect(await readFile(image, 'utf8')).toBe('orphan')
    }
  })

  it('keeps an explicit file reference usable under unsupported metadata and protects unresolved references from orphan moves', async () => {
    const { root, document, assets } = await fixture(), referenced = path.join(assets, 'known.png'), orphan = path.join(assets, 'orphan.png')
    await writeFile(referenced, 'known'); await writeFile(orphan, 'orphan')
    const markdown = withResourceRoot('${filename}.assets', `![unknown](known.png)\n![explicit](${pathToFileURL(referenced).href})`)
    const snapshot = await listImageLibrary(document, markdown, root)
    expect(snapshot.items.map((item) => item.status)).toEqual(['blocked', 'local'])
    expect(snapshot.orphans.map((item) => item.name)).toEqual(['orphan.png']); expect(snapshot.scanComplete).toBe(false)
    await expect(mutateImageLibrary(document, markdown, { action: 'quarantine', path: orphan, expectedVersion: snapshot.orphans[0].version }, root)).rejects.toThrow('检查不完整')
  })

  it('locates images from a selected document alias without changing its physical assets storage or authorization root', async () => {
    const { root, document, assets } = await fixture(), nested = path.join(root, 'nested'), logical = path.join(nested, 'alias.md')
    await mkdir(nested); await mkdir(path.join(nested, 'rooted')); await mkdir(path.join(root, 'rooted'))
    const image = path.join(nested, 'rooted', 'photo.png')
    await writeFile(image, 'logical'); await writeFile(path.join(root, 'rooted', 'photo.png'), 'wrong physical base')
    await symlink(document, logical, 'file')
    const snapshot = await listImageLibrary(logical, withResourceRoot('rooted', '![logical](photo.png)'), root)
    expect(snapshot.items[0]).toMatchObject({ path: image, status: 'local', size: 7 })
    expect(snapshot.assetDirectory).toBe(assets)
    expect(snapshot.scanComplete).toBe(false) // The existing disk scan remains conservative about symlinks.
  })

  it('never treats a root outside the authorization boundary or through a junction as a new grant', async () => {
    const { root, document } = await fixture(), outside = await mkdtemp(path.join(tmpdir(), 'ttypora-metadata-outside-')); directories.push(outside)
    await writeFile(path.join(outside, 'private.png'), 'outside')
    const junction = path.join(root, 'linked'); await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
    for (const resourceRoot of [outside, 'linked']) {
      const snapshot = await listImageLibrary(document, withResourceRoot(resourceRoot, '![private](private.png)'), root)
      expect(snapshot.items[0].status).toBe('blocked'); expect(snapshot.items[0].version).toBeNull(); expect(snapshot.scanComplete).toBe(false)
    }
    expect(await readFile(path.join(outside, 'private.png'), 'utf8')).toBe('outside')
  })

  it('decodes URI and HTML entity spellings once while retaining literal percent/entity bytes in filenames', async () => {
    const { root, document, assets } = await fixture(), image = path.join(assets, 'literal%20&amp;name.png')
    await writeFile(image, 'literal')
    const markdown = withResourceRoot('note.assets', '![encoded](literal%2520%26amp%3Bname.png)\n\n<img src="literal%2520&amp;amp;name.png">')
    const snapshot = await listImageLibrary(document, markdown, root)
    expect(snapshot.items).toHaveLength(1); expect(snapshot.items[0]).toMatchObject({ path: image, status: 'local', references: 2 })
    expect(snapshot.orphans).toEqual([])
  })
})
const directories: string[] = []
afterEach(async () => {
  mutationHook.afterCopy = null
  const { rm } = await import('node:fs/promises')
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ttypora-image-library-')); directories.push(root)
  const document = path.join(root, 'note.md'), assets = path.join(root, 'note.assets')
  await writeFile(document, '# Note'); await mkdir(assets)
  return { root, document, assets }
}

describe('image references', () => {
  it('protects and rewrites video posters without changing media sources or literals', async () => {
    const markdown = '<video controls src="movie.mp4" poster="cover.png?a=1&amp;b=2"></video>\n\n`<video poster="literal.png">`\n\n<!-- <video poster="comment.png"> -->'
    const refs = await collectImageReferences(markdown)
    expect(refs.map((item) => item.url)).toEqual(['cover.png?a=1&b=2'])
    const rewritten = await rewriteImageUrls(markdown, new Map([['cover.png?a=1&b=2', 'new cover.png']]))
    expect(rewritten).toContain('src="movie.mp4" poster="new%20cover.png"')
    expect(rewritten).toContain('poster="literal.png"')
  })
  it('rewrites image uses without changing shared links, code, YAML or HTML raw text', async () => {
    const markdown = `---\ncover: '![Y](old.png)'\n---\n![inline](old.png "title")\n![reference][shared]\n[document link][shared]\n\n[shared]: old.png "title"\n\n<img alt='html' src="old.png" />\n\n\`![code](old.png)\`\n\n\`\`\`html\n<img src="old.png">\n\`\`\`\n\n<!-- <img src="old.png"> -->\n<script>const template = '<img src="old.png">'</script>\n`
    const references = await collectImageReferences(markdown)
    expect(references.map((entry) => entry.kind)).toEqual(['url', 'image-reference', 'html'])
    const result = await rewriteImageUrls(markdown, new Map([['old.png', 'new name(.png']]))
    expect(result).toContain('![inline](new%20name%28.png "title")')
    expect(result).toContain('![reference](new%20name%28.png "title")')
    expect(result).toContain('[document link][shared]\n\n[shared]: old.png "title"')
    expect(result).toContain('src="new%20name%28.png"')
    expect(result).toContain("cover: '![Y](old.png)'")
    expect(result).toContain("const template = '<img src=\"old.png\">'")
  })
  it('recognizes balanced destinations, encoded spaces, escaped syntax and HTML entities', async () => {
    const markdown = '![nested [label]](folder/photo(1).png)\n![space](<photo name.png>)\n![escaped](photo\\(2\\).png)\n\n<img src=photo%20name.png><img src="photo.png?a=1&amp;b=2" alt="A &amp; B">\n\\![escaped marker](photo.png)'
    const refs = await collectImageReferences(markdown)
    expect(refs.map((entry) => entry.url)).toEqual(['folder/photo(1).png', 'photo name.png', 'photo(2).png', 'photo%20name.png', 'photo.png?a=1&b=2'])
    const result = await rewriteImageUrls(markdown, new Map([['photo.png?a=1&b=2', 'new.png?a=1&b=2']]))
    expect(result).toContain('src="new.png?a=1&amp;b=2"')
  })
  it('supports escaped path spaces outside code without treating escaped image markers as references', async () => {
    const markdown = '![path](photo\\ name.png "caption")\n\\![literal](other\\ name.png)\n`![code](code\\ image.png)`\n\n[ordinary](link\\ image.png)'
    expect((await collectImageReferences(markdown)).map((item) => item.url)).toEqual(['photo name.png'])
    expect(await rewriteImageUrls(markdown, new Map([['photo name.png', 'new%20name.png']]))).toContain('![path](new%20name.png "caption")')
  })
})

describe('image library', () => {
  it('keeps poster assets out of orphans and removes only the poster reference', async () => {
    const { root, document, assets } = await fixture()
    await writeFile(path.join(assets, 'cover.png'), 'cover')
    const markdown = '<video controls src="movie.mp4" poster="note.assets/cover.png"></video>'
    const snapshot = await listImageLibrary(document, markdown, root)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.orphans).toEqual([])
    const removed = await mutateImageLibrary(document, markdown, { action: 'remove-reference', imageId: snapshot.items[0].id }, root)
    expect(removed.markdown).toContain('<video controls src="movie.mp4" ')
    expect(removed.markdown).not.toContain('poster=')
    expect(await readFile(path.join(assets, 'cover.png'), 'utf8')).toBe('cover')
    await writeFile(path.join(root, 'saved.md'), markdown)
    expect((await listImageLibrary(document, '', root)).orphans).toEqual([])
  })
  it('groups local image URLs, shows missing/remote/embedded resources and scans saved references', async () => {
    const { root, document, assets } = await fixture()
    await writeFile(path.join(assets, 'photo name.png'), 'photo')
    await writeFile(path.join(assets, 'shared.png'), 'shared')
    await writeFile(path.join(root, 'other.md'), '![shared](note.assets/shared.png)')
    const markdown = '![a](note.assets/photo%20name.png)\n![b](<note.assets/photo name.png>)\n![missing](missing.png)\n![remote](https://example.com/a.png)\n![embed](data:image/png;base64,AAAA)'
    const snapshot = await listImageLibrary(document, markdown, root)
    expect(snapshot.items).toHaveLength(4)
    expect(snapshot.items[0]).toMatchObject({ name: 'photo name.png', status: 'local', references: 2, size: 5, inAssets: true })
    expect(snapshot.items.map((item) => item.status)).toEqual(['local', 'missing', 'remote', 'embedded'])
    expect(snapshot.orphans).toEqual([])
    expect(snapshot.scannedDocuments).toBe(2)
    expect(snapshot.scanComplete).toBe(true)
  })
  it('copies into assets exclusively, updates every image reference and preserves original files and links', async () => {
    const { root, document, assets } = await fixture()
    const original = path.join(root, 'photo.png')
    await writeFile(original, 'original'); await writeFile(path.join(assets, 'photo.png'), 'independent')
    const markdown = '![inline](photo.png)\n![ref][p]\n[link][p]\n\n[p]: photo.png\n\n<img src="photo.png" alt="HTML">'
    const item = (await listImageLibrary(document, markdown, root)).items[0]
    const result = await mutateImageLibrary(document, markdown, { action: 'copy', imageId: item.id, expectedVersion: item.version! }, root)
    expect(result.markdown).toContain('![inline](note.assets/photo-1.png)')
    expect(result.markdown).toContain('![ref](note.assets/photo-1.png)')
    expect(result.markdown).toContain('[link][p]\n\n[p]: photo.png')
    expect(result.markdown).toContain('src="note.assets/photo-1.png"')
    expect(await readFile(path.join(assets, 'photo.png'), 'utf8')).toBe('independent')
    expect(await readFile(original, 'utf8')).toBe('original')
    expect(await readFile(path.join(assets, 'photo-1.png'), 'utf8')).toBe('original')
  })
  it('renames image uses, keeps the original for document undo and refuses name collisions', async () => {
    const { root, document, assets } = await fixture()
    await writeFile(path.join(assets, 'old.png'), 'old')
    const markdown = '![one](note.assets/old.png?raw=1)\n![two](note.assets/old.png)'
    const item = (await listImageLibrary(document, markdown, root)).items[0]
    const result = await mutateImageLibrary(document, markdown, { action: 'rename', imageId: item.id, expectedVersion: item.version!, name: '新图片(' }, root)
    expect(result.markdown).toContain('note.assets/%E6%96%B0%E5%9B%BE%E7%89%87%28.png?raw=1')
    expect(await readFile(path.join(assets, 'old.png'), 'utf8')).toBe('old')
    expect(await readFile(path.join(assets, '新图片(.png'), 'utf8')).toBe('old')
    await expect(mutateImageLibrary(document, markdown, { action: 'rename', imageId: item.id, expectedVersion: item.version!, name: '新图片(' }, root)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(mutateImageLibrary(document, markdown, { action: 'rename', imageId: item.id, expectedVersion: item.version!, name: '../escape.png' }, root)).rejects.toThrow(/文件名/)
  })
  it('removes all image references with descriptions while preserving file and ordinary links', async () => {
    const { root, document, assets } = await fixture()
    await writeFile(path.join(assets, 'x.png'), 'x')
    const markdown = '![caption](note.assets/x.png)\n![ref][p]\n[normal][p]\n\n[p]: note.assets/x.png\n\n<img src="note.assets/x.png" alt="&lt;literal&gt;">'
    const item = (await listImageLibrary(document, markdown, root)).items[0]
    const result = await mutateImageLibrary(document, markdown, { action: 'remove-reference', imageId: item.id }, root)
    expect(result.markdown).toContain('caption\nref\n[normal][p]')
    expect(result.markdown).toContain('&lt;literal&gt;')
    expect(await collectImageReferences(result.markdown)).toEqual([])
    expect(await readFile(path.join(assets, 'x.png'), 'utf8')).toBe('x')
  })
  it('rejects stale source versions and a source changing during copying, without retaining a partial target', async () => {
    const { root, document, assets } = await fixture()
    const original = path.join(root, 'x.png'); await writeFile(original, 'before')
    const markdown = '![x](x.png)', item = (await listImageLibrary(document, markdown, root)).items[0]
    await writeFile(original, 'modified')
    await expect(mutateImageLibrary(document, markdown, { action: 'copy', imageId: item.id, expectedVersion: item.version! }, root)).rejects.toThrow(/其他程序修改/)
    const refreshed = (await listImageLibrary(document, markdown, root)).items[0]
    mutationHook.afterCopy = async (source) => { await writeFile(source, 'changed-during-copy') }
    await expect(mutateImageLibrary(document, markdown, { action: 'copy', imageId: refreshed.id, expectedVersion: refreshed.version! }, root)).rejects.toThrow(/其他程序修改/)
    await expect(stat(path.join(assets, 'x.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(original, 'utf8')).toBe('changed-during-copy')
  })
  it('protects references in saved and unsaved sibling documents and recovers an actual orphan', async () => {
    const { root, document, assets } = await fixture()
    const image = path.join(assets, 'shared.png'), sibling = path.join(root, 'sibling.md')
    await writeFile(image, 'shared'); await writeFile(sibling, '![saved](note.assets/shared.png)')
    const listed = await listImageLibrary(document, '# Note', root)
    const version = (await listImageLibrary(document, '![here](note.assets/shared.png)', root)).items[0].version!
    expect(listed.orphans).toEqual([])
    expect((await listImageLibrary(document, '# Note', root, [{ path: sibling, markdown: '# Unsaved removal' }])).orphans).toEqual([])
    await expect(mutateImageLibrary(document, '# Note', { action: 'quarantine', path: image, expectedVersion: version }, root)).rejects.toThrow(/仍被文档引用/)
    await writeFile(sibling, '# No saved images')
    const pending = [{ path: sibling, markdown: '![unsaved](note.assets/shared.png)' }]
    expect((await listImageLibrary(document, '# Note', root, pending)).orphans).toEqual([])
    await expect(mutateImageLibrary(document, '# Note', { action: 'quarantine', path: image, expectedVersion: version }, root, pending)).rejects.toThrow(/仍被文档引用/)
    const orphan = (await listImageLibrary(document, '# Note', root)).orphans[0]
    const moved = await mutateImageLibrary(document, '# Note', { action: 'quarantine', path: image, expectedVersion: orphan.version }, root)
    expect(moved.markdown).toBe('# Note'); expect(moved.snapshot.recovery).toHaveLength(1)
    await expect(stat(image)).rejects.toMatchObject({ code: 'ENOENT' })
    const restored = await mutateImageLibrary(document, '# Note', { action: 'restore', recoveryId: moved.snapshot.recovery[0].id }, root)
    expect(restored.snapshot.recovery).toHaveLength(0)
    expect(await readFile(image, 'utf8')).toBe('shared')
  })
  it('preserves recovery data when a same-name file is recreated independently', async () => {
    const { root, document, assets } = await fixture(), image = path.join(assets, 'x.png')
    await writeFile(image, 'old')
    const orphan = (await listImageLibrary(document, '', root)).orphans[0]
    const moved = await mutateImageLibrary(document, '', { action: 'quarantine', path: image, expectedVersion: orphan.version }, root)
    await writeFile(image, 'new')
    await expect(mutateImageLibrary(document, '', { action: 'restore', recoveryId: moved.snapshot.recovery[0].id }, root)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(image, 'utf8')).toBe('new')
    expect((await listImageLibrary(document, '', root)).recovery).toHaveLength(1)
  })
  it('protects images referenced by authorized external buffers without reading external disk documents', async () => {
    const { root, document, assets } = await fixture(), image = path.join(assets, 'shared.png')
    await writeFile(image, 'shared')
    const external = await mkdtemp(path.join(tmpdir(), 'ttypora-image-external-buffer-')); directories.push(external)
    const bufferPath = path.join(external, 'unsaved-buffer.md')
    const reference = path.relative(external, image).replace(/\\/g, '/')
    // This file is outside the authorized disk root and must never be scanned.
    await writeFile(path.join(external, 'unopened.md'), `![disk](<${reference}>)`)
    const orphan = (await listImageLibrary(document, '', root)).orphans[0]
    expect(orphan.path).toBe(image)
    const buffers = [{ path: bufferPath, markdown: `![live](<${reference}>)` }]
    expect((await listImageLibrary(document, '', root, buffers)).orphans).toEqual([])
    await expect(mutateImageLibrary(document, '', { action: 'quarantine', path: image, expectedVersion: orphan.version }, root, buffers)).rejects.toThrow(/仍被文档引用/)
    // No external file at bufferPath exists; successful inspection proves the
    // related path is a context for URL resolution, not a disk-read request.
    await expect(stat(bufferPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await listImageLibrary(document, '', root, [{ path: bufferPath, markdown: '# No references' }])).orphans).toHaveLength(1)
    expect(await readFile(image, 'utf8')).toBe('shared')
  })
  it('rechecks saved document references added while preparing an orphan move', async () => {
    const { root, document, assets } = await fixture(), image = path.join(assets, 'x.png'), sibling = path.join(root, 'sibling.md')
    await writeFile(image, 'original'); await writeFile(sibling, '# No images')
    const orphan = (await listImageLibrary(document, '', root)).orphans[0]
    mutationHook.afterCopy = async () => { await writeFile(sibling, '![new reference](note.assets/x.png)') }
    await expect(mutateImageLibrary(document, '', { action: 'quarantine', path: image, expectedVersion: orphan.version }, root)).rejects.toThrow(/新的文档引用/)
    expect(await readFile(image, 'utf8')).toBe('original')
    expect((await listImageLibrary(document, '', root)).recovery).toEqual([])
  })
  it('refuses asset moves after an incomplete workspace reference scan', async () => {
    const { root, document, assets } = await fixture(), image = path.join(assets, 'x.png')
    await writeFile(image, 'x'); await writeFile(path.join(root, 'large.md'), 'x'.repeat(2 * 1024 * 1024 + 1))
    const snapshot = await listImageLibrary(document, '', root)
    expect(snapshot.scanComplete).toBe(false)
    await expect(mutateImageLibrary(document, '', { action: 'quarantine', path: image, expectedVersion: snapshot.orphans[0].version }, root)).rejects.toThrow(/检查不完整/)
    expect(await readFile(image, 'utf8')).toBe('x')
  })
  it('blocks out-of-root images and resource directory junctions', async () => {
    const { root, document, assets } = await fixture()
    const outside = await mkdtemp(path.join(tmpdir(), 'ttypora-image-outside-')); directories.push(outside)
    await writeFile(path.join(outside, 'outside.png'), 'outside')
    const markdown = `![external](<${path.join(outside, 'outside.png').replace(/\\/g, '/')}> )`
    expect((await listImageLibrary(document, markdown, root)).items[0].status).toBe('blocked')
    const { rm } = await import('node:fs/promises'); await rm(assets, { recursive: true })
    await symlink(outside, assets, process.platform === 'win32' ? 'junction' : 'dir')
    const snapshot = await listImageLibrary(document, '![linked](note.assets/outside.png)', root)
    expect(snapshot.items[0].status).toBe('blocked'); expect(snapshot.scanComplete).toBe(false)
    expect(await readFile(path.join(outside, 'outside.png'), 'utf8')).toBe('outside')
  })
  it('validates structured mutation requests', () => {
    expect(imageLibraryMutationSchema.safeParse({ action: 'quarantine', path: '../outside.png' }).success).toBe(false)
    expect(imageLibraryMutationSchema.safeParse({ action: 'restore', recoveryId: '../outside' }).success).toBe(false)
  })
})
