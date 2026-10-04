import { z } from 'zod'
import { pdfOptionsSchema } from './preferences'

export const textFormatSchema = z.object({
  lineEnding: z.enum(['lf', 'crlf']),
  hasBom: z.boolean(),
})

export const fileVersionTokenSchema = z.object({
  path: z.string().min(1),
  size: z.number().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export const saveDocumentRequestSchema = z.object({
  path: z.string().min(1),
  markdown: z.string(),
  format: textFormatSchema,
  expectedVersion: fileVersionTokenSchema.nullable(),
  force: z.boolean().optional(),
})

export const saveDocumentAsRequestSchema = z.object({
  markdown: z.string(),
  format: textFormatSchema,
  suggestedName: z.string().min(1).max(255),
  excludedPaths: z.array(z.string().min(1).max(32768)).max(256).optional(),
})

export const recoveryDraftSchema = z.object({
  id: z.string().min(1).max(128),
  sourcePath: z.string().min(1).nullable(),
  displayName: z.string().min(1).max(255),
  markdown: z.string(),
  format: textFormatSchema,
  expectedVersion: fileVersionTokenSchema.nullable(),
  updatedAt: z.iso.datetime(),
  schemaVersion: z.literal(1),
})

export const windowDocumentStatusSchema = z.object({
  dirty: z.boolean(),
  draftId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(255),
  documents: z.array(z.object({ dirty: z.boolean(), draftId: z.string().min(1).max(128), displayName: z.string().min(1).max(255) })).max(256).optional(),
})

export const workspaceDocumentPathSchema = z.string().min(1).max(32_768)

export const resourceDocumentSnapshotSchema = z.object({
  documentPath: workspaceDocumentPathSchema,
  markdown: z.string().max(20 * 1024 * 1024),
}).strict()

export const workspaceSearchRequestSchema = z.object({
  query: z.string().max(256),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  regexp: z.boolean(),
})

export const imageAssetRequestSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().max(128),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 25 * 1024 * 1024),
})

export const exportDocumentRequestSchema = z.object({
  html: z.string().max(20 * 1024 * 1024),
  markdown: z.string().max(20 * 1024 * 1024),
  sourcePath: z.string().min(1).max(32_768).nullable(),
  suggestedName: z.string().min(1).max(255),
  pdf: pdfOptionsSchema.optional(),
})

export const workspaceMutationSchema = z.object({
  action: z.enum(['create-file', 'create-directory', 'rename', 'delete', 'restore']),
  path: z.string().min(1).max(32768).optional(),
  target: z.string().min(1).max(32768).optional(),
})
