import { z } from 'zod'
import type { InterfaceLanguage } from './localization'

export type MediaKind = 'audio' | 'video'
export const maximumMediaBytes = 100 * 1024 * 1024
export const maximumEmbeddedMediaBytes = 8 * 1024 * 1024
export const maximumEmbeddedMediaTotalBytes = 24 * 1024 * 1024
export const mediaFormats = [
  { extension: '.mp3', kind: 'audio', mimeType: 'audio/mpeg' },
  { extension: '.m4a', kind: 'audio', mimeType: 'audio/mp4' },
  { extension: '.ogg', kind: 'audio', mimeType: 'audio/ogg' },
  { extension: '.wav', kind: 'audio', mimeType: 'audio/wav' },
  { extension: '.flac', kind: 'audio', mimeType: 'audio/flac' },
  { extension: '.mp4', kind: 'video', mimeType: 'video/mp4' },
  { extension: '.webm', kind: 'video', mimeType: 'video/webm' },
  { extension: '.ogv', kind: 'video', mimeType: 'video/ogg' },
  { extension: '.mov', kind: 'video', mimeType: 'video/quicktime' },
] as const
const mimeAliases: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-flac': 'audio/flac', 'audio/x-m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg' }
export function canonicalMediaMime(value: string): string { const mime = value.toLowerCase().split(';', 1)[0].trim(); return mimeAliases[mime] ?? mime }
export function mediaFormat(fileName: string, mimeType = ''): { extension: string; kind: MediaKind; mimeType: string } | undefined {
  const extension = fileName.match(/\.[\w]+$/)?.[0].toLowerCase()
  const mime = canonicalMediaMime(mimeType)
  if (!extension && mime === 'audio/webm') return { extension: '.webm', kind: 'audio', mimeType: mime }
  const format = mediaFormats.find((entry) => entry.extension === extension) ?? mediaFormats.find((entry) => entry.mimeType === mime)
  if (!format) return undefined
  if (format.extension === '.webm' && mime === 'audio/webm') return { ...format, kind: 'audio', mimeType: mime }
  if (format.extension === '.ogg' && mime === 'video/ogg') return { ...format, kind: 'video', mimeType: mime }
  return format
}
export function isSupportedMediaMime(value: string): boolean { const mime = canonicalMediaMime(value); return mime === 'audio/webm' || mediaFormats.some((entry) => entry.mimeType === mime) }

export const mediaAssetRequestSchema = z.object({
  fileName: z.string().min(1).max(255), mimeType: z.string().max(128),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= maximumMediaBytes),
})
export type MediaAssetRequest = z.infer<typeof mediaAssetRequestSchema>
export interface MediaAssetResult { path: string; markdownUrl: string; kind: MediaKind; mimeType: string; size: number }
export interface MediaExportResult { html: string; warnings: string[]; embeddedBytes: number }
export interface MediaExportOptions { mode?: 'embed' | 'preview' | 'print'; locale?: InterfaceLanguage }

/** Validated length without allocating decoded bytes in a renderer or main process. */
export function mediaDataBytes(source: string): number | null {
  const match = source.match(/^data:((?:audio|video)\/[\w.+-]+);base64,/i)
  return match && isSupportedMediaMime(match[1]) ? base64Bytes(source.slice(match[0].length)) : null
}
export function base64Bytes(payload: string): number | null {
  if (!payload || payload.length % 4 || payload.length > Math.ceil(maximumMediaBytes / 3) * 4) return null
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  // Repeated multi-character regexp groups can overflow V8's stack on an 8 MB
  // payload. A single character scan plus an explicit padding check stays linear.
  if (/[^A-Za-z0-9+/]/.test(payload.slice(0, payload.length - padding))) return null
  const bytes = payload.length / 4 * 3 - padding
  return bytes > 0 && bytes <= maximumMediaBytes ? bytes : null
}

export function remoteMediaUrl(source: string): string | null {
  const raw = source.trim(), value = /^\/\//.test(raw) ? `https:${raw}` : raw
  if (!/^https?:/i.test(value)) return null
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null } catch { return null }
}
export function escapeMediaAttribute(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') }
export function mediaReferenceLabel(source: string): string { return /^data:/i.test(source) ? '嵌入的媒体数据' : source.length > 500 ? `${source.slice(0, 497)}…` : source }
/** Typora accepts self-closing media shorthand, although HTML media tags are not void. */
export function normalizeMediaHtml(html: string): string { return html.replace(/<(audio|video)\b((?:"[^"]*"|'[^']*'|[^'">])*)\/\s*>/gi, '<$1$2></$1>') }
export function mediaMarkup(source: string, kind: MediaKind, title = ''): string {
  return `\n\n<${kind} controls preload="none"${kind === 'video' ? ' playsinline' : ''} src="${escapeMediaAttribute(source)}"${title ? ` title="${escapeMediaAttribute(title)}"` : ''}></${kind}>\n\n`
}
