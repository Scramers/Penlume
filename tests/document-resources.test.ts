import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, realpath, stat } from 'node:fs/promises'
import {
  createDocumentResourceContext,
  resolveDocumentResourceCandidate,
  type DocumentResourceContext,
  type DocumentResourceResolution,
  type LocalResourceKind,
  type ResourcePathFlavor,
} from '../src/main/document-resources'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const forbidden = () => { throw new Error('Resource location must not access the filesystem') }
  return { ...actual, readFile: vi.fn(forbidden), realpath: vi.fn(forbidden), stat: vi.fn(forbidden) }
})

afterEach(() => vi.clearAllMocks())

function metadata(root: unknown, closing = '---'): string {
  return `---\ntypora-root-url: ${JSON.stringify(root)}\n${closing}\n\n# Document\n`
}

function local(context: DocumentResourceContext, reference: string) {
  const result = resolveDocumentResourceCandidate(context, reference)
  expect(result.kind, reference).toBe('local')
  if (result.kind !== 'local') throw new Error(`Expected a local candidate for ${JSON.stringify(reference)}`)
  expect(result.originalReference).toBe(reference)
  expect(result.root).toBe(context.root)
  return result
}

function expectLocal(
  context: DocumentResourceContext,
  reference: string,
  candidatePath: string,
  basis: 'absolute' | 'document-directory' | 'typora-root-url',
  pathFlavor: ResourcePathFlavor,
  sourceKind?: LocalResourceKind,
) {
  const result = local(context, reference)
  expect(result).toMatchObject({ candidatePath, basis, pathFlavor, ...(sourceKind ? { sourceKind } : {}) })
  return result
}

function expectIssue(result: DocumentResourceResolution, kind: 'invalid' | 'unsupported', reason: string) {
  expect(result).toMatchObject({ kind, reason })
}

describe('document resource base from leading YAML', () => {
  it('locates the official root-prefix example without treating the prefix as an OS absolute path', () => {
    const root = '/User/typora/typora.io/'
    const context = createDocumentResourceContext('/User/typora/notes/post.md', metadata(root), 'posix')
    expect(context.root).toMatchObject({ status: 'local', original: root, candidatePath: '/User/typora/typora.io/', pathFlavor: 'posix' })
    const result = expectLocal(context, '/blog/img/test.png', '/User/typora/typora.io/blog/img/test.png', 'typora-root-url', 'posix', 'slash-path')
    expect(result.decodedPath).toBe('/blog/img/test.png')
    expectLocal(context, '/+/blog/img/test.png', '/User/typora/typora.io/+/blog/img/test.png', 'typora-root-url', 'posix', 'slash-path')
  })

  it('resolves a ../../ root relative to the document and uses it for ordinary relative references', () => {
    const context = createDocumentResourceContext('/work/notes/sub/post.md', metadata('../../'), 'posix')
    expect(context.root).toMatchObject({ status: 'local', original: '../../', candidatePath: '/work' })
    expectLocal(context, 'images/test.png', '/work/images/test.png', 'typora-root-url', 'posix', 'relative-path')
    expectLocal(context, '/images/test.png', '/work/images/test.png', 'typora-root-url', 'posix', 'slash-path')
  })

  it('uses a relative root as a base rather than concatenating it into the source reference', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../shared images'), 'posix')
    expectLocal(context, './nested/../cover%20image.png', '/work/shared images/cover image.png', 'typora-root-url', 'posix')
    expect(context.root.original).toBe('../shared images')
  })

  it('removes only a single root-prefix slash and can locate the root directory itself', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('/base/'), 'posix')
    expectLocal(context, '/', '/base', 'typora-root-url', 'posix', 'slash-path')
    expectLocal(context, '//server/share/cover.png', '\\\\server\\share\\cover.png', 'absolute', 'win32', 'unc-path')
  })

  it.each(['---', '...'])('reads a CRLF leading mapping closed with %s', (closing) => {
    const markdown = metadata('../images', closing).replaceAll('\n', '\r\n')
    const context = createDocumentResourceContext('/work/notes/post.md', markdown, 'posix')
    expectLocal(context, 'cover.png', '/work/images/cover.png', 'typora-root-url', 'posix')
  })

  it('retains a YAML string alias without granting any access to its resulting base', () => {
    const markdown = '---\nassets: &assets ../images\ntypora-root-url: *assets\n---\n\n# Document\n'
    const context = createDocumentResourceContext('/work/notes/post.md', markdown, 'posix')
    expectLocal(context, 'cover.png', '/work/images/cover.png', 'typora-root-url', 'posix')
    expect(context.root.original).toBe('../images')
  })

  it.each([
    { name: 'no front matter', markdown: '# Document\n', status: 'absent' },
    { name: 'unrelated leading metadata', markdown: '---\ntitle: Document\n---\n', status: 'absent' },
    { name: 'wrong field case', markdown: '---\nTypora-root-url: /wrong\n---\n', status: 'absent' },
    { name: 'metadata after prose', markdown: '# Document\n\n' + metadata('/wrong'), status: 'absent' },
    { name: 'metadata inside a code block', markdown: '```yaml\n' + metadata('/wrong') + '```\n', status: 'absent' },
    { name: 'broken YAML', markdown: '---\ntypora-root-url: [\n---\n', status: 'invalid' },
    { name: 'duplicate root fields', markdown: '---\ntypora-root-url: /one\ntypora-root-url: /two\n---\n', status: 'invalid' },
    { name: 'unclosed leading YAML', markdown: '---\ntypora-root-url: /wrong\n# Document\n', status: 'invalid' },
    { name: 'non-mapping YAML', markdown: '---\n- /wrong\n---\n', status: 'invalid' },
    { name: 'empty root', markdown: metadata(''), status: 'invalid' },
    { name: 'whitespace-only root', markdown: metadata('   '), status: 'invalid' },
    { name: 'invalid encoded root', markdown: metadata('%ZZ'), status: 'invalid' },
  ])('keeps the document base for $name', ({ markdown, status }) => {
    const context = createDocumentResourceContext('/work/notes/post.md', markdown, 'posix')
    expect(context.root.status).toBe(status)
    expectLocal(context, 'cover.png', '/work/notes/cover.png', 'document-directory', 'posix', 'relative-path')
  })

  it.each([
    { root: null }, { root: 3 }, { root: true }, { root: ['../images'] }, { root: { folder: '../images' } },
  ])('does not coerce non-string root $root', ({ root }) => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata(root), 'posix')
    expect(context.root).toMatchObject({ status: 'invalid', original: null, reason: 'non-string-root' })
    expectLocal(context, 'cover.png', '/work/notes/cover.png', 'document-directory', 'posix')
  })

  it('does not decode HTML entities in an already parsed YAML scalar', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../images&amp;archive'), 'posix')
    expectLocal(context, 'cover.png', '/work/images&amp;archive/cover.png', 'typora-root-url', 'posix')
  })

  it.each(['__proto__', 'constructor', 'prototype'])('does not inherit a resource root from the YAML key %s', (key) => {
    const markdown = `---\n${key}:\n  typora-root-url: /wrong\n---\n`
    const context = createDocumentResourceContext('/work/notes/post.md', markdown, 'posix')
    expect(context.root).toEqual({ status: 'absent', original: null })
    expectLocal(context, 'cover.png', '/work/notes/cover.png', 'document-directory', 'posix')
    expect(Object.hasOwn(Object.prototype, 'typora-root-url')).toBe(false)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect('typora-root-url' in {}).toBe(false)
  })

  it('reads an own root alongside special YAML keys without polluting prototypes', () => {
    const markdown = '---\n__proto__: { typora-root-url: /wrong }\nconstructor: { prototype: { typora-root-url: /also-wrong } }\nprototype: { typora-root-url: /still-wrong }\ntypora-root-url: ../images\n---\n'
    const context = createDocumentResourceContext('/work/notes/post.md', markdown, 'posix')
    expectLocal(context, 'cover.png', '/work/images/cover.png', 'typora-root-url', 'posix')
    expect(Object.hasOwn(Object.prototype, 'typora-root-url')).toBe(false)
    expect('typora-root-url' in {}).toBe(false)
  })
})

describe('unsupported root policies stay separate from independent references', () => {
  it.each([
    { root: 'https://example.invalid/images/', reason: 'unsupported-remote-root' },
    { root: 'http://example.invalid/images/', reason: 'unsupported-remote-root' },
    { root: 'data:image/png;base64,AAAA', reason: 'unsupported-remote-root' },
    { root: 'blob:https://example.invalid/id', reason: 'unsupported-remote-root' },
    { root: '../${filename}.assets', reason: 'unsupported-template' },
    { root: '../%24%7Bfilename%7D.assets', reason: 'unsupported-template' },
    { root: 'unknown:images', reason: 'unsupported-scheme' },
    { root: '/images?download=1', reason: 'unsupported-root-suffix' },
    { root: '/images#fragment', reason: 'unsupported-root-suffix' },
    { root: 'C:images', reason: 'drive-relative-path' },
  ])('reports $root as unsupported rather than silently choosing a different base', ({ root, reason }) => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata(root), 'posix')
    expect(context.root).toMatchObject({ status: 'unsupported', original: root, reason })
    for (const reference of ['cover.png', '/cover.png']) {
      const result = resolveDocumentResourceCandidate(context, reference)
      expectIssue(result, 'unsupported', reason)
      expect(result.originalReference).toBe(reference)
    }
  })

  it.each([
    { reference: 'C:/images/cover.png', path: 'C:\\images\\cover.png', kind: 'drive-path' },
    { reference: '\\\\server\\share\\cover.png', path: '\\\\server\\share\\cover.png', kind: 'unc-path' },
    { reference: 'file:///C:/images/cover.png', path: 'C:\\images\\cover.png', kind: 'file-url' },
    { reference: 'file://server/share/cover.png', path: '\\\\server\\share\\cover.png', kind: 'file-url' },
  ] as const)('does not apply an unsupported root to explicit $reference', ({ reference, path, kind }) => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('https://example.invalid/images/'), 'posix')
    expectLocal(context, reference, path, 'absolute', 'win32', kind)
  })

  it.each([
    'HTTP://Example.invalid/a%20b.png?raw=1#fragment',
    'https://example.invalid/中文.png?x=%25#图',
    'data:image/png;base64,AAAA',
    'blob:https://example.invalid/original-id',
  ])('preserves external reference %s byte-for-byte', (reference) => {
    const context = createDocumentResourceContext(null, metadata('../${filename}.assets'), 'posix')
    const result = resolveDocumentResourceCandidate(context, reference)
    expect(result).toMatchObject({ kind: 'external', url: reference, originalReference: reference, pathPart: reference, suffix: '' })
    expect(result.root).toBe(context.root)
  })
})

describe('explicit paths and file URLs', () => {
  it.each([
    { document: '/work/notes/post.md', directory: '/work/notes', flavor: 'posix' },
    { document: 'D:\\notes\\post.md', directory: 'D:\\notes', flavor: 'win32' },
    { document: '\\\\server\\share\\notes\\post.md', directory: '\\\\server\\share\\notes', flavor: 'win32' },
  ])('infers the native flavor of explicit document path $document', ({ document, directory, flavor }) => {
    const context = createDocumentResourceContext(document, '')
    expect(context).toMatchObject({ documentPath: document, documentDirectory: directory, pathFlavor: flavor })
  })

  it.each([
    { reference: 'C:/images/../cover.png', path: 'C:\\cover.png', flavor: 'win32', kind: 'drive-path' },
    { reference: 'C:\\images\\cover.png', path: 'C:\\images\\cover.png', flavor: 'win32', kind: 'drive-path' },
    { reference: '//server/share/images/../cover.png', path: '\\\\server\\share\\cover.png', flavor: 'win32', kind: 'unc-path' },
    { reference: '\\\\server\\share\\cover.png', path: '\\\\server\\share\\cover.png', flavor: 'win32', kind: 'unc-path' },
    { reference: 'file:///C:/images/cover%20%E4%B8%AD.png', path: 'C:\\images\\cover 中.png', flavor: 'win32', kind: 'file-url' },
    { reference: 'file://server/share/cover%20image.png', path: '\\\\server\\share\\cover image.png', flavor: 'win32', kind: 'file-url' },
    { reference: 'file:///var/images/cover%20image.png', path: '/var/images/cover image.png', flavor: 'posix', kind: 'file-url' },
  ] as const)('keeps $reference independent of a valid local root', ({ reference, path, flavor, kind }) => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../root'), 'posix')
    expectLocal(context, reference, path, 'absolute', flavor, kind)
  })

  it('uses the document volume for a native Windows single slash when no root is supplied', () => {
    const context = createDocumentResourceContext('D:\\notes\\sub\\post.md', '', 'win32')
    expectLocal(context, '/images/cover.png', 'D:\\images\\cover.png', 'absolute', 'win32', 'slash-path')
    expectLocal(context, '\\images\\cover.png', 'D:\\images\\cover.png', 'absolute', 'win32', 'slash-path')
  })

  it('applies a root to a single forward slash while keeping a native backslash path independent', () => {
    const context = createDocumentResourceContext('D:\\notes\\post.md', metadata('E:/shared'), 'win32')
    expectLocal(context, '/images/cover.png', 'E:\\shared\\images\\cover.png', 'typora-root-url', 'win32', 'slash-path')
    expectLocal(context, '\\images\\cover.png', 'D:\\images\\cover.png', 'absolute', 'win32', 'slash-path')
  })

  it('uses a Windows root for a POSIX document, including final validation in that root flavor', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('E:/shared images'), 'posix')
    expectLocal(context, 'folder/cover%20image.png', 'E:\\shared images\\folder\\cover image.png', 'typora-root-url', 'win32', 'relative-path')
    expectLocal(context, '/folder/cover.png', 'E:\\shared images\\folder\\cover.png', 'typora-root-url', 'win32', 'slash-path')
    expectIssue(resolveDocumentResourceCandidate(context, 'folder/cover%3Astream.png'), 'invalid', 'invalid-path')
  })

  it('uses an explicit Windows file URL root independently of a POSIX document', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('file:///E:/shared%20images'), 'posix')
    expectLocal(context, 'cover.png', 'E:\\shared images\\cover.png', 'typora-root-url', 'win32')
  })

  it('keeps native file URL interpretation for a Windows context lacking an explicit URL volume', () => {
    const context = createDocumentResourceContext('D:\\notes\\post.md', metadata('E:/shared'), 'win32')
    expectIssue(resolveDocumentResourceCandidate(context, 'file:///var/images/cover.png'), 'invalid', 'invalid-file-url')
    expectLocal(context, 'file:///C:/images/cover.png', 'C:\\images\\cover.png', 'absolute', 'win32', 'file-url')
  })

  it.each(['C:cover.png', 'c:folder/cover.png'])('does not guess the per-drive current directory for %s', (reference) => {
    const context = createDocumentResourceContext('D:\\notes\\post.md', metadata('E:/shared'), 'win32')
    expectIssue(resolveDocumentResourceCandidate(context, reference), 'unsupported', 'drive-relative-path')
  })

  it.each(['\\\\.\\pipe\\cover.png', '\\\\?\\C:\\images\\cover.png', '//?/C:/images/cover.png'])('does not turn device namespace %s into a local candidate', (reference) => {
    const context = createDocumentResourceContext('D:\\notes\\post.md', metadata('E:/shared'), 'win32')
    const result = resolveDocumentResourceCandidate(context, reference)
    expect(result.kind).toBe('unsupported')
    expect(result.originalReference).toBe(reference)
  })

  it.each(['C:/images/cover.png:stream', './cover.png%3Astream', 'folder/cover.png%3Astream', 'file:///C:/images/cover.png%3Astream'])('does not guess alternate data stream %s', (reference) => {
    const context = createDocumentResourceContext('D:\\notes\\post.md', '', 'win32')
    expectIssue(resolveDocumentResourceCandidate(context, reference), 'invalid', 'invalid-path')
  })

  it.each(['//server', '\\\\server\\'])('rejects incomplete UNC path %s', (reference) => {
    const context = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    expectIssue(resolveDocumentResourceCandidate(context, reference), 'unsupported', 'incomplete-unc-path')
  })

  it.each([
    'file:///C:/images/cover%2Fname.png',
    'file:///C:/images/cover%5Cname.png',
    'file://user:pass@server/share/cover.png',
    'file:///C:/images/%ZZ.png',
  ])('rejects invalid file URL %s', (reference) => {
    const context = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    expectIssue(resolveDocumentResourceCandidate(context, reference), 'invalid', 'invalid-file-url')
  })

  it('allows an encoded backslash as a POSIX file URL filename while still rejecting an encoded slash', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    expectLocal(context, 'file:///var/images/literal%5Cname.png', '/var/images/literal\\name.png', 'absolute', 'posix', 'file-url')
    expectIssue(resolveDocumentResourceCandidate(context, 'file:///var/images/literal%2Fname.png'), 'invalid', 'invalid-file-url')
  })

  it.each([
    { reference: '%43%3A%2Fimages%2Fcover.png', path: 'C:\\images\\cover.png', kind: 'drive-path' },
    { reference: '%5C%5Cserver%5Cshare%5Ccover.png', path: '\\\\server\\share\\cover.png', kind: 'unc-path' },
    { reference: '/%2Fserver/share/cover.png', path: '\\\\server\\share\\cover.png', kind: 'unc-path' },
  ] as const)('does not prefix a decoded explicit path $reference with the YAML root', ({ reference, path, kind }) => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../images'), 'posix')
    expectLocal(context, reference, path, 'absolute', 'win32', kind)
  })

  it('detects an encoded drive in a file URL without decoding its filename twice', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../images'), 'posix')
    const reference = 'file:///%43%3A/images/cover%2523original.png?raw=1#view'
    const result = expectLocal(context, reference, 'C:\\images\\cover%23original.png', 'absolute', 'win32', 'file-url')
    expect(result.pathPart).toBe('file:///%43%3A/images/cover%2523original.png')
    expect(result.suffix).toBe('?raw=1#view')
  })
})

describe('single URI decoding and exact reference preservation', () => {
  it.each([
    { reference: '%E4%B8%AD%E6%96%87%20%E5%9B%BE.png?raw=%E4%B8%AD#片段', path: '/work/notes/中文 图.png', part: '%E4%B8%AD%E6%96%87%20%E5%9B%BE.png', suffix: '?raw=%E4%B8%AD#片段' },
    { reference: 'cover%23original.png?raw=1#view', path: '/work/notes/cover#original.png', part: 'cover%23original.png', suffix: '?raw=1#view' },
    { reference: 'cover%2523original.png?', path: '/work/notes/cover%23original.png', part: 'cover%2523original.png', suffix: '?' },
    { reference: 'cover%3Fquery.png#', path: '/work/notes/cover?query.png', part: 'cover%3Fquery.png', suffix: '#' },
    { reference: 'cover.png?#', path: '/work/notes/cover.png', part: 'cover.png', suffix: '?#' },
    { reference: 'cover.png#fragment?still-fragment', path: '/work/notes/cover.png', part: 'cover.png', suffix: '#fragment?still-fragment' },
    { reference: '100%25.png', path: '/work/notes/100%.png', part: '100%25.png', suffix: '' },
  ])('keeps the original pathname and suffix for $reference', ({ reference, path, part, suffix }) => {
    const context = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    const result = expectLocal(context, reference, path, 'document-directory', 'posix')
    expect(result.pathPart).toBe(part)
    expect(result.suffix).toBe(suffix)
  })

  it.each(['?', '#', '?#', '?raw=%E4%B8%AD#片段'])('retains exact file URL suffix %j', (suffix) => {
    const context = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    const reference = 'file:///C:/images/cover%2523original.png' + suffix
    const result = expectLocal(context, reference, 'C:\\images\\cover%23original.png', 'absolute', 'win32', 'file-url')
    expect(result.pathPart).toBe('file:///C:/images/cover%2523original.png')
    expect(result.suffix).toBe(suffix)
  })

  it('does not repeat entity decoding or Markdown backslash unescaping on parsed references', () => {
    const posix = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    expectLocal(posix, 'cover&amp;.png', '/work/notes/cover&amp;.png', 'document-directory', 'posix')
    expectLocal(posix, 'photo(1).png', '/work/notes/photo(1).png', 'document-directory', 'posix')
    const result = expectLocal(posix, 'literal%5C%28name%29.png', '/work/notes/literal\\(name).png', 'document-directory', 'posix')
    expect(result.decodedPath).toBe('literal\\(name).png')
    const windows = createDocumentResourceContext('D:\\notes\\post.md', '', 'win32')
    expectLocal(windows, 'folder\\(name).png', 'D:\\notes\\folder\\(name).png', 'document-directory', 'win32')
  })

  it.each(['%ZZ.png', '%E4%B8.png', '%'])('reports malformed URI encoding in %s', (reference) => {
    const context = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    expectIssue(resolveDocumentResourceCandidate(context, reference), 'invalid', 'invalid-encoding')
  })

  it.each(['', '?raw=1', '#fragment', 'cover%00.png', 'cover\u0000.png', 'cover%0A.png'])('refuses empty or control-containing local reference %j', (reference) => {
    const context = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    expect(resolveDocumentResourceCandidate(context, reference).kind).toBe('invalid')
  })

  it('rejects a NUL decoded from a file URL even though the URL parser accepts it', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', '', 'posix')
    expectIssue(resolveDocumentResourceCandidate(context, 'file:///C:/images/cover%00.png'), 'invalid', 'invalid-path')
  })

  it('decodes a root pathname once while retaining its original spelling', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../images%2523archive'), 'posix')
    expect(context.root).toMatchObject({ status: 'local', original: '../images%2523archive', candidatePath: '/work/images%23archive' })
    expectLocal(context, 'cover.png', '/work/images%23archive/cover.png', 'typora-root-url', 'posix')
  })

  it('does not treat an encoded root hash as a URL suffix', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../images%23archive'), 'posix')
    expectLocal(context, 'cover.png', '/work/images#archive/cover.png', 'typora-root-url', 'posix')
  })

  it('does not reinterpret a double-encoded drive as an absolute path', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../images'), 'posix')
    const result = expectLocal(context, '%2543%253A%252Fcover.png', '/work/images/%43%3A%2Fcover.png', 'typora-root-url', 'posix', 'relative-path')
    expect(result.decodedPath).toBe('%43%3A%2Fcover.png')
  })

  it.each(['cover%3Astream.png', 'cover.png%3Astream', 'unknown:cover.png', 'https%3A%2F%2Fexample.invalid%2Fcover.png'])('does not guess a local path for URI scheme syntax %s', (reference) => {
    const context = createDocumentResourceContext('D:\\notes\\post.md', metadata('E:/images'), 'win32')
    expectIssue(resolveDocumentResourceCandidate(context, reference), 'unsupported', 'unsupported-scheme')
  })
})

describe('lexical candidates never grant access or consult the working directory', () => {
  it.each([null, 'notes/post.md', './post.md'])('does not use cwd when the document path is %j', (documentPath) => {
    const context = createDocumentResourceContext(documentPath, '', 'posix')
    expect(context).toMatchObject({ documentPath: null, documentDirectory: null })
    expectIssue(resolveDocumentResourceCandidate(context, 'cover.png'), 'unsupported', 'missing-document-path')
    expectLocal(context, '/absolute/cover.png', '/absolute/cover.png', 'absolute', 'posix')
  })

  it('does not infer a Windows drive from the working directory for an unsaved single-slash reference', () => {
    const context = createDocumentResourceContext(null, '', 'win32')
    expectIssue(resolveDocumentResourceCandidate(context, '/images/cover.png'), 'unsupported', 'missing-windows-volume')
  })

  it.each([
    { documentPath: null, root: '/absolute/images', flavor: 'posix', path: '/absolute/images/cover.png' },
    { documentPath: 'notes/post.md', root: '/absolute/images', flavor: 'posix', path: '/absolute/images/cover.png' },
    { documentPath: null, root: 'E:/absolute/images', flavor: 'win32', path: 'E:\\absolute\\images\\cover.png' },
    { documentPath: 'notes/post.md', root: 'E:/absolute/images', flavor: 'win32', path: 'E:\\absolute\\images\\cover.png' },
  ] as const)('allows explicit root $root without inventing an absolute document path', ({ documentPath, root, flavor, path }) => {
    const context = createDocumentResourceContext(documentPath, metadata(root), flavor)
    expect(context.documentPath).toBeNull()
    expectLocal(context, 'cover.png', path, 'typora-root-url', flavor)
    expectLocal(context, '/cover.png', path, 'typora-root-url', flavor)
  })

  it('returns an unsupported relative root when neither document nor absolute root supplies a base', () => {
    const context = createDocumentResourceContext(null, metadata('../images'), 'posix')
    expect(context.root).toMatchObject({ status: 'unsupported', reason: 'missing-document-path' })
    expectIssue(resolveDocumentResourceCandidate(context, 'cover.png'), 'unsupported', 'missing-document-path')
  })

  it.each([
    { root: '//server/share/images', path: '\\\\server\\share\\images\\cover.png' },
    { root: 'file:///C:/images', path: 'C:\\images\\cover.png' },
  ])('allows an explicit Windows root $root for an unsaved POSIX-context document', ({ root, path }) => {
    const context = createDocumentResourceContext(null, metadata(root), 'posix')
    expect(context.documentPath).toBeNull()
    expectLocal(context, 'cover.png', path, 'typora-root-url', 'win32')
    expectLocal(context, '/cover.png', path, 'typora-root-url', 'win32')
  })

  it('returns candidates outside a metadata base without claiming that they are authorized', () => {
    const context = createDocumentResourceContext('/work/notes/post.md', metadata('../images'), 'posix')
    const result = expectLocal(context, '../../private/cover.png', '/private/cover.png', 'typora-root-url', 'posix')
    expect(result).not.toHaveProperty('authorized')
    expect(result).not.toHaveProperty('authorizedRoot')
  })

  it('does not read, stat or realpath existing, missing or outside candidates while resolving a snapshot', () => {
    const context = createDocumentResourceContext('/does-not-need-to-exist/notes/post.md', metadata('../images'), 'posix')
    expectLocal(context, 'missing/cover.png', '/does-not-need-to-exist/images/missing/cover.png', 'typora-root-url', 'posix')
    expectLocal(context, '../../outside/cover.png', '/outside/cover.png', 'typora-root-url', 'posix')
    expectLocal(context, 'file:///C:/does-not-need-to-exist/cover.png', 'C:\\does-not-need-to-exist\\cover.png', 'absolute', 'win32')
    expect(readFile).not.toHaveBeenCalled()
    expect(realpath).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })
})
