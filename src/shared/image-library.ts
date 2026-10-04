import { z } from 'zod'

export const imageLibraryVersionSchema = z.object({
  path: z.string().min(1).max(32_768),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type ImageLibraryVersion = z.infer<typeof imageLibraryVersionSchema>

export const imageLibraryDocumentSchema = z.object({ path: z.string().min(1).max(32_768), markdown: z.string().max(20 * 1024 * 1024) })
export const imageLibraryRequestSchema = z.object({
  documentPath: z.string().min(1).max(32_768),
  markdown: z.string().max(20 * 1024 * 1024),
  relatedDocuments: z.array(imageLibraryDocumentSchema).max(256).optional(),
})
export type ImageLibraryRequest = z.infer<typeof imageLibraryRequestSchema>
export type ImageLibraryDocument = z.infer<typeof imageLibraryDocumentSchema>

export const imageLibraryMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('copy'), imageId: z.string().min(1).max(128), expectedVersion: imageLibraryVersionSchema }),
  z.object({ action: z.literal('rename'), imageId: z.string().min(1).max(128), expectedVersion: imageLibraryVersionSchema, name: z.string().min(1).max(255) }),
  z.object({ action: z.literal('remove-reference'), imageId: z.string().min(1).max(128) }),
  z.object({ action: z.literal('quarantine'), path: z.string().min(1).max(32_768), expectedVersion: imageLibraryVersionSchema }),
  z.object({ action: z.literal('restore'), recoveryId: z.string().regex(/^[a-f0-9-]{36}$/) }),
])
export type ImageLibraryMutation = z.infer<typeof imageLibraryMutationSchema>
export const imageLibraryMutationRequestSchema = imageLibraryRequestSchema.extend({ mutation: imageLibraryMutationSchema })

export interface ImageLibraryItem {
  id: string
  name: string
  urls: string[]
  path: string | null
  status: 'local' | 'remote' | 'embedded' | 'missing' | 'blocked'
  references: number
  size: number | null
  version: ImageLibraryVersion | null
  previewUrl: string | null
  inAssets: boolean
  message: string | null
}
export interface ImageLibraryOrphan {
  path: string
  name: string
  size: number
  version: ImageLibraryVersion
  previewUrl: string
}
export interface ImageLibraryRecovery {
  id: string
  name: string
  size: number
  removedAt: string
}
export interface ImageLibrarySnapshot {
  documentPath: string
  assetDirectory: string
  items: ImageLibraryItem[]
  orphans: ImageLibraryOrphan[]
  recovery: ImageLibraryRecovery[]
  scanComplete: boolean
  scannedDocuments: number
  warnings: string[]
}
export interface ImageLibraryMutationResult {
  markdown: string
  snapshot: ImageLibrarySnapshot
  notice: string
}
