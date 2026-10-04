import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outputPath = path.join(root, 'THIRD_PARTY_LICENSES.txt')
const checkOnly = process.argv.includes('--check')
assert(process.argv.slice(2).every((argument) => argument === '--check'), 'Usage: node scripts/collect-licenses.mjs [--check]')
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
assert(lock.lockfileVersion >= 2 && lock.packages, 'A package-lock.json with package paths is required.')
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0
const portablePath = (value) => value.replaceAll(path.sep, '/')
const normalizeText = (value) => value.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd()
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const noticeName = /^(?:licen[sc]es?|copying|copyright|notices?|unlicen[sc]e|third[-_ ]?party[-_ ]?(?:notices?(?:text)?|licen[sc]es?))(?:[._ -].*)?$/i
const licenseName = /^(?:licen[sc]es?|copying|unlicen[sc]e)(?:[._ -].*)?$/i
const readmeName = /^readme(?:\.(?:md|markdown|txt|rst))?$/i

async function noticeFiles(directory, relative = '') {
  const result = []
  const entries = (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))
  for (const entry of entries) {
    const file = path.join(relative, entry.name)
    // Nested packages have their own lock entries; do not attribute their notices to this package.
    if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) result.push(...await noticeFiles(directory, file))
    else if (entry.isFile() && noticeName.test(entry.name)) result.push(file)
  }
  return result
}

function readmeLicenseSections(text) {
  const lines = normalizeText(text).split('\n')
  const headings = []
  for (let index = 0; index < lines.length; index++) {
    const atx = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (atx) headings.push({ index, end: index + 1, level: atx[1].length, title: atx[2] })
    else if (lines[index].trim() && /^(?:={3,}|-{3,})\s*$/.test(lines[index + 1] ?? '')) {
      headings.push({ index, end: index + 2, level: lines[index + 1].trim()[0] === '=' ? 1 : 2, title: lines[index].trim() })
      index++
    }
  }
  return headings.filter((heading) => /^(?:the\s+)?licen[sc]e(?:\b|\s|$)/i.test(heading.title))
    .map((heading) => {
      const next = headings.find((candidate) => candidate.index > heading.index && candidate.level <= heading.level)
      const end = next?.index ?? lines.length
      return lines.slice(heading.end, end).join('\n').trim() ? lines.slice(heading.index, end).join('\n').trimEnd() : ''
    }).filter(Boolean)
}

function metadataValue(value) {
  if (typeof value === 'string') return value
  if (value == null) return 'Not specified'
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.name === 'string') {
    return [value.name, value.email && `<${value.email}>`, value.url && `(${value.url})`].filter(Boolean).join(' ')
  }
  return JSON.stringify(value)
}

async function readNotice(source, kind = 'License/notice file') {
  const bytes = await readFile(path.join(root, source))
  const text = normalizeText(bytes.toString('utf8'))
  assert(text.trim() && !text.includes('\u0000'), `Empty or binary notice: ${source}`)
  return { source: portablePath(source), kind, sha256: sha256(bytes), text }
}

async function collectPackage(lockPath, locked) {
  assert(lockPath.startsWith('node_modules/') && !lockPath.includes('\\') && !lockPath.split('/').some((part) => part === '..' || part === ''), `Unexpected lock path: ${lockPath}`)
  assert(!locked.link, `Linked packages need an explicit notice source: ${lockPath}`)
  const directory = path.join(root, lockPath)
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  assert.equal(metadata.version, locked.version, `Installed version differs from lockfile: ${lockPath}; run npm ci.`)
  const expectedName = lockPath.split('node_modules/').at(-1)
  assert.equal(metadata.name, expectedName, `Installed package name differs: ${lockPath}`)
  const files = await noticeFiles(directory)
  const notices = await Promise.all(files.map((file) => readNotice(path.join(lockPath, file))))
  if (!files.some((file) => licenseName.test(path.basename(file)))) {
    const readmes = (await readdir(directory)).filter((name) => readmeName.test(name)).sort(compare)
    for (const name of readmes) {
      const source = path.join(lockPath, name)
      const bytes = await readFile(path.join(root, source))
      for (const text of readmeLicenseSections(bytes.toString('utf8'))) notices.push({
        source: portablePath(source), kind: 'Explicit README license section (no separate license file found)', sha256: sha256(bytes), text,
      })
    }
    assert(notices.some((notice) => notice.kind.startsWith('Explicit README')), `No license file or explicit README license section: ${lockPath} (${metadata.name}@${metadata.version})`)
  }
  return { name: metadata.name, version: metadata.version, license: metadataValue(metadata.license ?? locked.license),
    source: lockPath, author: metadataValue(metadata.author), repository: metadataValue(metadata.repository?.url ?? metadata.repository ?? metadata.homepage),
    notices: notices.sort((a, b) => compare(a.source, b.source) || compare(a.kind, b.kind)) }
}

const entries = Object.entries(lock.packages).filter(([packagePath, entry]) => packagePath && !entry.dev).sort(([a], [b]) => compare(a, b))
const records = new Array(entries.length)
const failures = []
let nextIndex = 0
await Promise.all(Array.from({ length: 8 }, async () => {
  while (nextIndex < entries.length) {
    const index = nextIndex++
    const [packagePath, entry] = entries[index]
    try { records[index] = await collectPackage(packagePath, entry) }
    catch (error) { failures.push(`${packagePath}: ${error.message}`) }
  }
}))

const staticSources = [
  { name: 'GitHub gemoji dataset', version: 'Vendored snapshot; source does not record a release version', license: 'MIT', source: 'src/shared/emoji-data.LICENSE', repository: 'https://github.com/github/gemoji', author: 'GitHub, Inc.' },
  { name: 'Named character entity dataset', version: 'Vendored snapshot; source does not record a release version', license: 'MIT', source: 'src/shared/markdown-character-entities.LICENSE', repository: 'https://github.com/wooorm/character-entities', author: 'Titus Wormer' },
  { name: 'Mermaid standalone browser bundle', version: lock.packages['node_modules/mermaid']?.version ?? 'Not specified', license: 'MIT (Mermaid); embedded component notices are preserved below', source: 'public/MERMAID-LICENSE', repository: 'https://github.com/mermaid-js/mermaid', author: 'Knut Sveidqvist' },
  { name: 'DOMPurify embedded in Mermaid standalone browser bundle', version: '3.4.12', license: '(Apache-2.0 OR MPL-2.0)', source: 'licenses/DOMPurify-3.4.12-LICENSE', repository: 'https://github.com/cure53/DOMPurify/tree/3.4.12', author: 'Cure53 and other contributors' },
]
const staticRecords = []
for (const entry of staticSources) {
  try {
    const record = { ...entry, notices: [await readNotice(entry.source, 'Vendored notice file')] }
    if (entry.source === 'public/MERMAID-LICENSE') {
      const bytes = await readFile(path.join(root, 'public/mermaid.min.js'))
      const installedBundle = await readFile(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'))
      assert.equal(sha256(bytes), sha256(installedBundle), 'Vendored Mermaid bundle differs from the installed locked version; refresh the asset or explicitly track its source version.')
      const text = bytes.toString('utf8')
      const notices = [...text.matchAll(/\/\*![\s\S]*?\*\//g)].map((match) => match[0]).filter((notice) => /@license|copyright|licensed under|released under/i.test(notice))
      assert(notices.length, 'No preserved embedded notice blocks found in public/mermaid.min.js')
      assert(/DOMPurify 3\.4\.12\b/.test(notices.join('\n')), 'The Mermaid embedded DOMPurify version changed; update its source notice and collector metadata.')
      record.notices.push({ source: 'public/mermaid.min.js', kind: 'Preserved embedded license comment blocks', sha256: sha256(bytes), text: notices.join('\n\n') })
    }
    staticRecords.push(record)
  } catch (error) { failures.push(`${entry.source}: ${error.message}`) }
}

if (failures.length) {
  console.error(`Cannot collect notices; ${failures.length} source(s) need attention:\n${failures.sort(compare).map((failure) => `- ${failure}`).join('\n')}`)
  console.error('No manifest was written. Restore actual upstream notices or record an explicit upstream README license section; SPDX metadata alone is not substituted for license text.')
  process.exitCode = 1
} else {
  const divider = '='.repeat(78)
  function renderRecord(record) {
    const copyrights = [...new Set(record.notices.flatMap((notice) => notice.text.split('\n').filter((line) => /copyright|©|\(c\)/i.test(line)).map((line) => line.trim())))].sort(compare)
    return `${divider}\n${record.name}@${record.version}\nDeclared license: ${record.license}\nInventory source: ${record.source}\nAuthor: ${record.author}\nRepository/homepage: ${record.repository}\nCopyright lines: ${copyrights.length ? '\n' + copyrights.map((line) => `  ${line}`).join('\n') : 'No separate statement found; see original notices below.'}\n\n` + record.notices.map((notice) => `--- ${notice.kind}: ${notice.source}\nSource SHA-256: ${notice.sha256}\n\n${notice.text}\n`).join('\n')
  }
  const header = `Penlume third-party license and notice inventory\n\nGenerated offline by scripts/collect-licenses.mjs from package-lock.json and installed package files.\nScope: ${records.length} lockfile package locations not marked dev, including nested copies and optional/runtime peers, plus ${staticRecords.length} vendored notice entries.\nThis is a conservative dependency inventory, not an exact analysis of emitted application bytes.\nActual upstream notice text is retained; README-only license sections are explicitly identified.\nBuild-only packages marked dev are excluded. Electron/Chromium, Pandoc and user-configured external tools are outside this collector; retain their separate upstream license resources.\nThis inventory is a source record, not a legal compliance determination.\nNo network requests or timestamps are used. Regenerate after npm ci when dependencies or vendored assets change.\n\n`
  const output = header + records.map(renderRecord).join('\n') + '\nVendored application assets\n\n' + staticRecords.map(renderRecord).join('\n')
  if (checkOnly) assert.equal(normalizeText(await readFile(outputPath, 'utf8')), normalizeText(output), 'THIRD_PARTY_LICENSES.txt is stale; run node scripts/collect-licenses.mjs.')
  else await writeFile(outputPath, output, 'utf8')
  console.log(`${checkOnly ? 'Verified' : 'Collected'} ${records.length} installed package locations and ${staticRecords.length} vendored notice entries; ${portablePath(path.relative(root, outputPath))}`)
  const readmeOnly = records.filter((record) => record.notices.some((notice) => notice.kind.startsWith('Explicit README')))
  if (readmeOnly.length) console.log(`README-only license sections: ${readmeOnly.map((record) => `${record.name}@${record.version} (${record.source})`).join(', ')}`)
}
