import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { PandocService, runPandoc } from '../src/main/pandoc-service'
import { pandocExportSchema, validatePandocArguments } from '../src/shared/pandoc'
import { findImageReferences } from '../src/main/image-library'
import { createDocumentResourceContext } from '../src/main/document-resources'
import { saveImageAsset } from '../src/main/image-service'
import { normalizeMarkdownForPandoc } from '../src/shared/markdown-extensions'

const converterInput = vi.hoisted(() => ({ markdown: '' }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { readFileSync } = await import('node:fs')
  return { ...actual, spawn: (...parameters: unknown[]) => {
    const args = parameters[1], input = Array.isArray(args) ? args.at(-1) : null
    // Capture the process boundary, then execute the real runtime unchanged.
    if (Array.isArray(args) && args.includes('--sandbox') && typeof input === 'string' && /[/\\]input\.md$/.test(input)) converterInput.markdown = readFileSync(input, 'utf8')
    return Reflect.apply(actual.spawn, undefined, parameters)
  } }
})

const executable = process.env.TTYPORA_TEST_PANDOC ?? path.resolve('.tools/pandoc/pandoc-3.12/pandoc.exe')
let directory: string
beforeEach(async () => { converterInput.markdown = ''; directory = await mkdtemp(path.join(os.tmpdir(), 'ttypora-pandoc-test-')) })
afterEach(async () => {
  const resolved = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir())
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('ttypora-pandoc-test-')) throw new Error('Unexpected Pandoc fixture cleanup path')
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// Two complete, valid 1-pixel PNGs make a wrong base or repeated decode observable
// in the actual exported image bytes, even when the accidental target also exists.
function pixel(red: number, green: number, blue: number): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const kind = Buffer.from(name), payload = Buffer.concat([kind, data])
    let crc = 0xffffffff
    for (const byte of payload) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4)
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, payload, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk('IEND', Buffer.alloc(0))])
}
const rootPixel = pixel(220, 20, 30), accidentalPixel = pixel(20, 40, 230)
const rootMarkdown = (root: unknown, images = '![Cover](cover.png)') => `---\ntypora-root-url: ${JSON.stringify(root)}\n---\n\n# Resource root\n\n${images}\n`
const driveReference = (filePath: string) => filePath.replaceAll('\\', '/').split('/').map((segment, index) => index === 0 ? segment : encodeURIComponent(segment)).join('/')
const imageMarkup = (syntax: 'Markdown' | 'HTML', source: string, alt = 'Explicit image') => syntax === 'Markdown' ? `![${alt}](${source})` : `<img src="${source}" alt="${alt}">`

async function exportImageBytes(service: PandocService, markdown: string, sourcePath: string | null, authorizedRoot?: string, filename = 'resources.html') {
  const destination = path.join(directory, filename)
  const result = await service.exportDocument(71, pandocExportSchema.parse({ markdown, sourcePath, suggestedName: filename, format: 'html5' }), destination, authorizedRoot)
  const html = await readFile(destination, 'utf8'), { fromHtml } = await import('hast-util-from-html')
  const tree = fromHtml(html), images: Buffer[] = []
  const visit = (node: typeof tree | (typeof tree.children)[number]) => {
    if (node.type === 'element' && node.tagName === 'img' && typeof node.properties.src === 'string') {
      const match = node.properties.src.match(/^data:image\/png;base64,([a-z\d+/=]+)$/i)
      if (match) images.push(Buffer.from(match[1], 'base64'))
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(tree)
  return { result, html, images, input: converterInput.markdown }
}
describe('Pandoc process controls', () => {
  it('keeps explicit local Markdown and HTML image destinations through extension normalization', async () => {
    const markdown = '![File](file:///G:/notes/image%20name.png)\n\n<img src="file:///G:/notes/image%20name.png">\n\n![Drive](G:/notes/image%20name.png)\n\n<img src="G:/notes/image%20name.png">'
    expect(await normalizeMarkdownForPandoc(markdown)).toBe(markdown)
  })
  it('accepts documented options and rejects output, filters, defaults and shell commands', () => {
    expect(validatePandocArguments(['--toc-depth=3', '--wrap=none', '--highlight-style=zenburn'])).toHaveLength(3)
    for (const argument of ['--output=outside.md', '--filter=script.exe', '--lua-filter=script.lua', '--defaults=settings.yaml', '--reference-doc=secret.docx', '--resource-path=outside', '--data-dir=outside', '--sandbox=false', '&& calc.exe', '-o']) expect(() => validatePandocArguments([argument])).toThrow()
  })
  it('times out and waits for the process to terminate', async () => {
    await expect(runPandoc(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 30 })).rejects.toThrow('超时')
  })
  it('cancels a running process', async () => {
    const controller = new AbortController()
    const running = runPandoc(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal })
    controller.abort()
    await expect(running).rejects.toThrow('取消')
  })
})
describe.skipIf(!existsSync(executable))('real Pandoc conversion', () => {
  it('detects and exports Word, EPUB, RTF and LaTeX with an actual runtime', async () => {
    const service = new PandocService(path.join(directory, 'settings.json'), executable)
    expect((await service.detect()).version).toMatch(/^pandoc \d/)
    for (const [format, extension] of [['docx', 'docx'], ['epub3', 'epub'], ['rtf', 'rtf'], ['latex', 'tex']]) {
      const target = path.join(directory, 'output.' + extension)
      await service.exportDocument(1, pandocExportSchema.parse({ markdown: '# 中文标题\n\nA **bold** paragraph.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$x^2$\n', sourcePath: null, suggestedName: 'output', format }), target)
      const bytes = await readFile(target)
      expect(bytes.length).toBeGreaterThan(30)
      if (format === 'docx' || format === 'epub3') expect(bytes.subarray(0, 2).toString()).toBe('PK')
      else expect(bytes.toString('utf8')).toMatch(format === 'rtf' ? /\\rtf/ : /\\section/)
    }
  }, 20000)
  it('embeds authorized local images and imports Word with durable resource references', async () => {
    const service = new PandocService(path.join(directory, 'settings.json'), executable)
    const source = path.join(directory, 'source.md'), image = path.join(directory, 'pixel.png'), output = path.join(directory, 'image.docx'), imported = path.join(directory, 'imported.md')
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    await writeFile(source, '# Title\n\n![Pixel](pixel.png)\n\n$x^2 + y^2$\n')
    const result = await service.exportDocument(1, pandocExportSchema.parse({ markdown: await readFile(source, 'utf8'), sourcePath: source, suggestedName: 'image', format: 'docx' }), output, directory)
    expect(result.warnings).not.toMatch(/Could not fetch|未能嵌入/)
    const restored = await service.importDocument(1, output, imported)
    expect(restored.snapshot?.markdown).toMatch(/Title/)
    expect(restored.snapshot?.markdown).toMatch(/\$x\^/)
    expect(restored.snapshot?.markdown).not.toMatch(/\$`/)
    const reference = (await findImageReferences(restored.snapshot!.markdown))[0]?.url
    expect(reference).toContain('imported.assets/')
    expect(await readFile(path.join(directory, reference!))).toEqual(await readFile(image))
  }, 15000)
  it.each(['https://example.invalid/assets/', '${filename}.assets', 'images?mode=1'])('embeds the explicit file URL returned by saving a new image under unsupported metadata root %s', async (rootValue) => {
    const notes = path.join(directory, 'notes'); await mkdir(notes)
    const source = path.join(notes, 'post.md'), initial = rootMarkdown(rootValue, '# Before insertion')
    await writeFile(source, initial)
    const saved = await saveImageAsset(createDocumentResourceContext(source, initial), { fileName: 'Saved %.png', mimeType: 'image/png', bytes: rootPixel })
    expect(saved.markdownUrl).toMatch(/^file:/)
    const markdown = rootMarkdown(rootValue, imageMarkup('Markdown', saved.markdownUrl, 'Inserted image'))
    await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, notes)
    expect(exported.images).toEqual([rootPixel]); expect(exported.result.warnings).not.toMatch(/未能嵌入|Could not fetch|危险的 Markdown/)
    expect((await findImageReferences(exported.input)).map((reference) => reference.url)).toEqual([`data:image/png;base64,${rootPixel.toString('base64')}`])
    expect(exported.input).not.toContain(saved.markdownUrl)
    expect(await readFile(saved.path)).toEqual(rootPixel); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it.each(['Markdown', 'HTML'] as const)('authorizes an explicit file URL in %s before sanitizing the complete conversion input', async (syntax) => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), assets = path.join(workspace, 'assets')
    await mkdir(notes, { recursive: true }); await mkdir(assets)
    const source = path.join(notes, 'post.md'), image = path.join(assets, 'authorized %.png')
    await writeFile(image, rootPixel)
    const markdown = rootMarkdown('missing-relative-base', imageMarkup(syntax, pathToFileURL(image).href))
    await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, workspace)
    expect(exported.images).toEqual([rootPixel]); expect(exported.result.warnings).not.toMatch(/未能嵌入|Could not fetch/)
    expect((await findImageReferences(exported.input)).map((reference) => reference.url)).toEqual([`data:image/png;base64,${rootPixel.toString('base64')}`])
    expect(exported.input).not.toContain(pathToFileURL(image).href)
    expect(exported.html).not.toMatch(/src="file:/); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it.skipIf(process.platform !== 'win32').each(['Markdown', 'HTML'] as const)('authorizes an explicit Windows drive path in %s before sanitizing the complete conversion input', async (syntax) => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), assets = path.join(workspace, 'assets')
    await mkdir(notes, { recursive: true }); await mkdir(assets)
    const source = path.join(notes, 'post.md'), image = path.join(assets, 'authorized %.png')
    await writeFile(image, rootPixel)
    const markdown = rootMarkdown('missing-relative-base', imageMarkup(syntax, driveReference(image)))
    await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, workspace)
    expect(exported.images).toEqual([rootPixel]); expect(exported.result.warnings).not.toMatch(/未能嵌入|Could not fetch/)
    expect((await findImageReferences(exported.input)).map((reference) => reference.url)).toEqual([`data:image/png;base64,${rootPixel.toString('base64')}`])
    expect(exported.input).not.toContain(driveReference(image))
    expect(exported.html).not.toMatch(/src="[a-z]:\//i); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it.each(['Markdown', 'HTML'] as const)('rejects an unauthorized explicit file URL in %s before invoking Pandoc', async (syntax) => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), outside = path.join(directory, 'outside')
    await mkdir(notes, { recursive: true }); await mkdir(outside)
    const source = path.join(notes, 'post.md'), image = path.join(outside, 'private.png')
    await writeFile(image, accidentalPixel)
    const markdown = rootMarkdown('missing-relative-base', imageMarkup(syntax, pathToFileURL(image).href, 'Blocked image'))
    await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, workspace)
    expect(exported.images).toEqual([]); expect(exported.html).not.toContain(accidentalPixel.toString('base64')); expect(exported.html).not.toMatch(/src="file:/)
    expect(await findImageReferences(exported.input)).toEqual([]); expect(exported.input).not.toContain(pathToFileURL(image).href)
    expect(exported.result.warnings).toMatch(/未能嵌入/); expect(exported.result.warnings).not.toMatch(/Could not fetch/)
    expect(await readFile(image)).toEqual(accidentalPixel); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it.skipIf(process.platform !== 'win32').each(['Markdown', 'HTML'] as const)('rejects an unauthorized Windows drive image in %s before invoking Pandoc', async (syntax) => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), outside = path.join(directory, 'outside')
    await mkdir(notes, { recursive: true }); await mkdir(outside)
    const source = path.join(notes, 'post.md'), image = path.join(outside, 'private.png')
    await writeFile(image, accidentalPixel)
    const markdown = rootMarkdown('missing-relative-base', imageMarkup(syntax, driveReference(image), 'Blocked image'))
    await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, workspace)
    expect(exported.images).toEqual([]); expect(exported.html).not.toContain(accidentalPixel.toString('base64')); expect(exported.html).not.toMatch(/src="[a-z]:\//i)
    expect(await findImageReferences(exported.input)).toEqual([]); expect(exported.input).not.toContain(driveReference(image))
    expect(exported.result.warnings).toMatch(/未能嵌入/); expect(exported.result.warnings).not.toMatch(/Could not fetch/)
    expect(await readFile(image)).toEqual(accidentalPixel); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it.each(['Markdown', 'HTML'] as const)('does not forward a missing explicit file image in %s to Pandoc', async (syntax) => {
    const notes = path.join(directory, 'notes'); await mkdir(notes)
    const source = path.join(notes, 'post.md'), missing = path.join(notes, 'missing.png')
    const markdown = rootMarkdown('${filename}.assets', imageMarkup(syntax, pathToFileURL(missing).href, 'Missing image'))
    await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, notes)
    expect(exported.images).toEqual([]); expect(exported.html).not.toMatch(/src="file:/)
    expect(await findImageReferences(exported.input)).toEqual([]); expect(exported.input).not.toContain(pathToFileURL(missing).href)
    expect(exported.result.warnings).toMatch(/未能嵌入/); expect(exported.result.warnings).not.toMatch(/Could not fetch/)
    expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it('embeds image uses of an authorized file while still clearing inline, reference and HTML file download links', async () => {
    const notes = path.join(directory, 'notes'); await mkdir(notes)
    const source = path.join(notes, 'post.md'), image = path.join(notes, 'pixel.png')
    await writeFile(image, rootPixel)
    const file = pathToFileURL(image).href
    const body = `![Inline image](${file})\n\n[Inline download](${file})\n\n![Reference image][shared]\n\n[Reference download][shared]\n\n[shared]: ${file} "Keep image title"\n\n<a href="${file}">HTML download</a>`
    const markdown = rootMarkdown('${filename}.assets', body); await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, notes)
    expect(exported.images).toEqual([rootPixel, rootPixel]); expect(exported.html).not.toMatch(/(?:href|src)="file:/)
    expect((await findImageReferences(exported.input)).map((reference) => reference.url)).toEqual([`data:image/png;base64,${rootPixel.toString('base64')}`, `data:image/png;base64,${rootPixel.toString('base64')}`])
    expect(exported.input).not.toContain(file)
    for (const label of ['Inline download', 'Reference download', 'HTML download']) expect(exported.html).toContain(label)
    expect(exported.result.warnings).toMatch(/危险的 Markdown/); expect(exported.result.warnings).not.toMatch(/未能嵌入|Could not fetch/)
    expect(await readFile(image)).toEqual(rootPixel); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it('embeds relative and root-slash images from a local metadata base using the original workspace authorization', async () => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), assets = path.join(workspace, 'assets')
    await mkdir(notes, { recursive: true }); await mkdir(assets)
    const source = path.join(notes, 'post.md'), markdown = rootMarkdown('../assets', '![Relative](cover.png?cache=1#图)\n\n![Root slash](/cover.png)')
    await writeFile(source, markdown); await writeFile(path.join(assets, 'cover.png'), rootPixel); await writeFile(path.join(notes, 'cover.png'), accidentalPixel)
    const service = new PandocService(path.join(directory, 'settings.json'), executable)
    const exported = await exportImageBytes(service, markdown, source, workspace)
    expect(exported.images).toEqual([rootPixel, rootPixel]); expect(exported.result.warnings).not.toMatch(/未能嵌入|Could not fetch/)
    expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it('uses each current raw Markdown snapshot rather than the disk metadata or an earlier export context', async () => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), first = path.join(workspace, 'first'), second = path.join(workspace, 'second')
    await mkdir(notes, { recursive: true }); await mkdir(first); await mkdir(second)
    await writeFile(path.join(first, 'cover.png'), rootPixel); await writeFile(path.join(second, 'cover.png'), accidentalPixel)
    const source = path.join(notes, 'post.md'), diskMarkdown = rootMarkdown('../first'), currentMarkdown = rootMarkdown('../second')
    await writeFile(source, diskMarkdown)
    const service = new PandocService(path.join(directory, 'settings.json'), executable)
    expect((await exportImageBytes(service, currentMarkdown, source, workspace, 'current.html')).images).toEqual([accidentalPixel])
    expect((await exportImageBytes(service, diskMarkdown, source, workspace, 'first.html')).images).toEqual([rootPixel])
    expect(await readFile(source, 'utf8')).toBe(diskMarkdown)
  })
  it('does not turn a metadata root outside the authorized workspace into a new file grant', async () => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), outside = path.join(directory, 'outside')
    await mkdir(notes, { recursive: true }); await mkdir(outside)
    const source = path.join(notes, 'post.md'), markdown = rootMarkdown('../../outside')
    await writeFile(source, markdown); await writeFile(path.join(outside, 'cover.png'), rootPixel); await writeFile(path.join(notes, 'cover.png'), accidentalPixel)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, workspace)
    expect(exported.images).toEqual([]); expect(exported.result.warnings).toMatch(/未能嵌入图片/)
    expect(exported.html).not.toContain(rootPixel.toString('base64')); expect(exported.html).not.toContain(accidentalPixel.toString('base64'))
    expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it('retains the document-directory authorization when no workspace root was supplied', async () => {
    const notes = path.join(directory, 'notes'), assets = path.join(directory, 'assets')
    await mkdir(notes); await mkdir(assets)
    const source = path.join(notes, 'post.md'), markdown = rootMarkdown('../assets')
    await writeFile(source, markdown); await writeFile(path.join(assets, 'cover.png'), rootPixel)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source)
    expect(exported.images).toEqual([]); expect(exported.result.warnings).toMatch(/未能嵌入图片/); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it('checks the real target of a root-directory symlink or Windows junction before embedding', async () => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), outside = path.join(directory, 'outside'), link = path.join(workspace, 'linked-assets')
    await mkdir(notes, { recursive: true }); await mkdir(outside); await writeFile(path.join(outside, 'cover.png'), rootPixel)
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const source = path.join(notes, 'post.md'), markdown = rootMarkdown('../linked-assets'); await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, workspace)
    expect(exported.images).toEqual([]); expect(exported.result.warnings).toMatch(/未能嵌入图片/); expect(exported.html).not.toContain(rootPixel.toString('base64'))
    expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it.each([
    { kind: 'inline Markdown', image: '![Correct](a&amp;amp;b.png)' },
    { kind: 'reference definition', image: '![Correct][cover]\n\n[cover]: a&amp;amp;b.png "Keep title"' },
    { kind: 'HTML image', image: '<img src="a&amp;amp;b.png" alt="Correct">' },
  ])('does not repeat HTML entity decoding for $kind resource values', async ({ image }) => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), assets = path.join(workspace, 'assets')
    await mkdir(notes, { recursive: true }); await mkdir(assets)
    await writeFile(path.join(assets, 'a&amp;b.png'), rootPixel); await writeFile(path.join(assets, 'a&b.png'), accidentalPixel)
    const source = path.join(notes, 'post.md'), markdown = rootMarkdown('../assets', image); await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, workspace)
    expect(exported.images).toEqual([rootPixel]); expect(exported.result.warnings).not.toMatch(/未能嵌入|Could not fetch/)
    expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it('decodes root and image URI paths once while excluding the original query and fragment from the file path', async () => {
    const workspace = path.join(directory, 'workspace'), notes = path.join(workspace, 'notes'), assets = path.join(workspace, 'assets%20folder'), accidental = path.join(workspace, 'assets folder')
    await mkdir(notes, { recursive: true }); await mkdir(assets); await mkdir(accidental)
    const nativeName = '中文%20#(图).png', encodedName = encodeURIComponent(nativeName).replace(/[()]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
    await writeFile(path.join(assets, nativeName), rootPixel); await writeFile(path.join(accidental, '中文 #(图).png'), accidentalPixel)
    const source = path.join(notes, 'post.md'), markdown = rootMarkdown('../assets%2520folder', `![Encoded](${encodedName}?cache=%2520#frame)`); await writeFile(source, markdown)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source, workspace)
    expect(exported.images).toEqual([rootPixel]); expect(exported.result.warnings).not.toMatch(/未能嵌入|Could not fetch/); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it.each([{ name: 'number', root: 7 }, { name: 'array', root: ['assets'] }, { name: 'invalid URI escape', root: '%ZZ' }])('retains the document-directory fallback for $name metadata root', async ({ root }) => {
    const notes = path.join(directory, 'notes'); await mkdir(notes)
    const source = path.join(notes, 'post.md'), markdown = rootMarkdown(root); await writeFile(source, markdown); await writeFile(path.join(notes, 'cover.png'), rootPixel)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source)
    expect(exported.images).toEqual([rootPixel]); expect(exported.result.warnings).not.toMatch(/未能嵌入|Could not fetch/); expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it.each(['https://example.invalid/assets/', '${filename}.assets', '../assets?mode=1'])('does not guess a document-directory fallback for unsupported metadata root %s', async (root) => {
    const notes = path.join(directory, 'notes'); await mkdir(notes)
    const source = path.join(notes, 'post.md'), markdown = rootMarkdown(root); await writeFile(source, markdown); await writeFile(path.join(notes, 'cover.png'), accidentalPixel)
    const exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, source)
    expect(exported.images).toEqual([]); expect(exported.result.warnings).toMatch(/未能嵌入图片/); expect(exported.html).not.toContain(accidentalPixel.toString('base64'))
    expect(await readFile(source, 'utf8')).toBe(markdown)
  })
  it('does not read local images for an untitled document even with an absolute metadata base', async () => {
    const assets = path.join(directory, 'assets'); await mkdir(assets); await writeFile(path.join(assets, 'cover.png'), rootPixel)
    const markdown = rootMarkdown(assets), exported = await exportImageBytes(new PandocService(path.join(directory, 'settings.json'), executable), markdown, null, directory)
    expect(exported.images).toEqual([]); expect(exported.html).not.toContain(rootPixel.toString('base64'))
  })
  it.each(['---\ntypora-root-url: [\n---\n', '---\ntypora-root-url: ../one\ntypora-root-url: ../two\n---\n'])('keeps the original Markdown and existing destination when root metadata is malformed', async (frontMatter) => {
    const source = path.join(directory, 'post.md'), target = path.join(directory, 'kept.html'), markdown = frontMatter + '\n![Cover](cover.png)\n'
    await writeFile(source, markdown); await writeFile(target, 'Existing destination'); await writeFile(path.join(directory, 'cover.png'), rootPixel)
    const service = new PandocService(path.join(directory, 'settings.json'), executable)
    await expect(service.exportDocument(71, pandocExportSchema.parse({ markdown, sourcePath: source, suggestedName: 'kept', format: 'html5' }), target, directory)).rejects.toThrow(/YAML|元数据/)
    expect(await readFile(source, 'utf8')).toBe(markdown); expect(await readFile(target, 'utf8')).toBe('Existing destination')
  })
  it('retains an externally changed output instead of replacing it', async () => {
    const service = new PandocService(path.join(directory, 'settings.json'), executable), target = path.join(directory, 'output.txt')
    await writeFile(target, 'original')
    await expect(service.exportDocument(1, pandocExportSchema.parse({ markdown: 'converted', sourcePath: null, suggestedName: 'output', format: 'plain' }), target, undefined, (progress) => { if (progress.stage === 'converting') writeFileSync(target, 'external version') })).rejects.toThrow('外部修改')
    expect(await readFile(target, 'utf8')).toBe('external version')
  })
  it('uses a selected Word reference document with the sandbox enabled', async () => {
    const service = new PandocService(path.join(directory, 'settings.json'), executable)
    const reference = path.join(directory, 'reference.docx'), output = path.join(directory, 'styled.docx')
    await service.exportDocument(1, pandocExportSchema.parse({ markdown: '# Reference\n\nText', sourcePath: null, suggestedName: 'reference', format: 'docx' }), reference)
    await service.configure({ referenceDocumentPath: reference })
    await service.exportDocument(1, pandocExportSchema.parse({ markdown: '# Styled\n\n正文', sourcePath: null, suggestedName: 'styled', format: 'docx', options: { useReferenceDocument: true } }), output)
    expect((await readFile(output)).subarray(0, 2).toString()).toBe('PK')
  })
  it('exports safe standalone HTML without losing underline, table or math text', async () => {
    const service = new PandocService(path.join(directory, 'settings.json'), executable), target = path.join(directory, 'safe.html')
    await service.exportDocument(1, pandocExportSchema.parse({ markdown: '# 标题\n\n<u onclick="alert(1)">下划线</u> <script>alert(2)</script>\n\n[bad](javascript:alert%283%29)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$x^2$\n\n```{=html}\n<script>literal code</script>\n```\n', sourcePath: null, suggestedName: 'safe', format: 'html5' }), target)
    const html = await readFile(target, 'utf8')
    expect(html).toMatch(/Content-Security-Policy/)
    expect(html).toMatch(/<u>下划线<\/u>/)
    expect(html).toMatch(/<table>/)
    expect(html).toMatch(/x/)
    expect(html).not.toMatch(/<script|onclick=|href="javascript:/i)
    expect(html).toMatch(/literal code/)
  })
  it('converts enabled inline extensions and honors disabled superscript and emoji', async () => {
    const service = new PandocService(path.join(directory, 'settings.json'), executable), target = path.join(directory, 'extensions.html')
    const markdown = '# Title :smile:\n\n==Marked== x^2^ H~2~O <u>line</u> :thumbsup:\n\n```\n==raw== :smile:\n```\n'
    await service.exportDocument(1, pandocExportSchema.parse({ markdown, sourcePath: null, suggestedName: 'extensions', format: 'html5' }), target)
    const html = await readFile(target, 'utf8')
    expect(html).toMatch(/<mark>Marked<\/mark>/)
    expect(html).toMatch(/<sup>2<\/sup>/)
    expect(html).toMatch(/<sub>2<\/sub>/)
    expect(html).toMatch(/👍/)
    expect(html).toMatch(/==raw== :smile:/)
    await service.exportDocument(1, pandocExportSchema.parse({ markdown, sourcePath: null, suggestedName: 'extensions', format: 'html5', extensions: { superscript: false, emoji: false } }), target)
    const disabled = await readFile(target, 'utf8')
    expect(disabled).toMatch(/x\^2\^/)
    expect(disabled).toMatch(/:thumbsup:/)
  })
  it('persists a configured runtime and resets to the bundled runtime', async () => {
    const settings = path.join(directory, 'settings.json'), service = new PandocService(settings, executable)
    await service.configure({ executablePath: executable, timeoutSeconds: 45 })
    const restored = new PandocService(settings, executable); await restored.load()
    expect((await restored.detect()).source).toBe('configured')
    await restored.configure({ executablePath: null })
    expect((await restored.detect()).source).toBe('bundled')
  })
})
