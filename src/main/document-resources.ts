import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { splitFrontMatter } from '../shared/markdown-extensions'

export type ResourcePathFlavor = 'win32' | 'posix'
export type LocalResourceKind = 'file-url' | 'drive-path' | 'unc-path' | 'slash-path' | 'relative-path'
export type ResourceIssue =
  | 'invalid-front-matter' | 'non-string-root' | 'empty-path' | 'invalid-encoding'
  | 'invalid-path' | 'invalid-file-url' | 'unsupported-scheme' | 'unsupported-template'
  | 'unsupported-remote-root' | 'unsupported-root-suffix' | 'drive-relative-path'
  | 'device-path' | 'incomplete-unc-path' | 'missing-document-path' | 'missing-windows-volume'

export type DocumentResourceRoot =
  | { readonly status: 'absent'; readonly original: null }
  | { readonly status: 'invalid' | 'unsupported'; readonly original: string | null; readonly reason: ResourceIssue }
  | { readonly status: 'local'; readonly original: string; readonly candidatePath: string; readonly pathFlavor: ResourcePathFlavor; readonly sourceKind: LocalResourceKind }

export interface DocumentResourceContext {
  readonly documentPath: string | null
  readonly documentDirectory: string | null
  readonly pathFlavor: ResourcePathFlavor
  readonly root: DocumentResourceRoot
}

interface ReferenceParts {
  readonly originalReference: string
  /** URI pathname before decoding; supplied references are already parsed Markdown/HTML values. */
  readonly pathPart: string
  /** Exact suffix, including otherwise invisible trailing '?' or '#'. */
  readonly suffix: string
  readonly root: DocumentResourceRoot
}

export type DocumentResourceResolution = ReferenceParts & (
  | { readonly kind: 'external'; readonly sourceKind: 'http' | 'https' | 'data' | 'blob'; readonly url: string }
  | { readonly kind: 'local'; readonly sourceKind: LocalResourceKind; readonly decodedPath: string; readonly candidatePath: string; readonly pathFlavor: ResourcePathFlavor; readonly basis: 'absolute' | 'document-directory' | 'typora-root-url' }
  | { readonly kind: 'invalid' | 'unsupported'; readonly reason: ResourceIssue }
)

type LocalCandidate =
  | { kind: 'local'; sourceKind: LocalResourceKind; candidatePath: string; pathFlavor: ResourcePathFlavor; basis: 'absolute' | 'document-directory' }
  | { kind: 'invalid' | 'unsupported'; reason: ResourceIssue }

const driveAbsolute = /^[a-z]:[/\\]/i
const drivePrefix = /^[a-z]:/i
const scheme = /^[a-z][a-z\d+.-]*:/i
const controls = /[\u0000-\u001f\u007f]/
const template = /\$\{[^}]*\}/

function pathApi(flavor: ResourcePathFlavor): typeof path.posix {
  return flavor === 'win32' ? path.win32 : path.posix
}

function splitSuffix(reference: string): { pathPart: string; suffix: string } {
  const index = reference.search(/[?#]/)
  return index < 0 ? { pathPart: reference, suffix: '' } : { pathPart: reference.slice(0, index), suffix: reference.slice(index) }
}

function windowsPathIssue(value: string): ResourceIssue | null {
  // Device namespaces and alternate data streams need separate access policies.
  if (/^(?:\\\\|\/\/)[?.][/\\]/.test(value)) return 'device-path'
  const withoutDrive = driveAbsolute.test(value) ? value.slice(2) : value
  return /[<>:"|?*]/.test(withoutDrive) ? 'invalid-path' : null
}

/** Lexical location only: '..' may leave this base and is not an access grant. */
function localCandidate(value: string, context: Pick<DocumentResourceContext, 'documentPath' | 'documentDirectory' | 'pathFlavor'>): LocalCandidate {
  if (!value) return { kind: 'invalid', reason: 'empty-path' }
  if (controls.test(value)) return { kind: 'invalid', reason: 'invalid-path' }
  if (/^(?:\\\\|\/\/)[?.][/\\]/.test(value)) return { kind: 'unsupported', reason: 'device-path' }
  if (driveAbsolute.test(value)) {
    const issue = windowsPathIssue(value)
    return issue ? { kind: 'invalid', reason: issue } : { kind: 'local', sourceKind: 'drive-path', candidatePath: path.win32.normalize(value), pathFlavor: 'win32', basis: 'absolute' }
  }
  if (drivePrefix.test(value)) return { kind: 'unsupported', reason: 'drive-relative-path' }
  if (/^(?:\\\\|\/\/)/.test(value)) {
    if (!/^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+(?:[/\\]|$)/.test(value)) return { kind: 'unsupported', reason: 'incomplete-unc-path' }
    const issue = windowsPathIssue(value)
    return issue ? { kind: 'invalid', reason: issue } : { kind: 'local', sourceKind: 'unc-path', candidatePath: path.win32.normalize(value), pathFlavor: 'win32', basis: 'absolute' }
  }
  if (scheme.test(value)) return { kind: 'unsupported', reason: 'unsupported-scheme' }
  if (context.pathFlavor === 'win32') {
    const issue = windowsPathIssue(value)
    if (issue) return { kind: 'invalid', reason: issue }
  }
  if (/^[/\\]/.test(value)) {
    if (context.pathFlavor === 'posix' && value.startsWith('/')) return { kind: 'local', sourceKind: 'slash-path', candidatePath: path.posix.normalize(value), pathFlavor: 'posix', basis: 'absolute' }
    const volume = context.documentPath && context.pathFlavor === 'win32' ? path.win32.parse(context.documentPath).root : ''
    if (!volume) return { kind: 'unsupported', reason: 'missing-windows-volume' }
    return { kind: 'local', sourceKind: 'slash-path', candidatePath: path.win32.resolve(volume, value), pathFlavor: 'win32', basis: 'absolute' }
  }
  if (!context.documentDirectory) return { kind: 'unsupported', reason: 'missing-document-path' }
  return { kind: 'local', sourceKind: 'relative-path', candidatePath: pathApi(context.pathFlavor).resolve(context.documentDirectory, value), pathFlavor: context.pathFlavor, basis: 'document-directory' }
}

function fileCandidate(reference: string, flavor: ResourcePathFlavor): LocalCandidate {
  try {
    const url = new URL(reference)
    if (url.protocol !== 'file:' || url.username || url.password || url.port) return { kind: 'invalid', reason: 'invalid-file-url' }
    // Explicit drives and file://server/share identify Windows paths even when
    // inspecting a document from a different platform. Other file URLs retain
    // the document platform's fileURLToPath semantics (no guessed Windows drive).
    const windows = !!url.hostname && url.hostname !== 'localhost' || /^\/[a-z]:[/\\]/i.test(decodeURIComponent(url.pathname))
    const pathFlavor = windows ? 'win32' : flavor
    const value = fileURLToPath(url, { windows: pathFlavor === 'win32' })
    const located = localCandidate(value, { documentPath: null, documentDirectory: null, pathFlavor })
    return located.kind === 'local' ? { ...located, sourceKind: 'file-url' } : located
  } catch {
    return { kind: 'invalid', reason: 'invalid-file-url' }
  }
}

function readRoot(markdown: string, context: Omit<DocumentResourceContext, 'root'>): DocumentResourceRoot {
  const { frontMatter } = splitFrontMatter(markdown)
  if (!frontMatter) return /^---(?:\r?\n|$)/.test(markdown) ? { status: 'invalid', original: null, reason: 'invalid-front-matter' } : { status: 'absent', original: null }
  let value: unknown
  try {
    const yaml = parseDocument(frontMatter.replace(/^---\r?\n/, '').replace(/(?:---|\.\.\.)\s*$/, ''), { strict: true, uniqueKeys: true })
    if (yaml.errors.length || yaml.warnings.length) return { status: 'invalid', original: null, reason: 'invalid-front-matter' }
    value = yaml.toJS({ maxAliasCount: 20 })
  } catch {
    return { status: 'invalid', original: null, reason: 'invalid-front-matter' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid', original: null, reason: 'invalid-front-matter' }
  if (!Object.hasOwn(value, 'typora-root-url')) return { status: 'absent', original: null }
  const original = (value as Record<string, unknown>)['typora-root-url']
  if (typeof original !== 'string') return { status: 'invalid', original: null, reason: 'non-string-root' }
  if (!original.trim()) return { status: 'invalid', original, reason: 'empty-path' }
  if (template.test(original)) return { status: 'unsupported', original, reason: 'unsupported-template' }
  if (/^(?:https?|data|blob):/i.test(original)) return { status: 'unsupported', original, reason: 'unsupported-remote-root' }
  const { pathPart, suffix } = splitSuffix(original)
  if (suffix) return { status: 'unsupported', original, reason: 'unsupported-root-suffix' }
  let decoded: string
  try { decoded = decodeURIComponent(pathPart) } catch { return { status: 'invalid', original, reason: 'invalid-encoding' } }
  if (template.test(decoded)) return { status: 'unsupported', original, reason: 'unsupported-template' }
  const candidate = /^file:/i.test(pathPart) ? fileCandidate(pathPart, context.pathFlavor) : localCandidate(decoded, context)
  return candidate.kind === 'local'
    ? { status: 'local', original, candidatePath: candidate.candidatePath, pathFlavor: candidate.pathFlavor, sourceKind: candidate.sourceKind }
    : { status: candidate.kind, original, reason: candidate.reason }
}

/**
 * Parse once per document snapshot. Only a valid leading YAML mapping with a
 * string typora-root-url supplies a base. This base never authorizes file access.
 * The caller must retain its own realpath, symlink, containment and file checks.
 */
export function createDocumentResourceContext(documentPath: string | null, markdown: string, pathFlavor?: ResourcePathFlavor): DocumentResourceContext {
  const inferredFlavor = documentPath && (drivePrefix.test(documentPath) || /^\\\\/.test(documentPath)) ? 'win32' : documentPath?.startsWith('/') ? 'posix' : process.platform === 'win32' ? 'win32' : 'posix'
  const flavor = pathFlavor ?? inferredFlavor
  // Never resolve a relative document path against the process working directory.
  const located = documentPath ? localCandidate(documentPath, { documentPath: null, documentDirectory: null, pathFlavor: flavor }) : null
  const normalized = located?.kind === 'local' && located.basis === 'absolute' ? located.candidatePath : null
  const documentFlavor = located?.kind === 'local' ? located.pathFlavor : flavor
  const context = { documentPath: normalized, documentDirectory: normalized ? pathApi(documentFlavor).dirname(normalized) : null, pathFlavor: documentFlavor }
  return { ...context, root: readRoot(markdown, context) }
}

/**
 * Locate a parsed reference without opening it or rewriting Markdown. No HTML
 * entity / Markdown escape pass is repeated here. URI decoding happens once,
 * after splitting the original query/fragment, so encoded '#' stays a filename.
 */
export function resolveDocumentResourceCandidate(context: DocumentResourceContext, originalReference: string): DocumentResourceResolution {
  const external = originalReference.match(/^(https?|data|blob):/i)?.[1].toLowerCase() as 'http' | 'https' | 'data' | 'blob' | undefined
  if (external) return { kind: 'external', sourceKind: external, url: originalReference, originalReference, pathPart: originalReference, suffix: '', root: context.root }
  const parts = { originalReference, ...splitSuffix(originalReference), root: context.root }
  if (/^file:/i.test(parts.pathPart)) {
    const candidate = fileCandidate(parts.pathPart, context.pathFlavor)
    return candidate.kind === 'local' ? { ...parts, ...candidate, decodedPath: candidate.candidatePath } : { ...parts, ...candidate }
  }
  let decodedPath: string
  try { decodedPath = decodeURIComponent(parts.pathPart) } catch { return { ...parts, kind: 'invalid', reason: 'invalid-encoding' } }
  if (!decodedPath || controls.test(decodedPath)) return { ...parts, kind: 'invalid', reason: decodedPath ? 'invalid-path' : 'empty-path' }
  const candidate = localCandidate(decodedPath, context)
  // Explicit file/drive/UNC paths do not use metadata. A single slash is the
  // documented Typora prefix example; relative paths use YAML's "base path"
  // description as the same local base. A Windows backslash-rooted path is native.
  const usesRoot = !drivePrefix.test(decodedPath) && !scheme.test(decodedPath) && !/^\\/.test(decodedPath) && !/^\/\//.test(decodedPath)
  if (usesRoot && context.root.status === 'unsupported') return { ...parts, kind: 'unsupported', reason: context.root.reason }
  if (usesRoot && context.root.status === 'local') {
    const root = context.root
    const relative = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath
    const located = localCandidate(relative || '.', { documentPath: null, documentDirectory: root.candidatePath, pathFlavor: root.pathFlavor })
    return located.kind === 'local' ? { ...parts, ...located, sourceKind: decodedPath.startsWith('/') ? 'slash-path' : 'relative-path', decodedPath, basis: 'typora-root-url' } : { ...parts, ...located }
  }
  return candidate.kind === 'local' ? { ...parts, ...candidate, decodedPath } : { ...parts, ...candidate }
}
