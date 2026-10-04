import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, realpath, stat, copyFile, rename, unlink, mkdir } from 'node:fs/promises'
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import {
  createDocumentResourceContext,
  resolveDocumentResourceCandidate,
  type DocumentResourceContext,
} from '../src/main/document-resources'
import { createDocumentResourceReference } from '../src/main/document-resource-references'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const forbidden = () => { throw new Error('Reference formatting must not access or authorize files') }
  return { ...actual, readFile: vi.fn(forbidden), realpath: vi.fn(forbidden), stat: vi.fn(forbidden), copyFile: vi.fn(forbidden), rename: vi.fn(forbidden), unlink: vi.fn(forbidden), mkdir: vi.fn(forbidden) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const forbidden = () => { throw new Error('Reference formatting must not access or authorize files') }
  return { ...actual, readFileSync: vi.fn(forbidden), realpathSync: vi.fn(forbidden), statSync: vi.fn(forbidden), writeFileSync: vi.fn(forbidden) }
})

afterEach(() => vi.clearAllMocks())

function metadata(root: unknown): string {
  return `---\ntypora-root-url: ${JSON.stringify(root)}\n---\n\n# Document\n`
}

function posix(markdown = '') {
  return createDocumentResourceContext('/work/notes/post.md', markdown, 'posix')
}

function windows(markdown = '') {
  return createDocumentResourceContext('C:\\work\\notes\\post.md', markdown, 'win32')
}

function reference(context: DocumentResourceContext, target: string, original?: string, expectedCandidate = target) {
  const result = createDocumentResourceReference(context, target, original)
  expect(result.kind, JSON.stringify({ target, original, result })).toBe('reference')
  if (result.kind !== 'reference') throw new Error('Expected a verified reference')
  const roundtrip = resolveDocumentResourceCandidate(context, result.reference)
  expect(roundtrip).toEqual(result.resolution)
  expect(roundtrip.kind).toBe('local')
  if (roundtrip.kind !== 'local') throw new Error('Expected a local roundtrip')
  expect(roundtrip.candidatePath).toBe(expectedCandidate)
  expect(roundtrip.root).toBe(context.root)
  expect(roundtrip.originalReference).toBe(result.reference)
  expect(result.originalReference).toBe(original ?? null)
  return result
}

describe('new document resource references', () => {
  it('prefers the current valid local root rather than the document directory', () => {
    const context = posix(metadata('/website/'))
    const result = reference(context, '/website/blog/img/test.png')
    expect(result).toMatchObject({ reference: 'blog/img/test.png', suffix: '', requestedStyle: null, usedFallback: false })
    expect(result.resolution.basis).toBe('typora-root-url')
  })

  it('uses the YAML ../../ base for a new ordinary relative reference', () => {
    const context = createDocumentResourceContext('/work/notes/sub/post.md', metadata('../../'), 'posix')
    expect(reference(context, '/work/images/cover.png').reference).toBe('images/cover.png')
  })

  it('uses a Windows metadata base without relying on the host platform', () => {
    const result = reference(windows(metadata('D:/assets')), 'D:\\assets\\中文 image.png')
    expect(result.reference).toBe('%E4%B8%AD%E6%96%87%20image.png')
    expect(result.resolution.pathFlavor).toBe('win32')
  })

  it.each([
    { name: 'absent', markdown: '# Document\n' },
    { name: 'malformed YAML', markdown: '---\ntypora-root-url: [\n---\n' },
    { name: 'duplicate keys', markdown: '---\ntypora-root-url: /one\ntypora-root-url: /two\n---\n' },
    { name: 'unclosed mapping', markdown: '---\ntypora-root-url: /one\n' },
    { name: 'non-string number', markdown: metadata(7) },
    { name: 'non-string array', markdown: metadata(['/one']) },
    { name: 'non-string object', markdown: metadata({ directory: '/one' }) },
    { name: 'invalid URI encoding', markdown: metadata('%ZZ') },
    { name: 'empty string', markdown: metadata('') },
  ])('keeps the document-directory fallback for $name root', ({ markdown }) => {
    const result = reference(posix(markdown), '/work/notes/images/cover.png')
    expect(result.reference).toBe('images/cover.png')
    expect(result.usedFallback).toBe(false)
    expect(result.resolution.basis).toBe('document-directory')
  })

  it.each(['https://example.com/assets/', '${filename}.assets', '%24%7Bfilename%7D.assets', '/root?mode=1', 'ftp://example.com/root', 'C:assets'])('uses an explicit file URL for unsupported root %s', (root) => {
    const context = posix(metadata(root))
    expect(context.root.status).toBe('unsupported')
    const result = reference(context, '/work/notes/cover.png')
    expect(result).toMatchObject({ reference: 'file:///work/notes/cover.png', usedFallback: true })
    expect(result.resolution.basis).toBe('absolute')
    expect(resolveDocumentResourceCandidate(context, 'cover.png').kind).toBe('unsupported')
  })

  it('uses a file URL without an untitled document directory', () => {
    const context = createDocumentResourceContext(null, '', 'posix')
    expect(reference(context, '/somewhere/cover.png').reference).toBe('file:///somewhere/cover.png')
  })

  it('can use an explicit local metadata root for untitled lexical location only', () => {
    const context = createDocumentResourceContext(null, metadata('/assets'), 'posix')
    const result = reference(context, '/assets/cover.png')
    expect(result.reference).toBe('cover.png')
    expect(context.documentPath).toBeNull()
    expect('authorized' in result).toBe(false)
  })

  it('uses an explicit Windows root even when the document path is POSIX', () => {
    const result = reference(posix(metadata('D:/assets')), 'D:\\assets\\cover.png')
    expect(result.reference).toBe('cover.png')
    expect(result.resolution.pathFlavor).toBe('win32')
  })

  it('allows ../ outside the chosen base without inferring containment or access', () => {
    const result = reference(posix(metadata('/assets')), '/outside/missing.png')
    expect(result.reference).toBe('../outside/missing.png')
    expect(Object.keys(result).sort()).toEqual(['kind', 'normalizedTargetPath', 'originalReference', 'reference', 'requestedStyle', 'resolution', 'suffix', 'usedFallback'].sort())
  })

  it('can refer to the base directory itself', () => {
    expect(reference(posix(metadata('/assets/')), '/assets', undefined, '/assets').reference).toBe('.')
    expect(reference(windows(), 'C:\\work\\notes', undefined, 'C:\\work\\notes').reference).toBe('.')
  })
})

describe('original local reference style and exact suffix', () => {
  it.each([
    { original: './old.png', expected: './new.png' },
    { original: 'old.png', expected: 'new.png' },
    { original: '../notes/old.png', expected: 'new.png' },
    { original: 'old.png?size=2#part', expected: 'new.png?size=2#part' },
    { original: './old.png?中文=%ZZ&x=%2520#片段', expected: './new.png?中文=%ZZ&x=%2520#片段' },
    { original: 'old.png?', expected: 'new.png?' },
    { original: 'old.png#', expected: 'new.png#' },
    { original: 'old.png?#', expected: 'new.png?#' },
    { original: 'old.png#fragment?query', expected: 'new.png#fragment?query' },
  ])('preserves relative style and suffix from $original', ({ original, expected }) => {
    const result = reference(posix(), '/work/notes/new.png', original)
    expect(result.reference).toBe(expected)
    expect(result.requestedStyle).toBe('relative-path')
    expect(result.usedFallback).toBe(false)
    expect(result.suffix).toBe(original.replace(/^[^?#]*/, ''))
  })

  it.each([
    { original: 'file:///work/notes/old.png?x=1#', expected: 'file:///work/notes/new.png?x=1#' },
    { original: '/old.png?x#y', expected: '/work/notes/new.png?x#y' },
  ])('preserves an absolute POSIX style from $original', ({ original, expected }) => {
    expect(reference(posix(), '/work/notes/new.png', original).reference).toBe(expected)
  })

  it.each(['C:/old.png?x#y', 'C:\\old.png?x#y', '%43%3A%5Cold.png?x#y'])('preserves a drive style from %s', (original) => {
    const result = reference(windows(metadata('D:/assets')), 'C:\\new image.png', original)
    expect(result).toMatchObject({ reference: 'C:/new%20image.png?x#y', requestedStyle: 'drive-path', usedFallback: false })
  })

  it.each(['\\\\server\\share\\old.png?#', '//server/share/old.png?#', '%5C%5Cserver%5Cshare%5Cold.png?#'])('preserves UNC style from %s', (original) => {
    const result = reference(posix(metadata('/assets')), '\\\\server\\share\\new image.png', original)
    expect(result).toMatchObject({ reference: '//server/share/new%20image.png?#', requestedStyle: 'unc-path', usedFallback: false })
  })

  it('can retarget a UNC style to a different share while remaining UNC', () => {
    expect(reference(windows(), '\\\\other\\second\\new.png', '//server/first/old.png').reference).toBe('//other/second/new.png')
  })

  it.each([
    { target: '/website/blog/new.png', expected: '/blog/new.png' },
    { target: '/outside/new.png', expected: '/../outside/new.png' },
    { target: '/website', expected: '/' },
    { target: '/website/cover:part.png', expected: '/./cover%3Apart.png' },
    { target: '/website/\\cover.png', expected: '/./%5Ccover.png' },
  ])('preserves root-slash style for $target', ({ target, expected }) => {
    expect(reference(posix(metadata('/website/')), target, '/old.png').reference).toBe(expected)
  })

  it('preserves a Windows single forward slash on the same native document volume', () => {
    expect(reference(windows(), 'C:\\images\\new.png', '/old.png').reference).toBe('/images/new.png')
  })

  it('preserves root slash on the same Windows metadata volume', () => {
    expect(reference(windows(metadata('D:/assets')), 'D:\\assets\\new.png', '/old.png').reference).toBe('/new.png')
  })

  it('keeps native Windows backslash-rooted references independent of metadata', () => {
    const result = reference(windows(metadata('D:/assets')), 'C:\\images\\new.png', '\\old.png?x=1')
    expect(result.reference).toBe('%5Cimages/new.png?x=1')
    expect(result.resolution.basis).toBe('absolute')
  })

  it('can keep native Windows root style while metadata is unsupported', () => {
    expect(reference(windows(metadata('https://example.com/assets')), 'C:\\new.png', '\\old.png').reference).toBe('%5Cnew.png')
  })

  it('keeps a UNC document-volume root without treating it as metadata', () => {
    const context = createDocumentResourceContext('\\\\server\\share\\notes\\post.md', '', 'win32')
    expect(reference(context, '\\\\server\\share\\images\\new.png', '\\old.png').reference).toBe('%5Cimages/new.png')
  })

  it('preserves the exact original if it already locates the same target', () => {
    const original = './%63over%20%25.png?中文=%ZZ#'
    const result = reference(posix(), '/work/notes/cover %.png', original)
    expect(result.reference).toBe(original)
    expect(result.usedFallback).toBe(false)
  })

  it('preserves an already-correct native drive spelling', () => {
    const original = 'c:\\work\\notes\\cover.png?'
    expect(reference(windows(), 'C:\\work\\notes\\cover.png', original, 'c:\\work\\notes\\cover.png').reference).toBe(original)
  })

  it('preserves query/hash when an unsupported metadata root forces file fallback', () => {
    const result = reference(posix(metadata('https://example.com/assets')), '/work/notes/new.png', './old.png?#')
    expect(result.reference).toBe('file:///work/notes/new.png?#')
    expect(result.usedFallback).toBe(true)
  })

  it('classifies unknown original schemes separately from an unsupported metadata scheme', () => {
    const context = posix(metadata('ftp://example.com/assets'))
    expect(createDocumentResourceReference(context, '/work/notes/new.png', 'ftp://elsewhere/old.png?x')).toMatchObject({ kind: 'unsupported', reason: 'unsupported-original-reference' })
    expect(reference(context, '/work/notes/new.png', 'old.png?x').reference).toBe('file:///work/notes/new.png?x')
  })
})

describe('platform, volume and lexical identity', () => {
  it.each([
    { original: './old.png', target: 'D:\\assets\\new.png' },
    { original: '/old.png', target: 'D:\\assets\\new.png' },
    { original: '\\old.png', target: 'D:\\assets\\new.png' },
    { original: '//server/share/old.png', target: 'D:\\assets\\new.png' },
  ])('falls back rather than reinterpreting a cross-volume $original', ({ original, target }) => {
    const result = reference(windows(), target, original)
    expect(result.reference).toBe('file:///D:/assets/new.png')
    expect(result.usedFallback).toBe(true)
  })

  it('falls back for a new reference on a different Windows drive', () => {
    expect(reference(windows(), 'D:\\assets\\new.png').reference).toBe('file:///D:/assets/new.png')
  })

  it('falls back for relative references across UNC shares', () => {
    const context = createDocumentResourceContext('\\\\server\\first\\notes\\post.md', '', 'win32')
    expect(reference(context, '\\\\server\\second\\new.png', './old.png').reference).toBe('file://server/second/new.png')
  })

  it('retains a file URL style across drives and UNC targets', () => {
    expect(reference(windows(), '\\\\server\\share\\new.png', 'file:///C:/old.png?#').reference).toBe('file://server/share/new.png?#')
  })

  it('can locate a Windows file URL in a POSIX context without converting its flavor', () => {
    const result = reference(posix(), 'C:\\assets\\new.png')
    expect(result.reference).toBe('file:///C:/assets/new.png')
    expect(result.resolution.pathFlavor).toBe('win32')
  })

  it('rejects a POSIX target that no reference can identify in a Windows context', () => {
    expect(createDocumentResourceReference(windows(), '/var/images/new.png')).toMatchObject({ kind: 'unsupported', reason: 'unrepresentable-target' })
  })

  it('does not mistake a POSIX /C:/ path for a Windows file URL', () => {
    expect(reference(posix(), '/C:/cover.png').reference).toBe('../../C%3A/cover.png')
    const untitled = createDocumentResourceContext(null, '', 'posix')
    expect(createDocumentResourceReference(untitled, '/C:/cover.png')).toMatchObject({ kind: 'unsupported', reason: 'unrepresentable-target' })
  })

  it('does not lose Windows folder case when relative() folds it', () => {
    const context = createDocumentResourceContext('C:\\Root\\post.md', '', 'win32')
    const result = reference(context, 'C:\\root\\cover.png')
    expect(result.reference).toBe('file:///C:/root/cover.png')
    expect(result.usedFallback).toBe(true)
  })

  it('canonicalizes only drive-letter case for relative identity', () => {
    const result = reference(windows(), 'c:\\work\\notes\\cover.png', undefined, 'C:\\work\\notes\\cover.png')
    expect(result.reference).toBe('cover.png')
    expect(result.usedFallback).toBe(false)
  })

  it('canonicalizes UNC host case but preserves share and folder case', () => {
    const context = createDocumentResourceContext('\\\\SERVER\\Share\\notes\\post.md', '', 'win32')
    expect(reference(context, '\\\\server\\Share\\notes\\cover.png', undefined, '\\\\SERVER\\Share\\notes\\cover.png').reference).toBe('cover.png')
    const result = reference(context, '\\\\server\\share\\notes\\cover.png')
    expect(result.reference).toBe('file://server/share/notes/cover.png')
    expect(result.usedFallback).toBe(true)
  })

  it('preserves POSIX path component case and does not collapse Unicode normalization', () => {
    expect(reference(posix(metadata('/work/site')), '/work/Site/e\u0301.png').reference).toBe('../Site/e%CC%81.png')
    expect(reference(posix(metadata('/work/site')), '/work/site/é.png').reference).toBe('%C3%A9.png')
  })

  it('normalizes native dot segments and redundant separators before comparison', () => {
    const result = reference(posix(), '/work//notes/folder/../cover.png', undefined, '/work/notes/cover.png')
    expect(result.normalizedTargetPath).toBe('/work/notes/cover.png')
    expect(result.reference).toBe('cover.png')
  })

  it('can refer to a UNC share root itself', () => {
    const context = createDocumentResourceContext('\\\\server\\share\\notes\\post.md', '', 'win32')
    expect(reference(context, '\\\\server\\share\\', '//server/share/old.png', '\\\\server\\share\\').reference).toBe('//server/share')
  })

  it('reports unsupported file-URL hostname aliases instead of claiming identical targets', () => {
    const untitled = createDocumentResourceContext(null, '', 'posix')
    expect(createDocumentResourceReference(untitled, '\\\\localhost\\share\\cover.png')).toMatchObject({ kind: 'unsupported', reason: 'unrepresentable-target' })
    expect(createDocumentResourceReference(untitled, '\\\\bad%host\\share\\cover.png')).toMatchObject({ kind: 'unsupported', reason: 'unrepresentable-target' })
    expect(reference(untitled, '\\\\中文\\share\\new.png', '//中文/share/old.png').reference).toBe('//%E4%B8%AD%E6%96%87/share/new.png')
  })

  it('allows IDNA file-URL host syntax when the frozen locator restores the exact Unicode UNC target', () => {
    const untitled = createDocumentResourceContext(null, '', 'posix')
    expect(reference(untitled, '\\\\中文\\share\\cover.png').reference).toBe('file://xn--fiq228c/share/cover.png')
  })
})

describe('native filenames are encoded once and suffixes remain opaque', () => {
  it.each([
    { filename: '中文 image.png', expected: '%E4%B8%AD%E6%96%87%20image.png' },
    { filename: '100%.png', expected: '100%25.png' },
    { filename: '%20.png', expected: '%2520.png' },
    { filename: '%00.png', expected: '%2500.png' },
    { filename: 'a?b#c.png', expected: 'a%3Fb%23c.png' },
    { filename: 'a&amp;b.png', expected: 'a%26amp%3Bb.png' },
    { filename: "a('b')[c]!.png", expected: 'a%28%27b%27%29%5Bc%5D%21.png' },
    { filename: 'cover:part.png', expected: './cover%3Apart.png' },
    { filename: 'C:cover.png', expected: './C%3Acover.png' },
    { filename: '\\cover.png', expected: './%5Ccover.png' },
    { filename: 'a\\b.png', expected: 'a%5Cb.png' },
  ])('encodes native POSIX $filename without decoding it', ({ filename, expected }) => {
    const result = reference(posix(), `/work/notes/${filename}`)
    expect(result.reference).toBe(expected)
  })

  it('separates encoded query/hash filename characters from an exact original suffix', () => {
    const result = reference(posix(), '/work/notes/new?#%.png', './old%3F%23.png?raw=%ZZ&x=1#')
    expect(result.reference).toBe('./new%3F%23%25.png?raw=%ZZ&x=1#')
    expect(result.suffix).toBe('?raw=%ZZ&x=1#')
    expect(result.resolution.decodedPath).toBe('./new?#%.png')
  })

  it('does not HTML-entity-decode already parsed native or original reference values', () => {
    const result = reference(posix(), '/work/notes/new&amp;.png', 'old&amp;.png?x=&amp;#')
    expect(result.reference).toBe('new%26amp%3B.png?x=&amp;#')
  })

  it('encodes filename bytes before appending a suffix to a file URL', () => {
    const context = posix(metadata('https://example.com/root'))
    const result = reference(context, "/work/notes/中文 %?#&('x').png", 'old.png?#')
    expect(result.reference).toBe('file:///work/notes/%E4%B8%AD%E6%96%87%20%25%3F%23%26%28%27x%27%29.png?#')
  })

  it('does not reinterpret native Windows literal percent escapes', () => {
    expect(reference(windows(), 'C:\\work\\notes\\%20中文.png').reference).toBe('%2520%E4%B8%AD%E6%96%87.png')
  })

  it('supports literal POSIX backslashes inside a file URL', () => {
    const result = reference(posix(), '/work/notes/a\\b.png', 'file:///work/notes/old.png')
    expect(result.reference).toBe('file:///work/notes/a%5Cb.png')
  })
})

describe('invalid inputs and non-authorization contract', () => {
  it.each(['relative.png', '../relative.png', 'C:relative.png', 'file:///work/cover.png', 'https://example.com/cover.png', ''])('rejects a non-native absolute target %s', (target) => {
    expect(createDocumentResourceReference(posix(), target)).toMatchObject({ kind: 'invalid', reason: 'target-not-absolute' })
  })

  it.each(['C:\\cover.png:stream', 'C:\\bad?.png', 'C:\\bad*.png', '/work/\u0000.png', '/work/\n.png', '\\\\server', '\\\\?\\C:\\cover.png', '\\\\.\\C:\\cover.png', '\\rooted.png'])('rejects an invalid or non-qualified native target %s', (target) => {
    expect(createDocumentResourceReference(posix(), target)).toMatchObject({ kind: 'invalid', reason: 'invalid-target-path' })
  })

  it('rejects non-UTF8-representable native filename strings rather than replacing bytes', () => {
    expect(createDocumentResourceReference(posix(), '/work/\ud800.png')).toMatchObject({ kind: 'invalid', reason: 'invalid-target-encoding' })
  })

  it.each(['%ZZ.png', '%00.png', '', '?x', 'bad\n.png', 'file:///work/%ZZ.png', 'file://user:password@server/share/a.png'])('rejects a malformed original reference %s', (original) => {
    expect(createDocumentResourceReference(posix(), '/work/notes/new.png', original)).toMatchObject({ kind: 'invalid', reason: 'invalid-original-reference', originalReference: original })
  })

  it.each(['ftp://example.com/old.png', '%66tp%3Aold.png', 'C:old.png', '//server', '\\\\?\\C:\\old.png'])('rejects an unsupported original reference %s', (original) => {
    expect(createDocumentResourceReference(posix(), '/work/notes/new.png', original)).toMatchObject({ kind: 'unsupported', reason: 'unsupported-original-reference' })
  })

  it.each(['https://example.com/a.png?x#y', 'http://example.com/a.png', 'data:image/png;base64,AA', 'blob:https://example.com/id'])('does not retarget an external reference %s to a local file', (original) => {
    expect(createDocumentResourceReference(posix(), '/work/notes/new.png', original)).toMatchObject({ kind: 'unsupported', reason: 'external-original-reference', originalReference: original })
  })

  it('can preserve suffix while falling back from a relative original without a document base', () => {
    const result = reference(createDocumentResourceContext(null, '', 'posix'), '/assets/new.png', './old.png?x#')
    expect(result).toMatchObject({ reference: 'file:///assets/new.png?x#', requestedStyle: null, usedFallback: true })
  })

  it('can preserve suffix when a native volume-rooted original has no Windows volume', () => {
    const result = reference(createDocumentResourceContext(null, '', 'win32'), 'C:\\new.png', '\\old.png?#')
    expect(result).toMatchObject({ reference: 'file:///C:/new.png?#', usedFallback: true })
  })

  it('does not touch the filesystem, mutate the context or claim authorization', () => {
    const context = posix(metadata('/a/nonexistent/root'))
    const before = structuredClone(context)
    reference(context, '/outside/nonexistent/image.png', '/old.png')
    expect(context).toEqual(before)
    for (const operation of [readFile, realpath, stat, copyFile, rename, unlink, mkdir, readFileSync, realpathSync, statSync, writeFileSync]) {
      expect(operation).not.toHaveBeenCalled()
    }
  })

  it('returns native target normalization without conflating it with filesystem identity', () => {
    const result = reference(posix(), '/work/notes/alias/../missing.png', undefined, '/work/notes/missing.png')
    expect(result.normalizedTargetPath).toBe(path.posix.normalize('/work/notes/missing.png'))
    expect('realPath' in result).toBe(false)
    expect('authorizedRoot' in result).toBe(false)
  })
})
