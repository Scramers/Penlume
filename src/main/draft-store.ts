import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { RecoveryDraft } from '../shared/contracts'
import { recoveryDraftSchema } from '../shared/schemas'

function draftFileName(id: string): string {
  return `${createHash('sha256').update(id).digest('hex')}.json`
}

export class DraftStore {
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly directory: string) {}

  private serialize(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.pending.set(id, next)
    void next.finally(() => { if (this.pending.get(id) === next) this.pending.delete(id) }).catch(() => undefined)
    return next
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  async write(draft: RecoveryDraft): Promise<void> {
    const validated = recoveryDraftSchema.parse(draft)
    return this.serialize(validated.id, () => this.writeNow(validated))
  }

  private async writeNow(validated: RecoveryDraft): Promise<void> {
    await this.ensureDirectory()
    const destination = path.join(this.directory, draftFileName(validated.id))
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)

    try {
      await handle.writeFile(JSON.stringify(validated), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await rename(temporary, destination)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async clear(id: string): Promise<void> {
    return this.serialize(id, () => this.clearNow(id))
  }

  private async clearNow(id: string): Promise<void> {
    await this.ensureDirectory()
    await unlink(path.join(this.directory, draftFileName(id))).catch((error) => {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
    })
  }

  async get(id: string): Promise<RecoveryDraft | null> {
    await this.pending.get(id)
    await this.ensureDirectory()
    try {
      const content = await readFile(
        path.join(this.directory, draftFileName(id)),
        'utf8',
      )
      return recoveryDraftSchema.parse(JSON.parse(content))
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null
      }
      throw error
    }
  }

  async list(): Promise<RecoveryDraft[]> {
    await Promise.all([...this.pending.values()])
    await this.ensureDirectory()
    const entries = await readdir(this.directory, { withFileTypes: true })
    const drafts: RecoveryDraft[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue

      try {
        const content = await readFile(
          path.join(this.directory, entry.name),
          'utf8',
        )
        drafts.push(recoveryDraftSchema.parse(JSON.parse(content)))
      } catch (error) {
        console.warn(`Ignoring invalid recovery draft: ${entry.name}`, error)
      }
    }

    return drafts.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
  }
}
