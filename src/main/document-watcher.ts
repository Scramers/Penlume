import chokidar, { type FSWatcher } from 'chokidar'
import type { WebContents } from 'electron'
import { IPC } from '../shared/ipc'
import { normalizeFilePath, tryReadDocumentSnapshot } from './file-service'

interface WatchRegistration {
  watcher: FSWatcher
  path: string
  knownHash: string
  timer: NodeJS.Timeout | null
}

export class DocumentWatcherRegistry {
  private readonly registrations = new Map<number, Map<string, WatchRegistration>>()

  async watch(contents: WebContents, filePath: string, knownHash: string) {
    const key = normalizeFilePath(filePath).toLocaleLowerCase()
    const registrations = this.registrations.get(contents.id) ?? new Map<string, WatchRegistration>()
    const existing = registrations.get(key)
    if (existing) { existing.knownHash = knownHash; return }
    this.registrations.set(contents.id, registrations)

    const watcher = chokidar.watch(filePath, {
      awaitWriteFinish: {
        pollInterval: 50,
        stabilityThreshold: 150,
      },
      ignoreInitial: true,
    })

    const registration: WatchRegistration = {
      watcher,
      path: filePath,
      knownHash,
      timer: null,
    }

    const scheduleCheck = () => {
      if (registration.timer) clearTimeout(registration.timer)
      registration.timer = setTimeout(async () => {
        registration.timer = null
        if (contents.isDestroyed() || registrations.get(key) !== registration) return

        try {
          const snapshot = await tryReadDocumentSnapshot(filePath)
          if (registrations.get(key) !== registration) return
          if (!snapshot) {
            registration.knownHash = ''
            contents.send(IPC.externalFileChange, {
              path: filePath,
              kind: 'deleted',
              snapshot: null,
            })
            return
          }

          if (snapshot.version.sha256 === registration.knownHash) return
          registration.knownHash = snapshot.version.sha256
          contents.send(IPC.externalFileChange, {
            path: filePath,
            kind: 'changed',
            snapshot,
          })
        } catch (error) {
          console.error('Failed to inspect external file change', error)
        }
      }, 100)
    }

    watcher.on('add', scheduleCheck)
    watcher.on('change', scheduleCheck)
    watcher.on('unlink', scheduleCheck)
    watcher.on('error', (error) => {
      console.error('Document watcher error', error)
    })

    registrations.set(key, registration)
  }

  updateKnownVersion(contentsId: number, filePath: string, hash: string): void {
    const registration = this.registrations.get(contentsId)?.get(normalizeFilePath(filePath).toLocaleLowerCase())
    if (registration) registration.knownHash = hash
  }

  async retain(contentsId: number, paths: string[]): Promise<void> {
    const registrations = this.registrations.get(contentsId)
    if (!registrations) return
    const wanted = new Set(paths.map((filePath) => normalizeFilePath(filePath).toLocaleLowerCase()))
    for (const [key, registration] of [...registrations]) {
      if (wanted.has(key)) continue
      registrations.delete(key)
      if (registration.timer) clearTimeout(registration.timer)
      await registration.watcher.close()
    }
  }

  async unwatch(contentsId: number): Promise<void> {
    const registrations = this.registrations.get(contentsId)
    if (!registrations) return
    this.registrations.delete(contentsId)
    await Promise.all([...registrations.values()].map(async (registration) => {
      if (registration.timer) clearTimeout(registration.timer)
      await registration.watcher.close()
    }))
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.registrations.keys()].map((contentsId) =>
        this.unwatch(contentsId),
      ),
    )
  }
}

