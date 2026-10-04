import { createDocumentResourceContext, resolveDocumentResourceCandidate } from '../src/main/document-resources'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { copyMediaAsset, embedDocumentMediaHtml, resolveDocumentMediaUrl, saveMediaAsset } from '../src/main/media-service'
import { maximumEmbeddedMediaBytes, maximumMediaBytes, mediaDataBytes, mediaFormat, mediaFormats, mediaMarkup } from '../src/shared/media'
import { renderDocumentHtml } from '../src/renderer/export-document'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { remarkEditorExtensions } from '../src/shared/markdown-extensions'
import type { Root as MarkdownRoot } from 'mdast'
import { fromHtml } from 'hast-util-from-html'
import type { Root as HtmlRoot, RootContent as HtmlContent } from 'hast'

const temporaryDirectories: string[] = []
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ttypora-media-'))
  temporaryDirectories.push(root)
  const notes = path.join(root, 'notes'); await mkdir(notes)
  const documentPath = path.join(notes, '媒体笔记.md'); await writeFile(documentPath, '# Media')
  return { root, notes, documentPath }
}
async function sparse(filePath: string, size: number) { const handle = await open(filePath, 'w'); try { await handle.truncate(size) } finally { await handle.close() } }
function rootMarkdown(value: string) { return `---\ntypora-root-url: ${JSON.stringify(value)}\n---\n\n# Media snapshot` }

describe('authorized document media', () => {
  it('copies chooser files without changing originals and allocates exclusive encoded names concurrently', async () => {
    const { root, documentPath } = await fixture()
    const source = path.join(root, '示例 100%.mp3'), bytes = Buffer.alloc(1024 * 1024 + 17)
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
    await writeFile(source, bytes)
    const [first, second] = await Promise.all([copyMediaAsset(createDocumentResourceContext(documentPath, ''), source), copyMediaAsset(createDocumentResourceContext(documentPath, ''), source)])
    expect(first.path).not.toBe(second.path)
    expect(first.markdownUrl).toMatch(/%E5%AA%92%E4%BD%93%E7%AC%94%E8%AE%B0\.assets\/%E7%A4%BA%E4%BE%8B%20100%25(?:-1)?\.mp3$/)
    expect(first).toMatchObject({ kind: 'audio', mimeType: 'audio/mpeg', size: bytes.length })
    expect((await readFile(source)).equals(bytes)).toBe(true)
    expect((await readFile(first.path)).equals(bytes)).toBe(true)
    expect((await readFile(second.path)).equals(bytes)).toBe(true)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), first.markdownUrl)).resolves.toBe(pathToFileURL(first.path).href)
  })

  it('supports paste MIME aliases and all required formats with stable insertion markup', async () => {
    const { documentPath } = await fixture()
    const pasted = await saveMediaAsset(createDocumentResourceContext(documentPath, ''), { fileName: 'CON', mimeType: 'audio/x-wav', bytes: new Uint8Array([1, 2]) })
    expect(pasted.path).toMatch(/media\.wav$/)
    expect(pasted).toMatchObject({ kind: 'audio', mimeType: 'audio/wav', size: 2 })
    for (const format of mediaFormats) expect(mediaFormat(`clip${format.extension}`)).toEqual(format)
    expect(mediaFormat('clip.webm', 'audio/webm')).toMatchObject({ kind: 'audio' })
    expect(mediaMarkup('a&"<.mp4', 'video', 'my "title"')).toContain('controls preload="none" playsinline src="a&amp;&quot;&lt;.mp4" title="my &quot;title&quot;"')
  })

  it('rejects unsupported, empty and oversized input before leaving copied assets', async () => {
    const { root, notes, documentPath } = await fixture()
    await expect(saveMediaAsset(createDocumentResourceContext(documentPath, ''), { fileName: 'bad.exe', mimeType: '', bytes: new Uint8Array([1]) })).rejects.toThrow(/不支持/)
    await expect(saveMediaAsset(createDocumentResourceContext(documentPath, ''), { fileName: 'empty.mp3', mimeType: 'audio/mpeg', bytes: new Uint8Array() })).rejects.toThrow()
    await sparse(path.join(root, 'large.mp4'), maximumMediaBytes + 1)
    await expect(copyMediaAsset(createDocumentResourceContext(documentPath, ''), path.join(root, 'large.mp4'))).rejects.toThrow(/100 MB/)
    expect(await readdir(notes)).toEqual(['媒体笔记.md'])
  })

  it('rejects asset-directory junction escapes and existing out-of-root media symlinks', async () => {
    const { root, notes, documentPath } = await fixture()
    const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'clip.mp4'), 'video')
    await symlink(outside, path.join(notes, '媒体笔记.assets'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(saveMediaAsset(createDocumentResourceContext(documentPath, ''), { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: new Uint8Array([1]) })).rejects.toThrow(/超出/)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), '媒体笔记.assets/clip.mp4')).rejects.toThrow(/授权/)
    expect(await readdir(outside)).toEqual(['clip.mp4'])
  })

  it('resolves relative encoded paths, file URLs and authorized workspace siblings while enforcing real boundaries', async () => {
    const { root, notes, documentPath } = await fixture()
    const source = path.join(notes, '声音 %.ogg'), outside = path.join(root, 'outside.mp4')
    await writeFile(source, 'sound'); await writeFile(outside, 'video')
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), `${encodeURIComponent('声音 %.ogg')}?raw=1#time`)).resolves.toBe(pathToFileURL(source).href)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), pathToFileURL(source).href)).resolves.toBe(pathToFileURL(source).href)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), '../outside.mp4')).rejects.toThrow(/授权/)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), '../outside.mp4', root)).resolves.toBe(pathToFileURL(outside).href)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), 'javascript:alert(1)')).rejects.toThrow(/协议/)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), '%ZZ.mp4')).rejects.toThrow(/编码/)
    await sparse(path.join(notes, 'too-large.mp4'), maximumMediaBytes + 1)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), 'too-large.mp4')).rejects.toThrow(/100 MB/)
  })

  it('validates data references and resolves remote metadata without fetching', async () => {
    const { documentPath } = await fixture()
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), '//example.invalid/a.mp3')).resolves.toBe('https://example.invalid/a.mp3')
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), 'https://example.invalid/a.mp3')).resolves.toBe('https://example.invalid/a.mp3')
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), 'data:audio/mpeg;base64,AQID')).resolves.toBe('data:audio/mpeg;base64,AQID')
    expect(mediaDataBytes('data:audio/mpeg;base64,AQ==')).toBe(1)
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), 'data:text/html;base64,AQ==')).rejects.toThrow()
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), 'data:audio/mpeg;base64,A===')).rejects.toThrow()
    await expect(resolveDocumentMediaUrl(createDocumentResourceContext(documentPath, ''), 'data:audio/mpeg;base64,')).rejects.toThrow()
  })
})

describe('media preview and offline exports', () => {
  it('promotes complete CommonMark inline media paragraphs to raw HTML editor nodes without rewriting code or ordinary inline markup', () => {
    const audio = '<audio controls src="音频.wav" autoplay onplay="raw()"></audio>'
    const video = '<video poster="cover.png"><source src="clip.webm" type="video/webm"></video>'
    const input = `${audio}\n\n${video}\n\n<u>ordinary underline</u>\n\n\`<audio src="literal.wav"></audio>\``
    const processor = unified().use(remarkParse).use(remarkEditorExtensions)
    const tree = processor.runSync(processor.parse(input), { value: input }) as MarkdownRoot
    expect(tree.children[0]).toMatchObject({ type: 'ttyporaHtmlBlock', value: audio, position: { start: { offset: 0 }, end: { offset: audio.length } } })
    expect(tree.children[1]).toMatchObject({ type: 'ttyporaHtmlBlock', value: video })
    expect(tree.children[2]).toMatchObject({ type: 'paragraph' })
    expect(tree.children[3]).toMatchObject({ type: 'paragraph', children: [{ type: 'inlineCode', value: '<audio src="literal.wav"></audio>' }] })
  })

  it('embeds local audio, nested sources and posters within the output budget and strips active attributes', async () => {
    const { notes, documentPath } = await fixture()
    await writeFile(path.join(notes, 'tone.wav'), Buffer.from([1, 2, 3])); await writeFile(path.join(notes, 'cover.png'), Buffer.from([4, 5, 6]))
    const result = await embedDocumentMediaHtml('<audio autoplay onplay="bad()" src="tone.wav"></audio><video poster="cover.png" srcdoc="bad"><source src="tone.wav" type="audio/wav"></video><iframe src="https://example.invalid"></iframe>', createDocumentResourceContext(documentPath, ''))
    expect(result.html).toContain('src="data:audio/wav;base64,AQID"')
    expect(result.html).toContain('poster="data:image/png;base64,BAUG"')
    expect(result.html).toContain('controls preload="none"')
    expect(result.html).not.toMatch(/autoplay|onplay|srcdoc|<iframe/)
    expect(result.embeddedBytes).toBe(9); expect(result.warnings).toEqual([])
  })

  it('previews ordinary large local files using authorized URLs while standalone HTML supplies a visible placeholder', async () => {
    const { notes, documentPath } = await fixture()
    const source = path.join(notes, 'big.mp4'); await sparse(source, maximumEmbeddedMediaBytes + 1)
    const preview = await embedDocumentMediaHtml('<video src="big.mp4"/>', createDocumentResourceContext(documentPath, ''), undefined, { mode: 'preview' })
    expect(preview.html).toContain(`src="${pathToFileURL(source).href}"`); expect(preview.embeddedBytes).toBe(0); expect(preview.warnings).toEqual([])
    const offline = await embedDocumentMediaHtml('<video src="big.mp4"/>', createDocumentResourceContext(documentPath, ''))
    expect(offline.html).toContain('media-reference-placeholder'); expect(offline.html).toContain('视频引用：big.mp4')
    expect(offline.html).not.toContain('<video'); expect(offline.warnings).toHaveLength(1)
  })

  it('applies both per-file and aggregate embedding limits to local and existing data media', async () => {
    const { notes, documentPath } = await fixture()
    const paths = ['one.mp4', 'two.mp4', 'three.mp4', 'four.mp4']
    await Promise.all(paths.map((name) => sparse(path.join(notes, name), maximumEmbeddedMediaBytes)))
    const result = await embedDocumentMediaHtml(paths.map((name) => `<video src="${name}"></video>`).join(''), createDocumentResourceContext(documentPath, ''))
    expect(result.embeddedBytes).toBe(24 * 1024 * 1024); expect(result.warnings).toHaveLength(1); expect(result.html).toContain('four.mp4')
    const largeData = `data:audio/mpeg;base64,${Buffer.alloc(maximumEmbeddedMediaBytes + 1).toString('base64')}`
    const data = await embedDocumentMediaHtml(`<audio src="${largeData}"></audio>`, createDocumentResourceContext(documentPath, ''))
    expect(data.embeddedBytes).toBe(0); expect(data.warnings).toHaveLength(1); expect(data.html).toContain('嵌入的媒体数据')
  })

  it('counts every repeated file, data reference and poster occurrence against the serialized output budget', async () => {
    const { notes, documentPath } = await fixture()
    await sparse(path.join(notes, 'repeat.mp4'), maximumEmbeddedMediaBytes)
    const fileResult = await embedDocumentMediaHtml('<video src="repeat.mp4"></video>'.repeat(8), createDocumentResourceContext(documentPath, ''))
    expect(fileResult.embeddedBytes).toBe(24 * 1024 * 1024)
    expect(fileResult.html.match(/src="data:video\/mp4/g)).toHaveLength(3)
    expect(fileResult.warnings).toHaveLength(5)
    const data = `data:audio/mpeg;base64,${Buffer.alloc(maximumEmbeddedMediaBytes).toString('base64')}`
    const dataResult = await embedDocumentMediaHtml(`<audio src="${data}"></audio>`.repeat(4), createDocumentResourceContext(documentPath, ''))
    expect(dataResult.embeddedBytes).toBe(24 * 1024 * 1024)
    expect(dataResult.html.match(/src="data:audio\/mpeg/g)).toHaveLength(3)
    expect(dataResult.warnings).toHaveLength(1)
    await sparse(path.join(notes, 'poster.png'), maximumEmbeddedMediaBytes)
    const posterResult = await embedDocumentMediaHtml('<video poster="poster.png" src="missing.mp4"></video>'.repeat(4), createDocumentResourceContext(documentPath, ''), undefined, { mode: 'print' })
    expect(posterResult.embeddedBytes).toBe(24 * 1024 * 1024)
    expect(posterResult.html.match(/src="data:image\/png/g)).toHaveLength(3)
    expect(posterResult.warnings).toHaveLength(1)
  })

  it('prints an identifiable static media reference and safe poster instead of losing native controls', async () => {
    const { notes, documentPath } = await fixture()
    await writeFile(path.join(notes, 'cover.png'), 'png')
    const result = await embedDocumentMediaHtml('<video title="My clip" poster="cover.png"><source src="clip.webm"></video><audio src="tone.wav"/>', createDocumentResourceContext(documentPath, ''), undefined, { mode: 'print' })
    expect(result.html).not.toMatch(/<video|<audio|<source/)
    expect(result.html).toContain('视频引用：clip.webm（在原文档中播放）'); expect(result.html).toContain('音频引用：tone.wav')
    expect(result.html).toContain('src="data:image/png;base64,cG5n"'); expect(result.warnings).toEqual([])
  })

  it('leaves remote references explicitly clickable without resource src or autoplay in every mode', async () => {
    for (const mode of ['embed', 'preview', 'print'] as const) {
      const result = await embedDocumentMediaHtml('<audio src="https://example.invalid/a.mp3" autoplay></audio>', createDocumentResourceContext(null, ''), undefined, { mode })
      expect(result.html).not.toContain('src="https:'); expect(result.html).not.toContain('autoplay')
      expect(result.html).toContain('href="https://example.invalid/a.mp3"'); expect(result.html).toContain('打开远程媒体')
    }
  })

  it('localizes generated print captions while retaining literal user filenames', async () => {
    const result = await embedDocumentMediaHtml('<audio src="我的音频.wav"></audio><video src="中文片名.mp4"></video>', createDocumentResourceContext(null, ''), undefined, { mode: 'print', locale: 'en' })
    expect(result.html).toContain('Audio reference: 我的音频.wav')
    expect(result.html).toContain('Video reference: 中文片名.mp4')
    expect(result.html).not.toContain('音频引用：')
  })

  it('does not keep unauthorized resources on source tags outside a supported media parent', async () => {
    const result = await embedDocumentMediaHtml('<source src="file:///private.mp4"><div><source src="https://example.invalid/remote.mp4" srcset="private.mp4 2x"></div>', createDocumentResourceContext(null, ''), undefined, { mode: 'preview' })
    expect(result.html).not.toMatch(/\bsrc=|srcset=|data-media-remote=/)
  })

  it('exports safe HTML media and Typora shorthand without consuming subsequent Markdown or changing code', async () => {
    const markdown = '<video src="clip.mp4" autoplay onplay="bad()" poster="cover.png" />\n\n# After video\n\n<audio src="https://example.invalid/a.mp3"></audio>\n\n<div style="background-image:url(file:///private.png)">Styles stay in source</div>\n\n<iframe src="https://example.invalid"></iframe>\n\n```html\n<video src="literal.mp4" />\n```'
    const html = await renderDocumentHtml(markdown, 'Media')
    expect(html).toContain('<video src="clip.mp4" poster="cover.png" controls preload="none"></video>')
    expect(html).toContain('<h1 id="after-video">After video</h1>')
    expect(html).toContain('data-media-remote="https://example.invalid/a.mp3"')
    expect(html).not.toContain('src="https://example.invalid'); expect(html).not.toMatch(/autoplay|onplay|<iframe/)
    expect(html).not.toContain('file:///private.png'); expect(html).toContain('Styles stay in source')
    const codeText: string[] = []
    const textContent = (node: HtmlRoot | HtmlContent): string => node.type === 'text' ? node.value : 'children' in node ? node.children.map(textContent).join('') : ''
    const inspectCode = (node: HtmlRoot | HtmlContent) => { if (node.type === 'element' && node.tagName === 'code') codeText.push(textContent(node)); if ('children' in node) node.children.forEach(inspectCode) }
    inspectCode(fromHtml(html))
    expect(codeText).toEqual(['<video src="literal.mp4" />\n'])
    expect(html).not.toContain('<video src="literal.mp4"')
    const assets = await embedDocumentMediaHtml(html, createDocumentResourceContext(null, ''), undefined, { mode: 'preview' })
    expect(assets.html).toContain('打开远程媒体'); expect(assets.html).toContain('media-reference-placeholder')
  })
})

describe('media resource contexts', () => {
  it('resolves root-relative and slash-prefixed encoded filenames from the raw snapshot', async () => {
    const { notes, documentPath } = await fixture()
    const mediaDirectory = path.join(notes, 'media')
    await mkdir(mediaDirectory)
    const name = '声音 %20&amp;#.ogg', mediaPath = path.join(mediaDirectory, name)
    await writeFile(mediaPath, 'root-media')
    const resources = createDocumentResourceContext(documentPath, rootMarkdown('media'))
    for (const source of [`${encodeURIComponent(name)}?raw=1#time`, `/${encodeURIComponent(name)}?raw=1#time`]) {
      await expect(resolveDocumentMediaUrl(resources, source)).resolves.toBe(pathToFileURL(mediaPath).href)
    }
    await expect(resolveDocumentMediaUrl(resources, `${pathToFileURL(mediaPath).href}?raw=1#time`)).resolves.toBe(pathToFileURL(mediaPath).href)
    expect(await readFile(documentPath, 'utf8')).toBe('# Media')
  })

  it.each(['../shared', 'shared-link'])('does not turn metadata root %s into an authorization grant', async (rootValue) => {
    const { root, notes, documentPath } = await fixture()
    const shared = path.join(root, 'shared')
    await mkdir(shared)
    const source = path.join(shared, 'clip.mp4')
    await writeFile(source, 'private-media')
    if (rootValue === 'shared-link') await symlink(shared, path.join(notes, rootValue), process.platform === 'win32' ? 'junction' : 'dir')
    const resources = createDocumentResourceContext(documentPath, rootMarkdown(rootValue))
    await expect(resolveDocumentMediaUrl(resources, 'clip.mp4')).rejects.toThrow(/授权/)
    await expect(resolveDocumentMediaUrl(resources, '/clip.mp4', root)).resolves.toBe(pathToFileURL(source).href)
  })

  it.each(['---\ntypora-root-url: 42\n---\n', '---\ntypora-root-url: [media]\n---\n', rootMarkdown('%ZZ')])('retains document-directory fallback for invalid root %s', async (markdown) => {
    const { notes, documentPath } = await fixture()
    const source = path.join(notes, 'tone.wav')
    await writeFile(source, 'fallback-media')
    const resources = createDocumentResourceContext(documentPath, markdown)
    expect(resources.root.status).toBe('invalid')
    await expect(resolveDocumentMediaUrl(resources, 'tone.wav')).resolves.toBe(pathToFileURL(source).href)
  })

  it.each(['https://example.invalid/media/', '${filename}', 'media#fragment'])('blocks root-dependent media for unsupported root %s but keeps explicit authorized file URLs', async (rootValue) => {
    const { notes, documentPath } = await fixture()
    const source = path.join(notes, 'tone.wav')
    await writeFile(source, 'explicit-media')
    const resources = createDocumentResourceContext(documentPath, rootMarkdown(rootValue))
    expect(resources.root.status).toBe('unsupported')
    await expect(resolveDocumentMediaUrl(resources, 'tone.wav')).rejects.toThrow(/资源根/)
    await expect(resolveDocumentMediaUrl(resources, '/tone.wav')).rejects.toThrow(/资源根/)
    await expect(resolveDocumentMediaUrl(resources, `${pathToFileURL(source).href}?raw=1#time`)).resolves.toBe(pathToFileURL(source).href)
  })

  it.each(['media', '../outside-not-created', 'https://example.invalid/media/', '${filename}', '%ZZ'])('keeps save/copy destinations and source bytes unchanged with root %s', async (rootValue) => {
    const { root, notes, documentPath } = await fixture()
    const resources = createDocumentResourceContext(documentPath, rootMarkdown(rootValue))
    const source = path.join(root, 'source %.mp3'), original = Buffer.from([1, 2, 3, 4])
    await writeFile(source, original)
    const copied = await copyMediaAsset(resources, source)
    const saved = await saveMediaAsset(resources, { fileName: 'source %.mp3', mimeType: 'audio/mpeg', bytes: new Uint8Array([5, 6]) })
    for (const result of [copied, saved]) {
      expect(path.dirname(result.path)).toBe(await realpath(path.join(notes, '媒体笔记.assets')))
      const candidate = resolveDocumentResourceCandidate(resources, result.markdownUrl)
      expect(candidate.kind).toBe('local')
      if (candidate.kind === 'local') expect(fileURLToPath(await resolveDocumentMediaUrl(resources, result.markdownUrl))).toBe(result.path)
      if (resources.root.status === 'unsupported') expect(result.markdownUrl).toMatch(/^file:/)
      else if (resources.root.status === 'local') expect(result.markdownUrl).toMatch(/^\.\.\//)
      else expect(result.markdownUrl).toMatch(/^%E5%AA%92%E4%BD%93%E7%AC%94%E8%AE%B0\.assets\//)
    }
    if (rootValue === '%ZZ') expect(resources.root.status).toBe('invalid')
    expect(await readFile(source)).toEqual(original)
    expect(await readFile(copied.path)).toEqual(original)
    expect(await readFile(saved.path)).toEqual(Buffer.from([5, 6]))
    expect(await readdir(root)).toEqual(['notes', 'source %.mp3'])
    expect(await readFile(documentPath, 'utf8')).toBe('# Media')
  })

  it('rejects foreign-platform document/candidate contexts and untitled roots before local filesystem access', async () => {
    const { documentPath } = await fixture()
    const foreignPath = process.platform === 'win32' ? '/foreign/note.md' : 'C:\\foreign\\note.md'
    const foreign = createDocumentResourceContext(foreignPath, rootMarkdown('media'))
    await expect(resolveDocumentMediaUrl(foreign, 'tone.wav')).rejects.toThrow(/平台/)
    await expect(saveMediaAsset(foreign, { fileName: 'tone.wav', mimeType: 'audio/wav', bytes: new Uint8Array([1]) })).rejects.toThrow(/平台/)
    await expect(copyMediaAsset(foreign, 'a-nonexistent-chooser-file.wav')).rejects.toThrow(/平台/)
    const nativeDocumentForeignRoot = { ...createDocumentResourceContext(documentPath, ''), root: foreign.root }
    await expect(resolveDocumentMediaUrl(nativeDocumentForeignRoot, '/tone.wav')).rejects.toThrow(/平台/)
    const untitled = createDocumentResourceContext(null, rootMarkdown('file:///tmp/'))
    await expect(resolveDocumentMediaUrl(untitled, 'tone.wav')).rejects.toThrow(/尚未保存/)
    await expect(saveMediaAsset(untitled, { fileName: 'tone.wav', mimeType: 'audio/wav', bytes: new Uint8Array([1]) })).rejects.toThrow(/尚未保存/)
    await expect(copyMediaAsset(untitled, 'a-nonexistent-chooser-file.wav')).rejects.toThrow(/尚未保存/)
  })

  it('shares one context across audio, video source and poster in preview/embed/print', async () => {
    const { notes, documentPath } = await fixture()
    const mediaDirectory = path.join(notes, 'media')
    await mkdir(mediaDirectory)
    await writeFile(path.join(mediaDirectory, 'tone.wav'), Buffer.from([1, 2, 3]))
    await writeFile(path.join(mediaDirectory, 'clip.mp4'), Buffer.from([4, 5, 6]))
    await writeFile(path.join(mediaDirectory, 'cover.png'), Buffer.from([7, 8, 9]))
    const resources = createDocumentResourceContext(documentPath, rootMarkdown('media'))
    const html = '<audio src="/tone.wav"></audio><video poster="/cover.png"><source src="clip.mp4"></video>'
    const preview = await embedDocumentMediaHtml(html, resources, undefined, { mode: 'preview' })
    expect(preview.html).toContain(`src="${pathToFileURL(path.join(mediaDirectory, 'tone.wav')).href}"`)
    expect(preview.html).toContain(`src="${pathToFileURL(path.join(mediaDirectory, 'clip.mp4')).href}"`)
    expect(preview.html).toMatch(/poster="file:[^"]*cover\.png\?ttypora-version=/)
    expect(preview.warnings).toEqual([])
    const embedded = await embedDocumentMediaHtml(html, resources)
    expect(embedded.html).toContain('src="data:audio/wav;base64,AQID"')
    expect(embedded.html).toContain('src="data:video/mp4;base64,BAUG"')
    expect(embedded.html).toContain('poster="data:image/png;base64,BwgJ"')
    expect(embedded.embeddedBytes).toBe(9)
    expect(embedded.warnings).toEqual([])
    const printed = await embedDocumentMediaHtml(html, resources, undefined, { mode: 'print' })
    expect(printed.html).not.toMatch(/<audio|<video|<source/)
    expect(printed.html).toContain('src="data:image/png;base64,BwgJ"')
    expect(printed.warnings).toEqual([])
  })

  it('preserves existing remote/data policy and rejects blob media under unsupported metadata', async () => {
    const resources = createDocumentResourceContext(null, rootMarkdown('https://example.invalid/root/'))
    await expect(resolveDocumentMediaUrl(resources, '//example.invalid/tone.wav')).resolves.toBe('https://example.invalid/tone.wav')
    await expect(resolveDocumentMediaUrl(resources, 'data:audio/wav;base64,AQ==')).resolves.toBe('data:audio/wav;base64,AQ==')
    await expect(resolveDocumentMediaUrl(resources, 'blob:https://example.invalid/id')).rejects.toThrow()
  })

  it('formats the lexical document alias while saving media to its checked real directory', async () => {
    const { root, notes } = await fixture()
    const alias = path.join(root, 'alias')
    await symlink(notes, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const documentPath = path.join(alias, '媒体笔记.md')
    const resources = createDocumentResourceContext(documentPath, rootMarkdown('media'))
    const result = await saveMediaAsset(resources, { fileName: 'tone.wav', mimeType: 'audio/wav', bytes: new Uint8Array([1]) })
    const lexicalTarget = path.join(alias, '媒体笔记.assets', 'tone.wav')
    expect(resolveDocumentResourceCandidate(resources, result.markdownUrl)).toMatchObject({ kind: 'local', candidatePath: lexicalTarget })
    expect(result.path).toBe(await realpath(lexicalTarget))
    await expect(resolveDocumentMediaUrl(resources, result.markdownUrl)).resolves.toBe(pathToFileURL(result.path).href)
    expect(await readFile(result.path)).toEqual(Buffer.from([1]))
  })

  it('does not allocate a media file if its same-context reference cannot be represented', async () => {
    const { notes, documentPath } = await fixture()
    const resources = createDocumentResourceContext(documentPath, rootMarkdown('media'))
    await expect(saveMediaAsset(resources, { fileName: '\ud800.wav', mimeType: 'audio/wav', bytes: new Uint8Array([1]) })).rejects.toThrow(/生成媒体引用/)
    expect(await readdir(path.join(notes, '媒体笔记.assets'))).toEqual([])
  })
})
