import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile } from '@electron/asar'

// Package an already-built application without the bundled Pandoc distribution.
// This script deliberately never invokes npm build, clean, or any source compiler.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const outputName = `release-core-v${metadata.version}`
const output = path.resolve(root, outputName)
const artifacts = path.join(root, 'artifacts')
assert.equal(path.dirname(output), root, 'Core output must be directly inside the project.')
assert.equal(process.platform, 'win32', 'Windows Core packages must be built on Windows.')
assert.equal(metadata.name, 'penlume')
const verifyOnly = process.argv.slice(2).includes('--verify-only')
assert(process.argv.slice(2).every((argument) => argument === '--verify-only'), 'Only --verify-only is supported.')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function files(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), relative))
    else if (entry.isFile()) result.push(relative)
    else throw new Error(`Unexpected symbolic or special file: ${relative}`)
  }
  return result.sort()
}
const compiled = []
for (const relative of await files(path.join(root, 'dist'))) {
  compiled.push({ path: `dist/${relative.replaceAll(path.sep, '/')}`, relative, sha256: digest(await readFile(path.join(root, 'dist', relative))) })
}
assert(compiled.length > 0, 'Compile the application before packaging Core.')
assert(compiled.some((file) => file.path === 'dist/electron/main/index.js'), 'Compiled Electron main is missing.')
const rootLicenseNames = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']
const rootLicenseDestination = (name) => `licenses/${name === 'LICENSE' ? 'Penlume-LICENSE' : name}`
const rootLicenses = []
for (const name of rootLicenseNames) {
  const bytes = await readFile(path.join(root, name))
  assert(bytes.length > 0, `Required root notice is empty: ${name}`)
  rootLicenses.push({ source: name, destination: rootLicenseDestination(name), sha256: digest(bytes), bytes: bytes.length })
}
const originalResources = metadata.build.extraResources ?? []
const isPandocResource = (resource) => {
  const from = (typeof resource === 'string' ? resource : resource.from ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
  const to = (typeof resource === 'string' ? '' : resource.to ?? '').replaceAll('\\', '/')
  return /^\.tools\/pandoc(?:\/|$)/i.test(from) || /^tools\/pandoc(?:\/|$)/i.test(to)
}
const excluded = originalResources.filter(isPandocResource)
assert.equal(excluded.length, 2, 'The Core override must remove both original Pandoc resource entries.')
const extraResources = [
  ...originalResources.filter((resource) => !isPandocResource(resource) && !rootLicenseNames.includes((typeof resource === 'string' ? resource : resource.from ?? '').replaceAll('\\', '/').replace(/^\.\//, ''))),
  ...rootLicenseNames.map((name) => ({ from: name, to: rootLicenseDestination(name) })),
]

if (!verifyOnly) {
  try {
    assert.equal((await readdir(output)).length, 0, 'Core release output already has files; preserve it or use --verify-only.')
  } catch (error) { if (error?.code !== 'ENOENT') throw error }
  await mkdir(artifacts, { recursive: true })
  // electron-builder deep-merges array options with package.json's build field.
  // Supply a complete, separate config file so Pandoc entries are replaced,
  // rather than accidentally merged back into extraResources.
  const configFile = path.join(artifacts, 'core-builder-config.json')
  await writeFile(configFile, JSON.stringify({
    ...metadata.build,
    directories: { ...metadata.build.directories, output: outputName },
    electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
    extraResources, npmRebuild: false,
    win: { ...metadata.build.win, target: ['nsis', 'portable'] },
    nsis: { ...metadata.build.nsis, artifactName: 'Penlume Core Setup ${version}.${ext}' },
    portable: { ...metadata.build.portable, artifactName: 'Penlume Core Portable ${version}.${ext}' },
  }, null, 2) + '\n')
  const { build, Platform, Arch } = await import('electron-builder')
  await build({
    projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64), publish: 'never',
    config: configFile,
  })
}

const resources = path.join(output, 'win-unpacked', 'resources')
const archive = path.join(resources, 'app.asar')
const bundledMetadata = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
assert.equal(bundledMetadata.name, metadata.name)
assert.equal(bundledMetadata.version, metadata.version)
assert.equal(bundledMetadata.productName, metadata.build.productName)
for (const file of compiled) {
  assert.equal(digest(await readFile(path.join(root, 'dist', file.relative))), file.sha256, `Compiled source changed during packaging: ${file.path}`)
  assert.equal(digest(extractFile(archive, path.normalize(file.path))), file.sha256, `Core archive differs from existing dist: ${file.path}`)
}
const resourceFiles = await files(resources)
assert.equal(resourceFiles.some((file) => /(?:^|[\\/])pandoc(?:\.exe|[\\/]|$)/i.test(file)), false, 'Core resources must not include a bundled Pandoc distribution.')
for (const license of rootLicenses) {
  assert.equal(digest(await readFile(path.join(root, license.source))), license.sha256, `Root notice changed during packaging: ${license.source}`)
  assert.equal(digest(await readFile(path.join(resources, license.destination))), license.sha256, `Missing or altered bundled notice: ${license.destination}`)
}
for (const name of ['licenses/emoji-data.LICENSE', 'licenses/markdown-character-entities.LICENSE']) {
  assert((await readFile(path.join(resources, name))).length > 0, `Missing original data license: ${name}`)
}
const runtimeNotices = []
for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
  const bytes = await readFile(path.join(output, 'win-unpacked', name))
  assert(bytes.length > 0, `Missing Electron/Chromium runtime notice: ${name}`)
  runtimeNotices.push({ path: name, bytes: bytes.length, sha256: digest(bytes) })
}
const outputs = []
for (const name of [`Penlume Core Setup ${metadata.version}.exe`, `Penlume Core Portable ${metadata.version}.exe`]) {
  const bytes = await readFile(path.join(output, name))
  assert(bytes.length > 1_000_000 && bytes[0] === 0x4d && bytes[1] === 0x5a, `Invalid Windows executable: ${name}`)
  outputs.push({ name, bytes: bytes.length, sha256: digest(bytes) })
}
await mkdir(artifacts, { recursive: true })
await writeFile(path.join(output, 'SHA256SUMS.txt'), outputs.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n')
const report = {
  verifiedAt: new Date().toISOString(), version: metadata.version, variant: 'Core', release: output,
  metadataUnchanged: true, compiledFiles: compiled.map(({ relative: _relative, ...file }) => file), allCompiledFilesMatch: true,
  bundledPandoc: false, excludedResources: excluded, rootLicenses, originalDataLicensesPresent: true, runtimeNotices, outputs,
  limitations: ['No Windows installer was run by the packaging verifier.', 'The application can use a separately selected or system-installed Pandoc; none is distributed in the Core resources.'],
}
await writeFile(path.join(artifacts, 'core-release-verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ version: metadata.version, variant: 'Core', compiledFiles: compiled.length, bundledPandoc: false, rootLicenses: rootLicenses.length, outputs }, null, 2))
