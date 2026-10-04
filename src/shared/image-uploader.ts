import { z } from 'zod'
import { imageLibraryVersionSchema, type ImageLibraryVersion } from './image-library'

const argumentsSchema = z.array(z.string().max(4096).refine((value) => !/[\u0000\r\n]/.test(value), '参数不能包含空字符或换行。')).min(1).max(32)
export const imageUploaderSettingsSchema = z.object({
  executablePath: z.string().min(1).max(32768).nullable().default(null),
  adapter: z.enum(['picgo', 'piclist', 'custom']).default('picgo'),
  args: argumentsSchema.default(['upload', '{file}']),
  timeoutSeconds: z.number().int().min(5).max(300).default(90),
}).refine((settings) => settings.args.some((argument) => argument.includes('{file}')), '参数数组必须包含 {file} 占位符。')
export type ImageUploaderSettings = z.infer<typeof imageUploaderSettingsSchema>
export const imageUploaderConfigurationSchema = z.object({ adapter: z.enum(['picgo', 'piclist', 'custom']), args: argumentsSchema, timeoutSeconds: z.number().int().min(5).max(300) }).refine((value) => value.args.some((argument) => argument.includes('{file}')), '参数数组必须包含 {file} 占位符。')
export type ImageUploaderConfiguration = z.infer<typeof imageUploaderConfigurationSchema>
export const imageUploadRequestSchema = z.object({ documentPath: z.string().min(1).max(32768), markdown: z.string().max(20 * 1024 * 1024), images: z.array(z.object({ imageId: z.string().min(1).max(128), expectedVersion: imageLibraryVersionSchema })).min(1).max(100) })
export type ImageUploadRequest = z.infer<typeof imageUploadRequestSchema>
export const applyImageUploadsSchema = z.object({ documentPath: z.string().min(1).max(32768), markdown: z.string().max(20 * 1024 * 1024), taskId: z.string().uuid(), selectedItemIds: z.array(z.string().min(1).max(128)).min(1).max(100), allowChangedOriginals: z.array(z.string().min(1).max(128)).max(100).default([]) })
export type ApplyImageUploadsRequest = z.infer<typeof applyImageUploadsSchema>
export interface ImageUploadItem {
  id: string; imageId: string; name: string; sourcePath: string; sourceUrls: string[]; version: ImageLibraryVersion
  status: 'queued' | 'freezing' | 'uploading' | 'success' | 'failed' | 'cancelled'
  url: string | null; error: string | null; sourceChanged: boolean
}
export interface ImageUploadTask { id: string; documentPath: string; status: 'running' | 'complete' | 'cancelled'; createdAt: string; items: ImageUploadItem[] }
export interface ImageUploadProgress { task: ImageUploadTask; completed: number; total: number; message: string }
export interface ApplyImageUploadsResult { markdown: string; appliedImages: number; replacedReferences: number; notice: string }
export function buildImageUploaderArguments(settings: ImageUploaderSettings, frozenPath: string): string[] {
  const parsed = imageUploaderSettingsSchema.parse(settings)
  return parsed.args.map((argument) => argument.replaceAll('{file}', frozenPath))
}
