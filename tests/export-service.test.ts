import { createDocumentResourceContext } from '../src/main/document-resources'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { embedLocalImages } from '../src/main/export-service'
import { saveImageAsset } from '../src/main/image-service'
import { renderDocumentHtml } from '../src/renderer/export-document'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('document export', () => {
  it('renders GFM Markdown into a standalone, script-restricted HTML document', async () => {
    const html = await renderDocumentHtml(
      '# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |',
      'A <Document>',
    )

    expect(html).toContain('<h1 id="title">Title</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<title>A &lt;Document&gt;</title>')
    expect(html).toContain("default-src 'none'")
  })

  it('embeds local document images as portable data URLs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-export-'))
    temporaryDirectories.push(root)
    const documentPath = path.join(root, 'note.md')
    await writeFile(documentPath, '# Note')
    const image = await saveImageAsset(createDocumentResourceContext(documentPath, ''), {
      fileName: 'pixel.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71]),
    })

    const html = await embedLocalImages(
      `<img src="${image.markdownUrl}" alt="pixel">`,
      createDocumentResourceContext(documentPath, ''),
    )
    expect(html).toContain('src="data:image/png;base64,iVBORw=="')
  })

  it('keeps resource metadata effective when exported metadata is hidden and the disk document differs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-export-root-'))
    temporaryDirectories.push(root)
    const documentPath = path.join(root, 'note.md'), assets = path.join(root, 'images')
    await mkdir(assets)
    await writeFile(documentPath, '# Different on-disk document')
    const bytes = Buffer.from('snapshot-root-image')
    await writeFile(path.join(assets, 'cover.png'), bytes)
    const markdown = '---\ntypora-root-url: images\ntitle: Hidden metadata title\n---\n\n# Visible\n\n![Cover](/cover.png)'
    const resources = createDocumentResourceContext(documentPath, markdown)
    const rendered = await renderDocumentHtml(markdown, 'Export title', { metadata: false })
    expect(rendered).not.toContain('typora-root-url')
    expect(rendered).not.toContain('Hidden metadata title')
    expect(rendered).toContain('<h1 id="visible">Visible</h1>')
    const html = await embedLocalImages(rendered, resources)
    expect(html).toContain(`src="data:image/png;base64,${bytes.toString('base64')}"`)
    expect(await readFile(documentPath, 'utf8')).toBe('# Different on-disk document')
    expect(await readFile(path.join(assets, 'cover.png'))).toEqual(bytes)
  })
})
