import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import type {
  DocumentSnapshot,
  FileVersionToken,
  SaveDocumentRequest,
  SaveDocumentResult,
  TextFormat,
} from '../shared/contracts'
import { decodeUtf8, encodeUtf8 } from '../shared/text-format'

export function normalizeFilePath(filePath: string): string {
  if (filePath.includes('\0')) {
    throw new Error('文件路径包含非法空字符。')
  }
  return path.resolve(filePath)
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readDocumentSnapshot(
  inputPath: string,
): Promise<DocumentSnapshot> {
  const filePath = normalizeFilePath(inputPath)
  const bytes = await readFile(filePath)
  const decoded = decodeUtf8(bytes)
  const fileStat = await stat(filePath)

  if (!fileStat.isFile()) {
    throw new Error('目标不是普通文件。')
  }

  return {
    path: filePath,
    displayName: path.basename(filePath),
    markdown: decoded.text,
    format: decoded.format,
    version: {
      path: filePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha256: hashBytes(bytes),
    },
  }
}

export async function tryReadDocumentSnapshot(
  inputPath: string,
): Promise<DocumentSnapshot | null> {
  try {
    return await readDocumentSnapshot(inputPath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null
    }
    throw error
  }
}

export function versionsMatch(
  current: FileVersionToken | null,
  expected: FileVersionToken | null,
): boolean {
  if (current === null || expected === null) {
    return current === expected
  }

  return (
    normalizeFilePath(current.path) === normalizeFilePath(expected.path) &&
    current.sha256 === expected.sha256
  )
}

async function writeTemporaryFile(
  targetPath: string,
  markdown: string,
  format: TextFormat,
): Promise<string> {
  const directory = path.dirname(targetPath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  const targetStat = await stat(targetPath).catch(() => null)
  const handle = await open(temporaryPath, 'wx', targetStat?.mode ?? 0o600)

  try {
    await handle.writeFile(encodeUtf8(markdown, format))
    await handle.sync()
  } finally {
    await handle.close()
  }

  if (targetStat) {
    await chmod(temporaryPath, targetStat.mode).catch(() => undefined)
  }

  return temporaryPath
}

function errorResult(error: unknown): SaveDocumentResult {
  const message =
    error instanceof Error ? error.message : '保存文件时发生未知错误。'
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'SAVE_FAILED'
  return { status: 'error', code, message }
}

export async function saveDocumentAtomically(
  request: SaveDocumentRequest,
): Promise<SaveDocumentResult> {
  const targetPath = normalizeFilePath(request.path)
  let temporaryPath: string | null = null

  try {
    const beforeWrite = await tryReadDocumentSnapshot(targetPath)
    if (
      !request.force &&
      !versionsMatch(beforeWrite?.version ?? null, request.expectedVersion)
    ) {
      return {
        status: 'conflict',
        snapshot: beforeWrite,
        message: '文件已被其他程序修改或删除。',
      }
    }

    temporaryPath = await writeTemporaryFile(
      targetPath,
      request.markdown,
      request.format,
    )

    const beforeReplace = await tryReadDocumentSnapshot(targetPath)
    if (
      !request.force &&
      !versionsMatch(beforeReplace?.version ?? null, request.expectedVersion)
    ) {
      await unlink(temporaryPath).catch(() => undefined)
      temporaryPath = null
      return {
        status: 'conflict',
        snapshot: beforeReplace,
        message: '保存过程中检测到新的外部修改。',
      }
    }

    await rename(temporaryPath, targetPath)
    temporaryPath = null
    return {
      status: 'saved',
      snapshot: await readDocumentSnapshot(targetPath),
    }
  } catch (error) {
    if (temporaryPath) {
      await unlink(temporaryPath).catch(() => undefined)
    }
    return errorResult(error)
  }
}

