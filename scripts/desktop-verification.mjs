import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Run one Electron suite at a time: desktop screenshots share the Windows session.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const available = ['electron', 'parity', 'workspace', 'editor-history', 'inline-extensions', 'image-library', 'production-tools', 'media', 'image-uploader', 'localization', 'editor-locale', 'table-tools', 'table-clipboard', 'table-hardbreak', 'code-math', 'writing-aids', 'resource-root', 'image-binding', 'outline', 'image-input-preview', 'outline-controls', 'layout', 'selection-copy', 'typography']
const requested = process.argv.slice(2)
const suites = requested.length ? requested : available
for (const suite of suites) assert(available.includes(suite), `Unknown desktop suite: ${suite}`)
const mode = process.env.TTYPORA_PACKAGED_EXE ? 'packaged' : 'source'
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const prefix = process.env.TTYPORA_VERIFICATION_PREFIX ?? `v${version.replace(/\.0$/, '')}-${mode}`
const suiteEnv = { ...process.env, TTYPORA_VERIFICATION_PREFIX: prefix }
const verbose = process.env.TTYPORA_VERBOSE_VERIFICATION === '1'
assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix) && !prefix.includes('..'), 'Verification prefix must be a file name, without paths.')
const artifacts = path.join(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
const results = []
for (const suite of suites) {
  const started = Date.now()
  console.log(`Running ${suite} (${mode})...`)
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', `${suite}-smoke.mjs`)], { cwd: root, env: suiteEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (data) => { text += data.toString(); if (verbose) process.stdout.write(data) })
    child.stderr.on('data', (data) => { text += data.toString(); if (verbose) process.stderr.write(data) })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ text, code, signal }))
  })
  const log = `${suite}-${prefix}.log`
  await writeFile(path.join(artifacts, log), output.text)
  const result = { suite, mode, exitCode: output.code, signal: output.signal, elapsedMs: Date.now() - started, log }
  results.push(result)
  await writeFile(path.join(artifacts, `desktop-${prefix}.json`), JSON.stringify({ executable: process.env.TTYPORA_PACKAGED_EXE ?? null, completedAt: new Date().toISOString(), results }, null, 2) + '\n')
  if (output.code !== 0) {
    console.error(output.text)
    throw new Error(`${suite} failed (${output.code ?? output.signal}). See artifacts/${log}.`)
  }
  console.log(`Passed ${suite} in ${Math.round(result.elapsedMs / 1000)}s; artifacts/${log}`)
}
console.log(`All ${results.length} desktop suites passed (${mode}).`)
