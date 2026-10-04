import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isPathInsideRoot,
  readWorkspaceSnapshot,
  resolveAuthorizedWorkspaceFile,
  searchWorkspace,
} from '../src/main/workspace-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('workspace service', () => {
  it('lists supported documents and skips unrelated content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-workspace-'))
    temporaryDirectories.push(root)
    await mkdir(path.join(root, 'notes'))
    await writeFile(path.join(root, '10-last.md'), '# Last')
    await writeFile(path.join(root, '2-first.md'), '# First')
    await writeFile(path.join(root, 'ignored.json'), '{}')
    await writeFile(path.join(root, 'notes', 'nested.markdown'), '# Nested')

    const snapshot = await readWorkspaceSnapshot(root)

    expect(snapshot.entries.map((entry) => entry.name)).toEqual([
      'notes',
      '2-first.md',
      '10-last.md',
    ])
    expect(snapshot.entries[0].children?.[0].name).toBe('nested.markdown')
  })

  it('rejects sibling paths that only share a prefix', async () => {
    const root = path.join(tmpdir(), 'workspace')
    expect(isPathInsideRoot(root, path.join(root, 'note.md'))).toBe(true)
    expect(isPathInsideRoot(root, path.join(tmpdir(), 'workspace-copy', 'note.md'))).toBe(false)
  })

  it('authorizes supported files only inside the selected root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-workspace-'))
    temporaryDirectories.push(root)
    const notePath = path.join(root, 'note.md')
    const otherPath = path.join(root, 'note.json')
    await writeFile(notePath, '# Note')
    await writeFile(otherPath, '{}')

    await expect(resolveAuthorizedWorkspaceFile(root, notePath)).resolves.toBe(notePath)
    await expect(resolveAuthorizedWorkspaceFile(root, otherPath)).rejects.toThrow(/不受支持/)
  })

  it('searches workspace text with line information and options', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-workspace-'))
    temporaryDirectories.push(root)
    await writeFile(path.join(root, 'one.md'), '# Apple\nAn apple a day\nPineapple')
    await writeFile(path.join(root, 'two.md'), 'APPLE pie')

    const literal = await searchWorkspace(root, {
      query: 'apple',
      caseSensitive: false,
      wholeWord: true,
      regexp: false,
    })
    expect(literal.matches.map((match) => [match.relativePath, match.line])).toEqual([
      ['one.md', 1],
      ['one.md', 2],
      ['two.md', 1],
    ])

    const regexp = await searchWorkspace(root, {
      query: '^A.+day$',
      caseSensitive: true,
      wholeWord: false,
      regexp: true,
    })
    expect(regexp.matches).toHaveLength(1)
    expect(regexp.matches[0]).toMatchObject({ line: 2, column: 1 })
  })

  it('rejects invalid workspace regular expressions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttypora-workspace-'))
    temporaryDirectories.push(root)
    await writeFile(path.join(root, 'note.md'), 'text')

    await expect(searchWorkspace(root, {
      query: '[',
      caseSensitive: false,
      wholeWord: false,
      regexp: true,
    })).rejects.toThrow()
  })
})
