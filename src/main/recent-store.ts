import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

const entrySchema = z.object({ path: z.string().min(1), kind: z.enum(['file', 'directory']), pinned: z.boolean(), openedAt: z.string() })
export type RecentEntry = z.infer<typeof entrySchema>

export class RecentStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly filePath: string) {}
  async list(): Promise<RecentEntry[]> {
    try { return z.array(entrySchema).parse(JSON.parse(await readFile(this.filePath, 'utf8'))) }
    catch (reason) { if ((reason as NodeJS.ErrnoException).code === 'ENOENT' || reason instanceof SyntaxError || reason instanceof z.ZodError) return []; throw reason }
  }
  private update(change: (entries: RecentEntry[]) => RecentEntry[]): Promise<RecentEntry[]> {
    const run = this.pending.then(async () => {
      const entries = change(await this.list())
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const temp = `${this.filePath}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(entries), { mode: 0o600 })
      await rename(temp, this.filePath)
      return entries
    })
    this.pending = run.catch(() => undefined)
    return run
  }
  remember(filePath: string, kind: RecentEntry['kind']): Promise<RecentEntry[]> {
    return this.update((entries) => {
      const normalized = path.resolve(filePath)
      const existing = entries.find((entry) => entry.path === normalized)
      return [{ path: normalized, kind, pinned: existing?.pinned ?? false, openedAt: new Date().toISOString() }, ...entries.filter((entry) => entry.path !== normalized)]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned)).slice(0, 50)
    })
  }
  pin(filePath: string): Promise<RecentEntry[]> { return this.update((entries) => entries.map((entry) => entry.path === filePath ? { ...entry, pinned: !entry.pinned } : entry)) }
  clear(): Promise<RecentEntry[]> { return this.update((entries) => entries.filter((entry) => entry.pinned)) }
}
