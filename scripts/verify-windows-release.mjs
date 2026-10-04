import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile } from '@electron/asar'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const release = path.resolve(root, process.argv[2] ?? `release-v${metadata.version}`)
assert(release.startsWith(root + path.sep), 'Release must be inside the project.')
const archive = path.join(release, 'win-unpacked/resources/app.asar')
const bundledMetadata = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
assert.equal(bundledMetadata.version, metadata.version)
assert.equal(bundledMetadata.name, metadata.name)
assert.equal(bundledMetadata.productName, metadata.build.productName)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function files(directory, prefix = '') {
  const results = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) results.push(...await files(path.join(directory, entry.name), relative))
    else if (entry.isFile()) results.push(relative)
  }
  return results
}
const sourceFiles = await files(path.join(root, 'dist'))
const compiled = []
for (const relative of sourceFiles) {
  const source = await readFile(path.join(root, 'dist', relative))
  const packaged = extractFile(archive, path.normalize(path.join('dist', relative)))
  const sha256 = digest(source)
  assert.equal(digest(packaged), sha256, `Packaged file differs: ${relative}`)
  compiled.push({ path: `dist/${relative.replaceAll(path.sep, '/')}`, sha256 })
}
const resources = path.join(release, 'win-unpacked/resources')
const pandoc = await readFile(path.join(root, '.tools/pandoc/pandoc-3.12/pandoc.exe'))
assert.equal(digest(await readFile(path.join(resources, 'tools/pandoc/pandoc.exe'))), digest(pandoc))
const provenance = JSON.parse(await readFile(path.join(resources, 'tools/pandoc/provenance.json'), 'utf8'))
const licenses = ['tools/pandoc/COPYRIGHT.txt', 'tools/pandoc/COPYING.rtf', 'tools/pandoc/MANUAL.html', 'licenses/emoji-data.LICENSE', 'licenses/markdown-character-entities.LICENSE']
for (const name of licenses) assert((await readFile(path.join(resources, name))).length > 0, `Empty license: ${name}`)
const executables = [`${metadata.build.productName} Setup ${metadata.version}.exe`, `${metadata.build.productName} Portable ${metadata.version}.exe`]
const outputs = []
for (const name of executables) {
  const bytes = await readFile(path.join(release, name))
  assert(bytes.length > 1_000_000 && bytes[0] === 0x4d && bytes[1] === 0x5a, `Invalid Windows executable: ${name}`)
  outputs.push({ name, bytes: bytes.length, sha256: digest(bytes) })
}
await writeFile(path.join(release, 'SHA256SUMS.txt'), outputs.map((item) => `${item.sha256}  ${item.name}`).join('\n') + '\n')
const report = { version: metadata.version, verifiedAt: new Date().toISOString(), release, compiledFiles: compiled, allCompiledFilesMatch: true, bundledPandocMatches: true, pandocVersion: provenance.version, provenance, licenses, outputs }
await writeFile(path.join(root, 'artifacts', `release-v${metadata.version}-verification.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ version: report.version, allCompiledFilesMatch: true, files: compiled.length, bundledPandocMatches: true, licenses: licenses.length, outputs }, null, 2))
