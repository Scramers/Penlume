import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageUploaderService, listImageUploadCandidates, parseImageUploaderOutput, runImageUploader } from '../src/main/image-uploader'
import { listImageLibrary } from '../src/main/image-library'
import { buildImageUploaderArguments, imageUploaderSettingsSchema, imageUploaderConfigurationSchema, type ImageUploadRequest } from '../src/shared/image-uploader'

const directories: string[] = []
const sourceReads = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), filePath = String(args[0])
    const read = handle.read, readFile = handle.readFile, stream = handle.createReadStream
    handle.read = function (...parameters: unknown[]) { sourceReads.add(filePath); return Reflect.apply(read, handle, parameters) } as typeof handle.read
    handle.readFile = function (...parameters: unknown[]) { sourceReads.add(filePath); return Reflect.apply(readFile, handle, parameters) } as typeof handle.readFile
    handle.createReadStream = function (...parameters: unknown[]) { sourceReads.add(filePath); return Reflect.apply(stream, handle, parameters) } as typeof handle.createReadStream
    return handle
  } }
})

function withResourceRoot(root: unknown, body: string, title = ''): string {
  return `---\ntypora-root-url: ${JSON.stringify(root)}\n${title ? `title: ${JSON.stringify(title)}\n` : ''}---\n\n${body}`
}

describe('image uploader document resource roots', () => {
  it('shares library identities for rooted relative/prefix/file/poster aliases and applies under unchanged metadata', async () => {
    const { root, document, service, configure, records } = await fixture(), shared = path.join(root, 'images')
    await mkdir(shared)
    const image = path.join(shared, 'photo name.png'); await writeFile(image, png)
    const body = `![relative](photo%20name.png?download=1#view)\n![prefix](/photo%20name.png?#)\n![absolute](${pathToFileURL(image).href})\n\n<video controls src="movie.mp4" poster="/photo%20name.png?a=1&amp;b=2"></video>\n\n\`![literal](photo%20name.png)\``
    const markdown = withResourceRoot('images', body), candidates = await listImageUploadCandidates(document, markdown, root), snapshot = await listImageLibrary(document, markdown, root)
    expect(candidates).toHaveLength(1); expect(candidates[0].id).toBe(snapshot.items[0].id); expect(candidates[0].version).toEqual(snapshot.items[0].version)
    expect(candidates[0]).toMatchObject({ path: image, references: 4 })
    await configure(); sourceReads.clear()
    const task = await service.upload(1, { documentPath: document, markdown, images: [{ imageId: candidates[0].id, expectedVersion: candidates[0].version! }] }, root)
    expect(task.items[0]).toMatchObject({ status: 'success', sourcePath: image }); expect((await records())[0].bytes).toBe(png.toString('base64'))
    expect(sourceReads.has(path.join(root, 'photo name.png'))).toBe(false)
    const current = withResourceRoot('images', body + '\n\nUnrelated new body text.\n', 'New title')
    const result = await service.apply(1, { documentPath: document, markdown: current, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })
    expect(result.replacedReferences).toBe(4); expect(result.appliedImages).toBe(1)
    expect(result.markdown).toContain('typora-root-url: "images"'); expect(result.markdown).toContain('title: "New title"')
    expect(result.markdown).toContain('src="movie.mp4" poster="https://uploads.invalid/photo%20name.png"')
    expect(result.markdown).toContain('`![literal](photo%20name.png)`'); expect(result.markdown).toContain('Unrelated new body text.')
    expect(await readFile(image)).toEqual(png)
  })

  it('rejects any supported/unsupported root change before image reads, even if an explicit file alias survives and frozen originals were allowed', async () => {
    const { root, document, service, configure } = await fixture(), image = path.join(root, 'photo name.png')
    const body = `![absolute](${pathToFileURL(image).href})`, markdown = withResourceRoot('images', body)
    const candidates = await listImageUploadCandidates(document, markdown, root)
    await configure()
    const task = await service.upload(1, { documentPath: document, markdown, images: [{ imageId: candidates[0].id, expectedVersion: candidates[0].version! }] }, root)
    expect(task.items[0].status).toBe('success')
    for (const changed of [withResourceRoot('other', body), withResourceRoot('./images', body), withResourceRoot('${filename}.assets', body), withResourceRoot('https://example.com/assets/', body), body, `---\ntypora-root-url: [\n---\n\n${body}`]) {
      sourceReads.clear()
      await expect(service.apply(1, { documentPath: document, markdown: changed, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [task.items[0].id] })).rejects.toThrow('资源根或保存位置已改变')
      expect(sourceReads.size).toBe(0)
    }
    expect(await readFile(image)).toEqual(png)
  })

  it('refuses a stale rooted candidate after metadata points to another same-named file without invoking the uploader', async () => {
    const { root, document, service, configure, record } = await fixture()
    for (const name of ['first', 'second']) { await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'photo.png'), png) }
    const markdown = withResourceRoot('first', '![photo](photo.png)'), candidates = await listImageUploadCandidates(document, markdown, root)
    await configure(); sourceReads.clear()
    await expect(service.upload(1, { documentPath: document, markdown: withResourceRoot('second', '![photo](photo.png)'), images: [{ imageId: candidates[0].id, expectedVersion: candidates[0].version! }] }, root)).rejects.toThrow('当前文档引用')
    expect(sourceReads.size).toBe(0); await expect(stat(record)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['${filename}.assets', 'https://example.com/assets/', 'images?query=1'])('ignores root-dependent candidates under unsupported metadata %s but permits explicitly located local files', async (resourceRoot) => {
    const { root, document, service, configure } = await fixture(), image = path.join(root, 'photo name.png')
    const markdown = withResourceRoot(resourceRoot, `![root-dependent](photo%20name.png)\n![explicit](${pathToFileURL(image).href})`)
    const candidates = await listImageUploadCandidates(document, markdown, root), snapshot = await listImageLibrary(document, markdown, root)
    expect(candidates).toHaveLength(1); expect(candidates[0].references).toBe(1)
    expect(candidates[0].id).toBe(snapshot.items.find((item) => item.status === 'local')!.id)
    await configure()
    const task = await service.upload(1, { documentPath: document, markdown, images: [{ imageId: candidates[0].id, expectedVersion: candidates[0].version! }] }, root)
    expect(task.items[0].status).toBe('success')
    const result = await service.apply(1, { documentPath: document, markdown, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })
    expect(result.replacedReferences).toBe(1); expect(result.markdown).toContain('![root-dependent](photo%20name.png)')
    expect(result.markdown).toContain('![explicit](https://uploads.invalid/photo%20name.png)')
  })

  it('keeps metadata outside the existing authorization root and through junctions out of candidates and invocations', async () => {
    const { root, document, service, configure, record, request } = await fixture(), outside = await mkdtemp(path.join(tmpdir(), 'ttypora-uploader-metadata-outside-')); directories.push(outside)
    const external = path.join(outside, 'private.png'); await writeFile(external, png)
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); await configure()
    for (const resourceRoot of [outside, 'linked']) {
      const markdown = withResourceRoot(resourceRoot, '![private](private.png)')
      sourceReads.clear()
      expect(await listImageUploadCandidates(document, markdown, root)).toEqual([])
      const snapshot = await listImageLibrary(document, markdown, root)
      await expect(service.upload(1, { documentPath: document, markdown, images: [{ imageId: snapshot.items[0].id, expectedVersion: request.images[0].expectedVersion }] }, root)).rejects.toThrow('已授权本地图片')
      expect(sourceReads.has(external)).toBe(false)
    }
    await expect(stat(record)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(external)).toEqual(png)
  })

  it('preserves logical document aliases in task identity and in resource location while retaining physical authorization checks', async () => {
    const { root, document, service, configure, records } = await fixture(), nested = path.join(root, 'nested'), logical = path.join(nested, 'alias.md')
    await mkdir(nested); await mkdir(path.join(nested, 'images')); await mkdir(path.join(root, 'images'))
    const image = path.join(nested, 'images', 'photo.png'), logicalBytes = Buffer.concat([png, Buffer.from('logical')])
    await writeFile(image, logicalBytes); await writeFile(path.join(root, 'images', 'photo.png'), Buffer.concat([png, Buffer.from('wrong physical base')]))
    await symlink(document, logical, 'file')
    const markdown = withResourceRoot('images', '![photo](photo.png)'), candidates = await listImageUploadCandidates(logical, markdown, root)
    expect(candidates).toHaveLength(1); expect(candidates[0].path).toBe(image)
    expect(candidates[0].id).toBe((await listImageLibrary(logical, markdown, root)).items[0].id)
    await configure()
    const task = await service.upload(1, { documentPath: logical, markdown, images: [{ imageId: candidates[0].id, expectedVersion: candidates[0].version! }] }, root)
    expect(task.documentPath).toBe(logical); expect(task.items[0].status).toBe('success'); expect((await records())[0].bytes).toBe(logicalBytes.toString('base64'))
    const result = await service.apply(1, { documentPath: logical, markdown, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })
    expect(result.replacedReferences).toBe(1); expect(result.markdown).toContain('https://uploads.invalid/photo.png')
  })

  it('decodes URI and HTML entity source spellings only once before freezing and rewriting', async () => {
    const { root, document, service, configure, records } = await fixture(), shared = path.join(root, 'images')
    await mkdir(shared)
    const image = path.join(shared, 'literal%20&amp;name.png'); await writeFile(image, png)
    const markdown = withResourceRoot('images', '![encoded](literal%2520%26amp%3Bname.png)\n\n<img src="literal%2520&amp;amp;name.png">')
    const candidates = await listImageUploadCandidates(document, markdown, root)
    expect(candidates).toHaveLength(1); expect(candidates[0]).toMatchObject({ path: image, references: 2 })
    await configure()
    const task = await service.upload(1, { documentPath: document, markdown, images: [{ imageId: candidates[0].id, expectedVersion: candidates[0].version! }] }, root)
    expect(task.items[0].status).toBe('success'); expect(path.basename((await records())[0].file)).toBe('literal%20&amp;name.png')
    const result = await service.apply(1, { documentPath: document, markdown, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })
    expect(result.replacedReferences).toBe(2); expect(result.markdown).toContain('https://uploads.invalid/literal%2520%26amp%3Bname.png')
    expect(await readFile(image)).toEqual(png)
  })
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sNQAAAAASUVORK5CYII=', 'base64')
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture(names = ['photo name.png']) {
  const root = await mkdtemp(path.join(tmpdir(), 'ttypora-image-uploader-')); directories.push(root)
  const document = path.join(root, 'note.md'), script = path.join(root, 'mock-uploader.cjs'), record = path.join(root, 'cli-record.jsonl')
  const service = new ImageUploaderService(path.join(root, 'profile', 'image-uploader.json'))
  for (const name of names) await writeFile(path.join(root, name), png)
  const markdown = names.map((name) => `![${name}](<${name}>)`).join('\n')
  await writeFile(document, markdown)
  await writeFile(script, `
const fs = require('node:fs'); const path = require('node:path');
const [file, record, mode, literal] = process.argv.slice(2);
const bytes = fs.readFileSync(file);
fs.appendFileSync(record, JSON.stringify({ file, args: process.argv.slice(2), bytes: bytes.toString('base64') }) + '\\n');
if (mode === 'ambiguous') { console.log(JSON.stringify({ urls: ['https://uploads.invalid/a.png', 'https://uploads.invalid/b.png'] })); }
else if (mode === 'stderr') { console.error('https://uploads.invalid/diagnostic.png'); }
else if (path.basename(file).startsWith('bad')) { console.error('controlled failure'); process.exitCode = 2; }
else if (path.basename(file).startsWith('hang')) { setTimeout(() => console.log('https://uploads.invalid/too-late.png'), 10000); }
else { console.log(JSON.stringify({ urls: ['https://uploads.invalid/' + encodeURIComponent(path.basename(file))] })); }
`)
  const snapshot = await listImageLibrary(document, markdown, root)
  const request: ImageUploadRequest = { documentPath: document, markdown, images: snapshot.items.map((image) => ({ imageId: image.id, expectedVersion: image.version! })) }
  async function configure(mode = 'normal', literal = '') { await service.selectExecutable(process.execPath); await service.configure({ adapter: 'custom', args: [script, '{file}', record, mode, literal], timeoutSeconds: 5 }) }
  async function records() { return (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { file: string; args: string[]; bytes: string }) }
  return { root, document, script, record, service, request, snapshot, configure, records }
}

describe('image uploader configuration and output', () => {
  it('uses an argv array and preserves shell syntax as literal data', () => {
    const settings = imageUploaderSettingsSchema.parse({ executablePath: process.execPath, args: ['upload', '{file}', '--name={file}', '$(touch unsafe) & "literal"'] })
    expect(buildImageUploaderArguments(settings, 'C:\\files\\photo name.png')).toEqual(['upload', 'C:\\files\\photo name.png', '--name=C:\\files\\photo name.png', '$(touch unsafe) & "literal"'])
    expect(imageUploaderConfigurationSchema.safeParse({ adapter: 'custom', args: ['upload'], timeoutSeconds: 5 }).success).toBe(false)
    expect(imageUploaderSettingsSchema.safeParse({ args: ['{file}', 'bad\nargument'] }).success).toBe(false)
    expect(imageUploaderConfigurationSchema.safeParse({ adapter: 'custom', args: ['{file}', 'bad\nargument'], timeoutSeconds: 5 }).success).toBe(false)
    expect(imageUploaderSettingsSchema.safeParse({ timeoutSeconds: 301 }).success).toBe(false)
  })
  it('accepts documented result forms and ignores diagnostic, credential and command URLs', () => {
    expect(parseImageUploaderOutput('{"urls":["https://uploads.invalid/a.png"]}')).toEqual(['https://uploads.invalid/a.png'])
    expect(parseImageUploaderOutput('progress 50%\n[PicGo SUCCESS]\nhttps://uploads.invalid/a.png\n[PicList SUCCESS]: https://uploads.invalid/a.png')).toEqual(['https://uploads.invalid/a.png'])
    expect(parseImageUploaderOutput('[PicGo SUCCESS] {"data":{"imgUrl":"https://uploads.invalid/图片.png"}}')).toEqual(['https://uploads.invalid/%E5%9B%BE%E7%89%87.png'])
    expect(parseImageUploaderOutput('Read docs https://uploads.invalid/debug.png\n[ERROR] https://uploads.invalid/error.png\ncurl https://uploads.invalid/command.png\n{"message":"https://uploads.invalid/diagnostic.png"}\nfile:///private.png\nhttps://user:secret@uploads.invalid/a.png\njavascript:alert(1)')).toEqual([])
    expect(parseImageUploaderOutput('{"success":false,"url":"https://uploads.invalid/a.png"}')).toEqual([])
    expect(parseImageUploaderOutput('https://uploads.invalid/a.png\n{"status":"failed"}')).toEqual([])
    expect(parseImageUploaderOutput('URL: https://uploads.invalid/a.png\nhttps://uploads.invalid/b.png')).toHaveLength(2)
  })
  it('persists explicit configuration without running a program or allowing argv to select one', async () => {
    const { service, root, record, script, request, configure } = await fixture()
    await service.load()
    await expect(service.upload(1, request, root)).rejects.toThrow('尚未配置上传器')
    await configure()
    const change = { adapter: 'custom', args: [script, '{file}', record], timeoutSeconds: 8, executablePath: 'untrusted-program.exe' }
    await service.configure(change as Parameters<typeof service.configure>[0])
    expect(service.getSettings().executablePath).toBe(process.execPath)
    await expect(stat(record)).rejects.toThrow()
    const restored = new ImageUploaderService(path.join(root, 'profile', 'image-uploader.json')); await restored.load()
    expect(restored.getSettings()).toEqual(service.getSettings())
    await service.selectExecutable(null)
    await expect(service.upload(1, request, root)).rejects.toThrow('尚未配置上传器')
    if (process.platform === 'win32') await expect(service.selectExecutable(path.join(root, 'shim.cmd'))).rejects.toThrow('.cmd/.bat')
  })
  it('decodes stdout split inside a UTF-8 character', async () => {
    const { root } = await fixture()
    const script = path.join(root, 'unicode.cjs')
    await writeFile(script, `const b=Buffer.from('https://uploads.invalid/图片.png');const split=b.indexOf(0xe5)+1;process.stdout.write(b.subarray(0,split));setTimeout(()=>process.stdout.write(b.subarray(split)),80);`)
    const output = await runImageUploader(process.execPath, [script], { cwd: root, timeoutMs: 2000, signal: new AbortController().signal })
    expect(output).toBe('https://uploads.invalid/图片.png')
  })
  it('stops and waits for timeout, cancellation and excessive output', async () => {
    const { root } = await fixture()
    await expect(runImageUploader(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 150, signal: new AbortController().signal })).rejects.toThrow('上传超时')
    const controller = new AbortController(), cancel = runImageUploader(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 3000, signal: controller.signal })
    setTimeout(() => controller.abort(), 120)
    await expect(cancel).rejects.toThrow('上传已取消')
    await expect(runImageUploader(process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024));setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 3000, signal: new AbortController().signal })).rejects.toThrow('输出超过限制')
  })
})

describe('explicit image upload tasks', () => {
  it('does not read unrelated assets, other documents or unselected images; expected.path cannot choose a source', async () => {
    const { root, service, request, configure, record } = await fixture(['selected.png', 'unselected.png'])
    await configure()
    const assets = path.join(root, 'note.assets'); await mkdir(assets)
    const orphan = path.join(assets, 'huge.png'), otherImage = path.join(root, 'other-only.png'), unselected = path.join(root, 'unselected.png')
    for (const file of [orphan, otherImage, unselected]) {
      await writeFile(file, png)
      const { open } = await import('node:fs/promises'), handle = await open(file, 'r+')
      try { await handle.truncate(26 * 1024 * 1024) } finally { await handle.close() }
    }
    await writeFile(path.join(root, 'other.md'), '![other](other-only.png)\n![assets](note.assets/huge.png)')
    sourceReads.clear()
    const selectedRequest = { ...request, images: [request.images[0]] }
    expect((await service.upload(1, selectedRequest, root)).items[0].status).toBe('success')
    expect(sourceReads.has(path.join(root, 'selected.png'))).toBe(true)
    for (const file of [orphan, otherImage, unselected]) expect(sourceReads.has(file)).toBe(false)
    sourceReads.clear()
    const candidates = await listImageUploadCandidates(request.documentPath, request.markdown, root)
    expect(candidates.map((item) => item.name)).toEqual(['selected.png'])
    for (const file of [orphan, otherImage, unselected]) expect(sourceReads.has(file)).toBe(false)
    await rm(record); sourceReads.clear()
    const forged = { ...selectedRequest, images: [{ ...request.images[0], expectedVersion: { ...request.images[0].expectedVersion, path: unselected } }] }
    expect((await service.upload(1, forged, root)).items[0].status).toBe('failed')
    expect(sourceReads.has(unselected)).toBe(false); await expect(stat(record)).rejects.toThrow()
  })
  it('keeps candidate identities stable across file URLs, query aliases and video posters', async () => {
    const { root, document, service, configure } = await fixture()
    const fileUrl = pathToFileURL(path.join(root, 'photo name.png')).href
    const markdown = `![inline](photo%20name.png?download=1#view)\n![file](${fileUrl})\n![ref][shared]\n[ordinary][shared]\n\n[shared]: <photo name.png> "caption"\n\n<img src="photo%20name.png">\n<video controls src="movie.mp4" poster="photo%20name.png"></video>`
    const candidates = await listImageUploadCandidates(document, markdown, root), snapshot = await listImageLibrary(document, markdown, root)
    expect(candidates).toHaveLength(1); expect(candidates[0].id).toBe(snapshot.items[0].id); expect(candidates[0].version).toEqual(snapshot.items[0].version)
    expect(candidates[0].references).toBe(5)
    await configure()
    const task = await service.upload(1, { documentPath: document, markdown, images: [{ imageId: candidates[0].id, expectedVersion: candidates[0].version! }] }, root)
    const applied = await service.apply(1, { documentPath: document, markdown, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })
    expect(applied.replacedReferences).toBe(5)
    expect(applied.markdown).toContain('src="movie.mp4" poster="https://uploads.invalid/photo%20name.png"')
    expect(applied.markdown).toContain('[ordinary][shared]\n\n[shared]: <photo name.png> "caption"')
  })
  it('uploads frozen copies, reports progress and rewrites only image uses on explicit apply', async () => {
    const { service, root, document, request, configure, records } = await fixture()
    const markdown = '![inline](photo%20name.png)\n![ref][shared]\n[ordinary][shared]\n\n[shared]: <photo name.png> "caption"\n\n<img src="photo%20name.png" alt="html">\n\n`![literal](photo%20name.png)`'
    const snapshot = await listImageLibrary(document, markdown, root)
    request.markdown = markdown; request.images = snapshot.items.map((item) => ({ imageId: item.id, expectedVersion: item.version! }))
    await configure('normal', '$(touch unsafe) & "literal"')
    const states: string[] = []
    const task = await service.upload(1, request, root, (event) => { states.push(event.task.items[0].status); expect(event.total).toBe(1) })
    expect(task.status).toBe('complete'); expect(task.items[0].status).toBe('success')
    expect(states).toContain('freezing'); expect(states).toContain('uploading'); expect(states).toContain('success')
    const [record] = await records()
    expect(record.file).not.toBe(path.join(root, 'photo name.png')); expect(record.bytes).toBe(png.toString('base64'))
    expect(record.args.at(-1)).toBe('$(touch unsafe) & "literal"')
    await expect(stat(record.file)).rejects.toThrow()
    expect(await readFile(document, 'utf8')).toBe('![photo name.png](<photo name.png>)')
    const result = await service.apply(1, { documentPath: document, markdown, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })
    expect(result.appliedImages).toBe(1); expect(result.replacedReferences).toBe(3)
    expect(result.markdown).toContain('![inline](https://uploads.invalid/photo%20name.png)')
    expect(result.markdown).toContain('![ref](https://uploads.invalid/photo%20name.png "caption")')
    expect(result.markdown).toContain('src="https://uploads.invalid/photo%20name.png"')
    expect(result.markdown).toContain('[ordinary][shared]\n\n[shared]: <photo name.png> "caption"')
    expect(result.markdown).toContain('`![literal](photo%20name.png)`')
    expect(await readFile(path.join(root, 'photo name.png'))).toEqual(png)
    expect(await service.getTask(2, task.id)).toBeNull()
    await expect(service.apply(2, { documentPath: document, markdown, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })).rejects.toThrow('不属于')
  })
  it('preserves partial success and applies only selected successful results', async () => {
    const { service, root, request, configure } = await fixture(['good.png', 'bad.png'])
    await configure()
    const task = await service.upload(1, request, root)
    expect(task.items.map((item) => item.status)).toEqual(['success', 'failed'])
    expect(task.items[1].error).toContain('controlled failure')
    const result = await service.apply(1, { ...request, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })
    expect(result.markdown).toContain('https://uploads.invalid/good.png'); expect(result.markdown).toContain('![bad.png](<bad.png>)')
    await expect(service.apply(1, { ...request, taskId: task.id, selectedItemIds: [task.items[1].id], allowChangedOriginals: [] })).rejects.toThrow('只能应用已成功')
  })
  it('cancels the active invocation while preserving earlier success and untouched originals', async () => {
    const { service, root, request, configure } = await fixture(['good.png', 'hang.png', 'last.png'])
    await configure()
    const task = await service.upload(1, request, root, (event) => { if (event.task.items[1].status === 'uploading') setTimeout(() => service.cancel(1), 150) })
    expect(task.status).toBe('cancelled'); expect(task.items.map((item) => item.status)).toEqual(['success', 'cancelled', 'cancelled'])
    expect((await service.getTask(1, task.id))?.items[0].url).toBe('https://uploads.invalid/good.png')
    for (const item of task.items) expect(await readFile(item.sourcePath)).toEqual(png)
    const result = await service.apply(1, { ...request, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })
    expect(result.markdown).toContain('https://uploads.invalid/good.png'); expect(result.markdown).toContain('![hang.png](<hang.png>)')
  })
  it('rejects overlapping tasks before asynchronous preparation completes', async () => {
    const { service, root, request, configure } = await fixture()
    await configure()
    const first = service.upload(1, request, root)
    await expect(service.upload(1, request, root)).rejects.toThrow('已有图片上传任务')
    expect((await first).items[0].status).toBe('success')
  })
  it('freezes original bytes and requires explicit review after an external edit', async () => {
    const { service, root, request, configure, records } = await fixture()
    await configure()
    const original = path.join(root, 'photo name.png'), edited = Buffer.concat([png, Buffer.from('new external version')])
    const task = await service.upload(1, request, root, (event) => { if (event.task.items[0].status === 'uploading') writeFileSync(original, edited) })
    expect(task.items[0]).toMatchObject({ status: 'success', sourceChanged: true })
    expect((await records())[0].bytes).toBe(png.toString('base64')); expect(await readFile(original)).toEqual(edited)
    await expect(service.apply(1, { ...request, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })).rejects.toThrow('冻结版本')
    const result = await service.apply(1, { ...request, taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [task.items[0].id] })
    expect(result.markdown).toContain('https://uploads.invalid/photo%20name.png'); expect(await readFile(original)).toEqual(edited)
  })
  it('rejects stale versions, disguised non-images and unreferenced sources before invocation', async () => {
    const { service, root, request, configure, record, document } = await fixture()
    await configure()
    await appendFile(path.join(root, 'photo name.png'), 'external edit')
    expect((await service.upload(1, request, root)).items[0]).toMatchObject({ status: 'failed', url: null })
    await expect(stat(record)).rejects.toThrow()
    await writeFile(path.join(root, 'secret.png'), 'not image credentials')
    const markdown = '![disguised](secret.png)', snapshot = await listImageLibrary(document, markdown, root)
    const disguised = await service.upload(1, { ...request, markdown, images: [{ imageId: snapshot.items[0].id, expectedVersion: snapshot.items[0].version! }] }, root)
    expect(disguised.items[0].error).toContain('不是受支持的图片'); await expect(stat(record)).rejects.toThrow()
    await expect(service.upload(1, { ...request, markdown: '# no image' }, root)).rejects.toThrow('当前文档引用')
  })
  it('does not upload outside paths or paths routed through a symlink directory', async () => {
    const { service, root, document, request, configure, record } = await fixture()
    await configure()
    const external = await mkdtemp(path.join(tmpdir(), 'ttypora-uploader-outside-')); directories.push(external)
    await writeFile(path.join(external, 'private.png'), png)
    const junction = path.join(root, 'linked'); await symlink(external, junction, process.platform === 'win32' ? 'junction' : 'dir')
    for (const markdown of [`![outside](<${path.join(external, 'private.png').replaceAll('\\', '/')}>)`, '![symlink](linked/private.png)']) {
      const snapshot = await listImageLibrary(document, markdown, root)
      await expect(service.upload(1, { ...request, markdown, images: [{ imageId: snapshot.items[0].id, expectedVersion: request.images[0].expectedVersion }] }, root)).rejects.toThrow('已授权本地图片')
    }
    await expect(stat(record)).rejects.toThrow(); expect(await readFile(path.join(external, 'private.png'))).toEqual(png)
  })
  it('keeps ambiguous and stderr-only results failed and refuses changed document references', async () => {
    const { service, root, request, configure } = await fixture()
    await configure('ambiguous')
    expect((await service.upload(1, request, root)).items[0].error).toContain('多个不同 URL')
    await configure('stderr')
    expect((await service.upload(1, request, root)).items[0].error).toContain('没有返回可用')
    await configure()
    const task = await service.upload(1, request, root)
    await expect(service.apply(1, { ...request, markdown: '# references removed', taskId: task.id, selectedItemIds: [task.items[0].id], allowChangedOriginals: [] })).rejects.toThrow('图片引用已改变')
  })
})
