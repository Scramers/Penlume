import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  WorkspaceEntry,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
  WorkspaceSnapshot,
} from '../shared/contracts'
import { normalizeFilePath } from './file-service'

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024

export function isSupportedWorkspaceFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const root = normalizeFilePath(rootPath)
  const candidate = normalizeFilePath(candidatePath)
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export async function resolveAuthorizedWorkspaceFile(
  rootPath: string,
  candidatePath: string,
): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([
    realpath(rootPath),
    realpath(candidatePath),
  ])
  if (!isPathInsideRoot(realRoot, realCandidate) || !isSupportedWorkspaceFile(realCandidate)) {
    throw new Error('文件不在当前工作区内或类型不受支持。')
  }
  if (!(await stat(realCandidate)).isFile()) throw new Error('目标不是普通文件。')
  return normalizeFilePath(realCandidate)
}

export async function readWorkspaceSnapshot(
  inputRootPath: string,
  maximumEntries = 5_000,
): Promise<WorkspaceSnapshot> {
  const rootPath = normalizeFilePath(inputRootPath)
  let entryCount = 0
  let truncated = false

  async function visit(directoryPath: string, depth: number): Promise<WorkspaceEntry[]> {
    if (depth > 16 || entryCount >= maximumEntries) {
      truncated = true
      return []
    }

    const directoryEntries = await readdir(directoryPath, { withFileTypes: true })
    const result: WorkspaceEntry[] = []

    for (const entry of directoryEntries) {
      if (entryCount >= maximumEntries) {
        truncated = true
        break
      }
      if (entry.name.startsWith('.') || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) {
        continue
      }

      const entryPath = path.join(directoryPath, entry.name)
      if (entry.isDirectory()) {
        const children = await visit(entryPath, depth + 1)
        {
          entryCount += 1
          result.push({ name: entry.name, path: entryPath, type: 'directory', children })
        }
      } else if (entry.isFile() && isSupportedWorkspaceFile(entryPath)) {
        entryCount += 1
        result.push({ name: entry.name, path: entryPath, type: 'file' })
      }
    }

    return result.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  }

  return {
    rootPath,
    displayName: path.basename(rootPath),
    entries: await visit(rootPath, 0),
    truncated,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectFiles(entries: WorkspaceEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.type === 'file' ? [entry.path] : collectFiles(entry.children ?? []),
  )
}

function createSearchExpression(request: WorkspaceSearchRequest): RegExp | null {
  if (!request.query) return null
  const source = request.regexp ? request.query : escapeRegExp(request.query)
  const bounded = request.wholeWord
    ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
    : source
  return new RegExp(bounded, request.caseSensitive ? 'gu' : 'giu')
}

export async function searchWorkspace(
  rootPath: string,
  request: WorkspaceSearchRequest,
  maximumMatches = 500,
): Promise<WorkspaceSearchResult> {
  const snapshot = await readWorkspaceSnapshot(rootPath)
  const expression = createSearchExpression(request)
  if (!expression) return { matches: [], scannedFiles: 0, truncated: false }

  const matches: WorkspaceSearchResult['matches'] = []
  const files = collectFiles(snapshot.entries)
  let scannedFiles = 0
  let truncated = snapshot.truncated

  for (const filePath of files) {
    if (matches.length >= maximumMatches) {
      truncated = true
      break
    }
    const metadata = await stat(filePath)
    if (metadata.size > MAX_SEARCH_FILE_BYTES) continue

    const content = await readFile(filePath, 'utf8')
    scannedFiles += 1
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      expression.lastIndex = 0
      const match = expression.exec(lines[index])
      if (!match) continue
      matches.push({
        path: filePath,
        relativePath: path.relative(snapshot.rootPath, filePath),
        line: index + 1,
        column: match.index + 1,
        preview: lines[index].trim().slice(0, 240),
      })
      if (matches.length >= maximumMatches) {
        truncated = true
        break
      }
    }
  }

  return { matches, scannedFiles, truncated }
}
