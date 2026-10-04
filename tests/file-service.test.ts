import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readDocumentSnapshot,
  saveDocumentAtomically,
} from '../src/main/file-service'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ttypora-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('file service', () => {
  it('saves through a same-directory temporary file', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'document.md')
    await writeFile(filePath, '# Old\n', 'utf8')
    const original = await readDocumentSnapshot(filePath)

    const result = await saveDocumentAtomically({
      path: filePath,
      markdown: '# New\n',
      format: original.format,
      expectedVersion: original.version,
    })

    expect(result.status).toBe('saved')
    expect(await readFile(filePath, 'utf8')).toBe('# New\n')
  })

  it('refuses to overwrite an externally changed file', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'document.md')
    await writeFile(filePath, '# Original\n', 'utf8')
    const original = await readDocumentSnapshot(filePath)
    await writeFile(filePath, '# External\n', 'utf8')

    const result = await saveDocumentAtomically({
      path: filePath,
      markdown: '# Local\n',
      format: original.format,
      expectedVersion: original.version,
    })

    expect(result.status).toBe('conflict')
    expect(await readFile(filePath, 'utf8')).toBe('# External\n')
  })

  it('creates a new UTF-8 document when no version exists', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'new.md')

    const result = await saveDocumentAtomically({
      path: filePath,
      markdown: '新文档\n',
      format: { hasBom: false, lineEnding: 'lf' },
      expectedVersion: null,
    })

    expect(result.status).toBe('saved')
    expect(await readFile(filePath, 'utf8')).toBe('新文档\n')
  })
})

