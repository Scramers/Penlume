import { randomUUID } from 'node:crypto'
import { mkdir, realpath, lstat, link, unlink, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isPathInsideRoot, isSupportedWorkspaceFile, resolveAuthorizedWorkspaceFile } from './workspace-service'
import type { WorkspaceMutation } from '../shared/contracts'
import { rebaseDocumentLinks } from './rebase-links'
import { readDocumentSnapshot } from './file-service'
import { encodeUtf8 } from '../shared/text-format'

// No recursive deletion: removed documents remain recoverable in a workspace-local trash folder.
export class WorkspaceMutations {
  private queue: Promise<unknown> = Promise.resolve()
  run(root: string, request: WorkspaceMutation): Promise<string | null> {
    const operation = this.queue.then(() => this.perform(root, request))
    this.queue = operation.catch(() => undefined)
    return operation
  }
  private async destination(root: string, relative: string, directory = false): Promise<string> {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('请输入工作区内有效的相对路径。')
    const candidate = path.resolve(root, relative)
    const parent = await realpath(path.dirname(candidate))
    if (parent !== root && !isPathInsideRoot(root, parent)) throw new Error('目标目录超出工作区。')
    if (!directory && !isSupportedWorkspaceFile(candidate)) throw new Error('文件扩展名必须为 .md、.markdown 或 .txt。')
    return path.join(parent, path.basename(candidate))
  }
  private async trashDirectory(root: string): Promise<string> {
    const trash = path.join(root, '.ttypora-trash')
    await mkdir(trash, { recursive: true })
    if ((await lstat(trash)).isSymbolicLink() || !isPathInsideRoot(root, await realpath(trash))) throw new Error('恢复目录无效。')
    return trash
  }
  private async perform(inputRoot: string, request: WorkspaceMutation): Promise<string | null> {
    const root = await realpath(inputRoot)
    if (request.action === 'create-file' || request.action === 'create-directory') {
      const dest = await this.destination(root, request.target ?? '', request.action === 'create-directory')
      if (request.action === 'create-directory') await mkdir(dest)
      else await writeFile(dest, '', { flag: 'wx' })
      return dest
    }
    if (request.action === 'restore') {
      const trash = await this.trashDirectory(root)
      const { readdir } = await import('node:fs/promises')
      const names = (await readdir(trash)).filter((name) => /^\d+-[a-f\d-]+\.json$/.test(name)).sort().reverse()
      for (const name of names) {
        const metadata = JSON.parse(await readFile(path.join(trash, name), 'utf8')) as { relative: string }
        const dest = await this.destination(root, metadata.relative)
        const stored = path.join(trash, name.replace(/\.json$/, '.md'))
        if (!(await lstat(stored)).isFile() || (await lstat(stored)).isSymbolicLink()) throw new Error('恢复文件无效。')
        await link(stored, dest) // EEXIST protects an independently recreated document.
        await unlink(stored)
        await unlink(path.join(trash, name))
        return dest
      }
      throw new Error('没有可恢复的文档。')
    }
    const source = await resolveAuthorizedWorkspaceFile(root, request.path ?? '')
    if (request.action === 'delete') {
      const trash = await this.trashDirectory(root)
      const id = `${Date.now()}-${randomUUID()}`
      const stored = path.join(trash, `${id}.md`)
      await writeFile(path.join(trash, `${id}.json`), JSON.stringify({ relative: path.relative(root, source) }), { flag: 'wx' })
      await link(source, stored)
      await unlink(source)
      return null
    }
    const dest = await this.destination(root, request.target ?? '')
    if (source === dest) return source
    if (path.dirname(source) !== path.dirname(dest)) {
      const snapshot = await readDocumentSnapshot(source)
      const markdown = await rebaseDocumentLinks(snapshot.markdown, source, dest, root)
      await writeFile(dest, encodeUtf8(markdown, snapshot.format), { flag: 'wx' })
      if ((await readDocumentSnapshot(source)).version.sha256 !== snapshot.version.sha256) throw new Error('移动期间原文件发生变化，已保留原文件和目标副本。')
      await unlink(source)
      return dest
    }
    await link(source, dest)
    await unlink(source)
    return dest
  }
}
