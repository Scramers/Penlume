import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
)
const executablePath = process.env.TTYPORA_PORTABLE_EXE ?? path.join(
  projectRoot,
  packageMetadata.build.directories.output,
  `${packageMetadata.build.productName} Portable ${packageMetadata.version}.exe`,
)
const smokeDirectory = await mkdtemp(path.join(os.tmpdir(), 'ttypora-portable-smoke-'))
const readyFile = path.join(smokeDirectory, 'ready.json')

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds)
})

async function waitForReady(child, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(readyFile, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (child.exitCode !== null) {
      throw new Error(`Portable launcher exited before readiness (code ${child.exitCode}).`)
    }
    await delay(500)
  }
  throw new Error('Portable launcher did not reach renderer readiness within 120 seconds.')
}

async function waitForExit(child, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100)
  assert.equal(child.signalCode, null, 'Portable launcher must exit normally after the smoke app closes.')
  assert.equal(child.exitCode, 0, 'Portable launcher must finish after its child app closes.')
}

console.log('Launching portable build readiness test...')
const child = spawn(executablePath, [], {
  cwd: projectRoot,
  env: {
    ...process.env,
    TTYPORA_SMOKE_TEST: '1',
    TTYPORA_USER_DATA_PATH: path.join(smokeDirectory, 'user-data'),
    TTYPORA_PORTABLE_SMOKE_READY_FILE: readyFile,
    TTYPORA_PORTABLE_SMOKE_AUTO_EXIT: '1',
  },
  stdio: 'ignore',
  windowsHide: true,
})

try {
  const readiness = await waitForReady(child, 120_000)
  assert.equal(readiness.rendererReady, true)
  assert.equal(typeof readiness.pid, 'number')
  assert.equal(typeof readiness.executablePath, 'string')
  assert.equal(typeof readiness.portableExecutableDir, 'string')
  await waitForExit(child, 15_000)
  console.log('Portable build passed: wrapper extraction, Electron launch, and renderer editor readiness.')
} finally {
  if (child.exitCode === null) child.kill()
  const cleanupTarget = path.resolve(smokeDirectory)
  assert.equal(path.dirname(cleanupTarget), path.resolve(os.tmpdir()), 'Cleanup must stay in the native temporary directory.')
  assert(path.basename(cleanupTarget).startsWith('ttypora-portable-smoke-'), 'Cleanup must target this smoke test directory.')
  await rm(cleanupTarget, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
