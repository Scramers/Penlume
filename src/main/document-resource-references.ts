import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createDocumentResourceContext,
  resolveDocumentResourceCandidate,
  type DocumentResourceContext,
  type DocumentResourceResolution,
  type LocalResourceKind,
  type ResourcePathFlavor,
} from './document-resources'

type LocalResolution = Extract<DocumentResourceResolution, { kind: 'local' }>

export type DocumentResourceReferenceIssue =
  | 'target-not-absolute' | 'invalid-target-path' | 'invalid-target-encoding'
  | 'invalid-original-reference' | 'unsupported-original-reference'
  | 'external-original-reference' | 'unrepresentable-target'

export type DocumentResourceReferenceResult =
  | {
    readonly kind: 'reference'
    readonly reference: string
    readonly normalizedTargetPath: string
    readonly originalReference: string | null
    readonly suffix: string
    readonly requestedStyle: LocalResourceKind | null
    readonly usedFallback: boolean
    /** Lexical location only. The caller must independently authorize and realpath it. */
    readonly resolution: LocalResolution
  }
  | {
    readonly kind: 'invalid' | 'unsupported'
    readonly reason: DocumentResourceReferenceIssue
    readonly originalReference: string | null
  }

interface Target {
  readonly value: string
  readonly flavor: ResourcePathFlavor
}

function pathApi(flavor: ResourcePathFlavor): typeof path.posix {
  return flavor === 'win32' ? path.win32 : path.posix
}

function normalized(value: string, flavor: ResourcePathFlavor): string {
  // Inputs here are already absolute; resolve cannot consult a working directory.
  const result = pathApi(flavor).resolve(value)
  if (flavor === 'posix') return result
  // Drive letters and URI hostnames are syntax case conventions. Keep share,
  // directory and filename case exact: Windows can have case-sensitive folders.
  return result.replace(/^[a-z]:/i, (drive) => drive.toUpperCase())
    .replace(/^\\\\([^\\]+)\\/, (_, host: string) => `\\\\${host.toLowerCase()}\\`)
}

function matches(result: DocumentResourceResolution, target: Target): result is LocalResolution {
  return result.kind === 'local' && result.pathFlavor === target.flavor
    && normalized(result.candidatePath, result.pathFlavor) === normalized(target.value, target.flavor)
}

function encodeSegment(value: string): string {
  // No entity/Markdown unescaping or URI decoding: this is a native path segment.
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function encodePath(value: string, flavor: ResourcePathFlavor): string {
  return value.split(flavor === 'win32' ? /[/\\]/ : '/').map(encodeSegment).join('/')
}

function relativeReference(base: string, flavor: ResourcePathFlavor, target: Target, keepDot = false): string | null {
  if (flavor !== target.flavor) return null
  const relative = pathApi(flavor).relative(base, target.value)
  // win32.relative returns an absolute path for different drives/UNC shares.
  if (pathApi(flavor).isAbsolute(relative)) return null
  const encoded = encodePath(relative, flavor)
  if (!relative) return keepDot ? './' : '.'
  // The locator classifies after URI decoding. Merely encoding a first-segment
  // ':' or leading POSIX filename backslash would still resemble a scheme/root.
  const ambiguous = /^[a-z][a-z\d+.-]*:/i.test(relative) || relative.startsWith('\\')
  return keepDot || ambiguous ? `./${encoded}` : encoded
}

function effectiveBase(context: DocumentResourceContext): { value: string; flavor: ResourcePathFlavor } | null {
  if (context.root.status === 'local') return { value: context.root.candidatePath, flavor: context.root.pathFlavor }
  if (context.root.status === 'unsupported' || !context.documentDirectory) return null
  return { value: context.documentDirectory, flavor: context.pathFlavor }
}

function fileReference(target: Target): string | null {
  // Node's platform option prevents the host platform from reinterpreting a
  // foreign native path. Encode remaining Markdown-significant URI characters.
  try {
    const host = target.flavor === 'win32' && target.value.match(/^\\\\([^\\]+)\\/)?.[1]
    // Validate a native UNC host before handing it to Node's native binding.
    // Some Node versions assert rather than throw for unrepresentable hosts
    // such as a literal '%'. This check never interprets the target as a URI.
    if (host) new URL(`file://${encodeSegment(host)}/`)
    return pathToFileURL(target.value, { windows: target.flavor === 'win32' }).href
      .replace(/[!'()*&]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  } catch {
    return null
  }
}

function absoluteDriveReference(target: Target): string | null {
  const match = target.flavor === 'win32' && target.value.match(/^([a-z]:)[/\\](.*)$/i)
  return match ? `${match[1]}/${encodePath(match[2], 'win32')}` : null
}

function absoluteUncReference(target: Target): string | null {
  const match = target.flavor === 'win32' && target.value.match(/^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/)
  return match ? `//${encodeSegment(match[1])}/${encodeSegment(match[2])}${match[3] ? `/${encodePath(match[3], 'win32')}` : ''}` : null
}

function slashReference(context: DocumentResourceContext, target: Target, nativeBackslash: boolean): string | null {
  if (!nativeBackslash && context.root.status === 'local') {
    const relative = relativeReference(context.root.candidatePath, context.root.pathFlavor, target)
    return relative === null ? null : relative === '.' ? '/' : `/${relative}`
  }
  if (!nativeBackslash && context.root.status === 'unsupported') return null
  if (!nativeBackslash && target.flavor === 'posix' && context.pathFlavor === 'posix') return encodePath(target.value, 'posix')
  if (target.flavor !== 'win32' || context.pathFlavor !== 'win32' || !context.documentPath) return null
  const volume = path.win32.parse(context.documentPath).root
  const relative = relativeReference(volume, 'win32', target)
  if (relative === null) return null
  const prefix = nativeBackslash ? '%5C' : '/'
  return relative === '.' ? prefix : `${prefix}${relative}`
}

function preferredReference(context: DocumentResourceContext, target: Target, original: LocalResolution | null): string | null {
  if (!original) {
    const base = effectiveBase(context)
    return base ? relativeReference(base.value, base.flavor, target) : null
  }
  switch (original.sourceKind) {
    case 'file-url': return fileReference(target)
    case 'drive-path': return absoluteDriveReference(target)
    case 'unc-path': return absoluteUncReference(target)
    case 'slash-path': return slashReference(context, target, original.decodedPath.startsWith('\\'))
    case 'relative-path': {
      const base = effectiveBase(context)
      return base ? relativeReference(base.value, base.flavor, target, original.decodedPath.startsWith('./')) : null
    }
  }
}

/**
 * Format a native absolute target as a parsed Markdown/HTML resource reference.
 * A valid local metadata root supplies the preferred base; invalid roots retain
 * the document-directory fallback, while unsupported roots use explicit file
 * URLs. Relative '..' is allowed and never grants access outside that base.
 * Every success is re-located in the SAME context. This proves only lexical
 * roundtrip identity, not file existence, authorization, symlink or alias identity.
 */
export function createDocumentResourceReference(
  context: DocumentResourceContext,
  absoluteTargetPath: string,
  originalReference?: string,
): DocumentResourceReferenceResult {
  const failure = (kind: 'invalid' | 'unsupported', reason: DocumentResourceReferenceIssue): DocumentResourceReferenceResult => ({
    kind, reason, originalReference: originalReference ?? null,
  })
  if (!path.posix.isAbsolute(absoluteTargetPath) && !path.win32.isAbsolute(absoluteTargetPath)) return failure('invalid', 'target-not-absolute')
  // Reuse native document-path validation, which deliberately does not URI-decode
  // or split query/hash. '%' and POSIX '?/#' are literal target filename bytes.
  const targetContext = createDocumentResourceContext(absoluteTargetPath, '')
  if (!targetContext.documentPath) return failure('invalid', 'invalid-target-path')
  const target: Target = { value: pathApi(targetContext.pathFlavor).resolve(targetContext.documentPath), flavor: targetContext.pathFlavor }
  try { encodeURIComponent(target.value) } catch { return failure('invalid', 'invalid-target-encoding') }

  let original: LocalResolution | null = null
  let suffix = ''
  if (originalReference !== undefined) {
    // For an unsupported root only, classify the original syntax with no base
    // override. This never produces a result or a grant: final verification still
    // uses the unchanged real context, and root-dependent styles fall back below.
    const classificationContext: DocumentResourceContext = context.root.status === 'unsupported'
      ? { ...context, root: { status: 'absent', original: null } } : context
    const classified = resolveDocumentResourceCandidate(classificationContext, originalReference)
    suffix = classified.suffix
    if (classified.kind === 'external') return failure('unsupported', 'external-original-reference')
    if (classified.kind === 'invalid') return failure('invalid', 'invalid-original-reference')
    if (classified.kind === 'unsupported' && classified.reason !== 'missing-document-path' && classified.reason !== 'missing-windows-volume') {
      return failure('unsupported', 'unsupported-original-reference')
    }
    if (classified.kind === 'local') original = classified
  }

  const success = (reference: string, usedFallback: boolean): DocumentResourceReferenceResult | null => {
    const resolution = resolveDocumentResourceCandidate(context, reference)
    return matches(resolution, target) ? {
      kind: 'reference', reference, normalizedTargetPath: target.value,
      originalReference: originalReference ?? null, suffix,
      requestedStyle: original?.sourceKind ?? null, usedFallback, resolution,
    } : null
  }
  // Keeping an already-correct reference preserves its exact encoding, separator
  // spelling and suffix. A classification-context result alone cannot justify it.
  if (originalReference !== undefined && original && matches(original, target)) {
    const unchanged = success(originalReference, false)
    if (unchanged) return unchanged
  }
  const preferred = preferredReference(context, target, original)
  if (preferred !== null) {
    const result = success(preferred + suffix, false)
    if (result) return result
  }
  const file = fileReference(target)
  const fallback = file === null ? null : success(file + suffix, true)
  return fallback ?? failure('unsupported', 'unrepresentable-target')
}
