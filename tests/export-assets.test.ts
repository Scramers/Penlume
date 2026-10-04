import { createDocumentResourceContext } from '../src/main/document-resources'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }))
import { embedLocalImages, prepareDocumentAssets } from '../src/main/export-service'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ttypora-export-assets-')); directories.push(root)
  const folder = path.join(root, 'notes'); await mkdir(folder)
  const document = path.join(folder, 'note.md'); await writeFile(document, '# Note')
  return { root, folder, document }
}
function rootMarkdown(value: string) { return `---\ntypora-root-url: ${JSON.stringify(value)}\n---\n\n# Export snapshot` }

describe('native export resources', () => {
  it('embeds authorized local images while preserving remote URLs and original files', async () => {
    const { folder, document } = await fixture()
    const bytes = Buffer.from('original-image'); await writeFile(path.join(folder, 'cover.png'), bytes)
    const html = '<img src="cover.png"><img src="https://example.com/remote.png"><p>cover.png</p>'
    const result = await embedLocalImages(html, createDocumentResourceContext(document, ''))
    expect(result).toContain(`src="data:image/png;base64,${bytes.toString('base64')}"`)
    expect(result).toContain('src="https://example.com/remote.png"')
    expect(result).toContain('<p>cover.png</p>')
    expect(await readFile(path.join(folder, 'cover.png'))).toEqual(bytes)
  })
  it('does not embed out-of-root or oversized images', async () => {
    const { root, folder, document } = await fixture()
    await writeFile(path.join(root, 'outside.png'), 'private-outside-image')
    const large = await open(path.join(folder, 'huge.png'), 'w')
    try { await large.truncate(25 * 1024 * 1024 + 1) } finally { await large.close() }
    const html = '<img src="../outside.png"><img src="huge.png">'
    for (const sourcePath of [document, null]) {
      const result = await embedLocalImages(html, createDocumentResourceContext(sourcePath, ''))
      expect(result).not.toMatch(/<img[^>]*src=/)
      expect(result).toContain('data-image-source="../outside.png"')
      expect(result).toContain('data-image-source="huge.png"')
      expect(result).not.toContain('private-outside-image')
    }
  })
  it('authorizes parsed image URLs, blocks srcset and duplicate-attribute bypasses, and keeps static labels', async () => {
    const { root, folder, document } = await fixture()
    await writeFile(path.join(root, 'outside.png'), 'private-outside-image')
    await writeFile(path.join(folder, 'safe&cover.png'), 'safe-image')
    const result = await prepareDocumentAssets('<img alt="中文说明" src="../outside.png" src="safe&amp;cover.png"><img src=\'safe&amp;cover.png\' srcset="../outside.png 2x">', createDocumentResourceContext(document, ''), undefined, 'preview', 'en')
    expect(result.html).toContain('中文说明')
    expect(result.html).toContain('Image reference: ../outside.png')
    expect(result.html).not.toContain('srcset')
    expect(result.html).not.toMatch(/src=["'][^"']*outside/)
    expect(result.html).toMatch(/src="file:[^"]*safe&#x26;cover\.png\?ttypora-version=[\d.-]+"/)
    expect(result.warnings).toHaveLength(1)
  })
  it('prepares local media for preview, portable HTML and printed output', async () => {
    const { folder, document } = await fixture()
    await writeFile(path.join(folder, 'sound.wav'), Buffer.from('RIFF-test-wave'))
    const html = '<!doctype html><html><body><audio controls src="sound.wav"></audio></body></html>'
    const preview = await prepareDocumentAssets(html, createDocumentResourceContext(document, ''), undefined, 'preview')
    expect(preview.html).toMatch(/src="file:.*sound\.wav"/)
    const embedded = await prepareDocumentAssets(html, createDocumentResourceContext(document, ''))
    expect(embedded.html).toContain('src="data:audio/wav;base64,')
    const printed = await prepareDocumentAssets(html, createDocumentResourceContext(document, ''), undefined, 'print')
    expect(printed.html).not.toContain('<audio')
    expect(printed.html).toContain('sound.wav')
    expect(printed.html).toContain('media-reference-placeholder')
  })
})

describe('export resource contexts', () => {
  it.each(['preview', 'embed', 'print'] as const)('uses one root snapshot for image/audio/video/source/poster in %s mode', async (mode) => {
    const { folder, document } = await fixture()
    const assets = path.join(folder, 'assets')
    await mkdir(assets)
    await writeFile(path.join(assets, 'cover.png'), Buffer.from([1, 2, 3]))
    await writeFile(path.join(assets, 'tone.wav'), Buffer.from([4, 5, 6]))
    await writeFile(path.join(assets, 'clip.mp4'), Buffer.from([7, 8, 9]))
    const resources = createDocumentResourceContext(document, rootMarkdown('assets'))
    const before = JSON.stringify(resources)
    const html = '<img src="/cover.png"><audio src="/tone.wav"></audio><video poster="/cover.png"><source src="clip.mp4"></video>'
    const result = await prepareDocumentAssets(html, resources, undefined, mode)
    expect(result.warnings).toEqual([])
    if (mode === 'preview') {
      expect(result.html).toMatch(/src="file:[^"]*assets\/cover\.png\?ttypora-version=/)
      expect(result.html).toMatch(/src="file:[^"]*assets\/tone\.wav"/)
      expect(result.html).toMatch(/src="file:[^"]*assets\/clip\.mp4"/)
      expect(result.html).toMatch(/poster="file:[^"]*assets\/cover\.png\?ttypora-version=/)
      expect(result.embeddedBytes).toBe(0)
    } else {
      expect(result.html.match(/data:image\/png;base64,AQID/g)).toHaveLength(2)
      if (mode === 'embed') {
        expect(result.html).toContain('src="data:audio/wav;base64,BAUG"')
        expect(result.html).toContain('src="data:video/mp4;base64,BwgJ"')
        expect(result.embeddedBytes).toBe(9)
      } else {
        expect(result.html).not.toMatch(/<audio|<video|<source/)
        expect(result.html).toContain('视频引用：clip.mp4')
      }
    }
    expect(JSON.stringify(resources)).toBe(before)
    expect(await readFile(document, 'utf8')).toBe('# Note')
    expect(await readFile(path.join(assets, 'cover.png'))).toEqual(Buffer.from([1, 2, 3]))
  })

  it.each(['preview', 'embed', 'print'] as const)('blocks an outside root unless the existing workspace is authorized in %s mode', async (mode) => {
    const { root, document } = await fixture()
    const shared = path.join(root, 'shared')
    await mkdir(shared)
    const image = Buffer.from('private-root-image'), media = Buffer.from('private-root-media')
    await writeFile(path.join(shared, 'cover.png'), image)
    await writeFile(path.join(shared, 'tone.wav'), media)
    const resources = createDocumentResourceContext(document, rootMarkdown('../shared'))
    const html = '<img src="cover.png"><audio src="tone.wav"></audio><video poster="cover.png"><source src="tone.wav"></video>'
    const blocked = await prepareDocumentAssets(html, resources, undefined, mode)
    expect(blocked.html).not.toMatch(/\bsrc="(?:file:|data:)|\bposter="(?:file:|data:)/)
    expect(blocked.html).not.toContain(image.toString('base64'))
    expect(blocked.html).not.toContain(media.toString('base64'))
    expect(blocked.html).toContain('image-reference-placeholder')
    expect(blocked.html).toContain('media-reference-placeholder')
    expect(blocked.warnings.length).toBeGreaterThanOrEqual(2)
    const allowed = await prepareDocumentAssets(html, resources, root, mode)
    expect(allowed.warnings).toEqual([])
    if (mode === 'preview') expect(allowed.html).toMatch(/src="file:/)
    else expect(allowed.html).toContain(`data:image/png;base64,${image.toString('base64')}`)
  })

  it('decodes HTML entities and URI filenames exactly once for images, media and posters', async () => {
    const { folder, document } = await fixture()
    const assets = path.join(folder, 'assets')
    await mkdir(assets)
    await writeFile(path.join(assets, 'cover%20&amp;.png'), Buffer.from([1]))
    await writeFile(path.join(assets, 'cover%20&.png'), 'wrong-entity-decoding')
    await writeFile(path.join(assets, 'tone%20&amp;.wav'), Buffer.from([2]))
    await writeFile(path.join(assets, 'poster%20&amp;.png'), Buffer.from([3]))
    await writeFile(path.join(assets, '%2e%2e%2fprivate.png'), Buffer.from([4]))
    const resources = createDocumentResourceContext(document, rootMarkdown('assets'))
    const html = '<img src="cover%2520&amp;amp;.png"><audio src="tone%2520&amp;amp;.wav"></audio><video poster="poster%2520&amp;amp;.png" src="tone%2520&amp;amp;.wav"></video><img src="%252e%252e%252fprivate.png">'
    const result = await prepareDocumentAssets(html, resources)
    expect(result.warnings).toEqual([])
    expect(result.html).toContain('src="data:image/png;base64,AQ=="')
    expect(result.html).toContain('src="data:audio/wav;base64,Ag=="')
    expect(result.html).toContain('poster="data:image/png;base64,Aw=="')
    expect(result.html).toContain('src="data:image/png;base64,BA=="')
    expect(result.html).not.toContain(Buffer.from('wrong-entity-decoding').toString('base64'))
  })

  it('retains invalid-root fallback but does not reinterpret unsupported roots as the document directory', async () => {
    const { folder, document } = await fixture()
    await writeFile(path.join(folder, 'cover.png'), Buffer.from([1]))
    await writeFile(path.join(folder, 'tone.wav'), Buffer.from([2]))
    const html = '<img src="cover.png"><audio src="tone.wav"></audio>'
    const invalid = await prepareDocumentAssets(html, createDocumentResourceContext(document, '---\ntypora-root-url: [assets]\n---\n'))
    expect(invalid.warnings).toEqual([])
    expect(invalid.html).toContain('data:image/png;base64,AQ==')
    expect(invalid.html).toContain('data:audio/wav;base64,Ag==')
    for (const rootValue of ['https://example.invalid/assets/', '${filename}']) {
      const blocked = await prepareDocumentAssets(html, createDocumentResourceContext(document, rootMarkdown(rootValue)))
      expect(blocked.warnings).toHaveLength(2)
      expect(blocked.html).not.toContain('src="data:')
      expect(blocked.html).toContain('image-reference-placeholder')
      expect(blocked.html).toContain('media-reference-placeholder')
    }
  })

  it('uses a frozen request snapshot rather than re-reading changed on-disk metadata', async () => {
    const { folder, document } = await fixture()
    for (const name of ['first', 'second']) {
      await mkdir(path.join(folder, name))
      await writeFile(path.join(folder, name, 'cover.png'), name)
    }
    const resources = createDocumentResourceContext(document, rootMarkdown('first'))
    await writeFile(document, rootMarkdown('second'))
    const html = '<img src="cover.png">'
    const first = await embedLocalImages(html, resources)
    expect(first).toContain(`data:image/png;base64,${Buffer.from('first').toString('base64')}`)
    expect(first).not.toContain(Buffer.from('second').toString('base64'))
    const second = await embedLocalImages(html, createDocumentResourceContext(document, rootMarkdown('second')))
    expect(second).toContain(`data:image/png;base64,${Buffer.from('second').toString('base64')}`)
  })

  it('keeps untitled and foreign-platform local resources as static references', async () => {
    const { folder, document } = await fixture()
    await writeFile(path.join(folder, 'cover.png'), 'local-image')
    await writeFile(path.join(folder, 'tone.wav'), 'local-media')
    const foreignPath = process.platform === 'win32' ? '/foreign/note.md' : 'C:\\foreign\\note.md'
    const resourcesList = [
      createDocumentResourceContext(null, rootMarkdown(folder.split(path.sep).join('/'))),
      createDocumentResourceContext(foreignPath, rootMarkdown('assets')),
      { ...createDocumentResourceContext(document, ''), root: createDocumentResourceContext(foreignPath, rootMarkdown('assets')).root },
    ]
    for (const resources of resourcesList) {
      const result = await prepareDocumentAssets('<img src="/cover.png"><video poster="/cover.png" src="/tone.wav"></video>', resources, folder, 'preview')
      expect(result.html).not.toMatch(/\bsrc="(?:file:|data:)|\bposter="(?:file:|data:)/)
      expect(result.html).toContain('image-reference-placeholder')
      expect(result.html).toContain('media-reference-placeholder')
      expect(result.warnings).toHaveLength(3)
    }
  })
})
