import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const metadata = JSON.parse(await readFile(path.join(root, 'node_modules/mermaid/package.json'), 'utf8'))
assert.equal(metadata.version, '11.17.2', 'Review vendored source and notices when updating Mermaid.')
const bytes = await readFile(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'))
const sha256 = createHash('sha256').update(bytes).digest('hex')
assert.equal(sha256, '581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8', 'Unexpected Mermaid distribution.')
const destination = path.join(root, 'public/mermaid.min.js')
let current
try { current = await readFile(destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (!current?.equals(bytes)) await writeFile(destination, bytes)
console.log('Prepared unchanged Mermaid 11.17.2 bundle; SHA-256 and embedded notices verified.')
