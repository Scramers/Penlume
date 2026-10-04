import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceMutations } from '../src/main/workspace-mutations'
import { RecentStore } from '../src/main/recent-store'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const result = await mkdtemp(path.join(tmpdir(), 'ttypora-mutation-')); roots.push(result); return result }

it('creates, renames, removes and restores a document without overwriting collisions', async () => {
  const workspace = await root()
  const service = new WorkspaceMutations()
  const original = (await service.run(workspace, { action: 'create-file', target: 'test.md' }))!
  await writeFile(original, 'valuable text')
  await expect(service.run(workspace, { action: 'create-file', target: 'test.md' })).rejects.toThrow()
  await service.run(workspace, { action: 'rename', path: original, target: 'renamed.md' })
  const renamed = path.join(workspace, 'renamed.md')
  await service.run(workspace, { action: 'delete', path: renamed })
  await writeFile(renamed, 'new text')
  await expect(service.run(workspace, { action: 'restore' })).rejects.toThrow()
  expect(await readFile(renamed, 'utf8')).toBe('new text')
  await rm(renamed)
  await service.run(workspace, { action: 'restore' })
  expect(await readFile(renamed, 'utf8')).toBe('valuable text')
})

it('rejects escape paths, unsupported files and reserved names', async () => {
  const workspace = await root(), service = new WorkspaceMutations()
  for (const target of ['../outside.md', '.ttypora-trash/test.md', 'con.md', 'program.exe', 'C:\\escape.md']) {
    await expect(service.run(workspace, { action: 'create-file', target })).rejects.toThrow()
  }
  await service.run(workspace, { action: 'create-directory', target: 'notes' })
  await service.run(workspace, { action: 'create-file', target: 'notes/ok.md' })
})

it('persists recent projects and preserves pinned records when clearing', async () => {
  const workspace = await root(), store = new RecentStore(path.join(workspace, 'recent.json'))
  await Promise.all([store.remember(path.join(workspace, 'a.md'), 'file'), store.remember(path.join(workspace, 'b.md'), 'file')])
  await store.pin(path.join(workspace, 'a.md'))
  await store.clear()
  const entries = await new RecentStore(path.join(workspace, 'recent.json')).list()
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ path: path.join(workspace, 'a.md'), pinned: true })
})

it('rebases relative resources on a move and preserves code, metadata and BOM/CRLF', async () => {
  const workspace = await root(), service = new WorkspaceMutations()
  await mkdir(path.join(workspace, 'sub'))
  const original = path.join(workspace, 'original.md')
  const content = '\uFEFF---\r\ntitle: Keep me\r\n---\r\n\r\n![image](asset.png)\r\n\r\n`![literal](asset.png)`\r\n'
  await writeFile(original, content)
  await service.run(workspace, { action: 'rename', path: original, target: 'sub/moved.md' })
  const moved = await readFile(path.join(workspace, 'sub/moved.md'), 'utf8')
  expect(moved).toContain('![image](../asset.png)')
  expect(moved).toContain('`![literal](asset.png)`')
  expect(moved.startsWith('\uFEFF---\r\n')).toBe(true)
})
