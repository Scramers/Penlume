import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const workspaceRoot = resolve(import.meta.dirname, '..')

for (const directory of ['dist', 'coverage']) {
  await rm(resolve(workspaceRoot, directory), {
    force: true,
    recursive: true,
  })
}

