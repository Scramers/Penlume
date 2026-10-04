import { z } from 'zod'
import type { DocumentSnapshot } from './contracts'
import { markdownExtensionsSchema } from './preferences'

export const pandocFormats = [
  { id: 'docx', label: 'Word 文档', extension: 'docx', detail: '标题、表格、脚注与图片' },
  { id: 'odt', label: 'OpenDocument', extension: 'odt', detail: '开放文档格式' },
  { id: 'epub3', label: 'EPUB 电子书', extension: 'epub', detail: '目录与章节导航' },
  { id: 'rtf', label: 'RTF 文档', extension: 'rtf', detail: '通用文字处理格式' },
  { id: 'latex', label: 'LaTeX 源码', extension: 'tex', detail: '排版与公式源码' },
  { id: 'html5', label: 'HTML 文档', extension: 'html', detail: '独立网页文档' },
  { id: 'rst', label: 'reStructuredText', extension: 'rst', detail: '技术文档与 Sphinx' },
  { id: 'org', label: 'Org 文档', extension: 'org', detail: '结构化笔记' },
  { id: 'plain', label: '纯文本', extension: 'txt', detail: '正文与基础结构' },
  { id: 'gfm', label: 'GitHub Markdown', extension: 'md', detail: '转换 Markdown 方言' },
] as const
export type PandocFormat = typeof pandocFormats[number]['id']
export const pandocImportFormats: Record<string, string> = { docx: 'docx', odt: 'odt', epub: 'epub', html: 'html', htm: 'html', tex: 'latex', rst: 'rst', org: 'org', rtf: 'rtf', txt: 'markdown', md: 'markdown', markdown: 'markdown' }
export const pandocOptionsSchema = z.object({
  toc: z.boolean().default(false),
  numberedSections: z.boolean().default(false),
  standalone: z.boolean().default(true),
  extraArgs: z.array(z.string().min(1).max(1000)).max(24).default([]),
  useReferenceDocument: z.boolean().default(false),
})
export type PandocOptions = z.infer<typeof pandocOptionsSchema>
export const pandocExportSchema = z.object({
  markdown: z.string().max(20 * 1024 * 1024),
  sourcePath: z.string().min(1).max(32768).nullable(),
  suggestedName: z.string().min(1).max(255),
  format: z.enum(pandocFormats.map((format) => format.id)),
  options: pandocOptionsSchema.default(() => pandocOptionsSchema.parse({})),
  excludedPaths: z.array(z.string().min(1).max(32768)).max(256).default([]),
  extensions: markdownExtensionsSchema.default(() => markdownExtensionsSchema.parse({})),
})
export type PandocExportRequest = z.infer<typeof pandocExportSchema>
export const pandocSettingsSchema = z.object({
  executablePath: z.string().min(1).max(32768).nullable().default(null),
  referenceDocumentPath: z.string().min(1).max(32768).nullable().default(null),
  timeoutSeconds: z.number().int().min(10).max(300).default(90),
})
export type PandocSettings = z.infer<typeof pandocSettingsSchema>
export interface PandocStatus { available: boolean; version: string | null; executablePath: string | null; source: 'bundled' | 'configured' | 'system' | null; message: string; settings: PandocSettings }
export interface PandocResult { path: string; warnings: string; snapshot?: DocumentSnapshot }
export interface PandocProgress { stage: 'preparing' | 'converting' | 'writing' | 'complete'; message: string }

// Arguments are separate argv entries; shell syntax and resource/executable options are never accepted.
export function validatePandocArguments(args: string[]): string[] {
  const switches = new Set(['--toc', '--number-sections', '--standalone', '--strip-comments', '--ascii', '--preserve-tabs'])
  const patterns = [/^--wrap=(?:none|auto|preserve)$/, /^--toc-depth=[1-6]$/, /^--columns=\d{1,3}$/, /^--shift-heading-level-by=-?[0-6]$/, /^--top-level-division=(?:default|section|chapter|part)$/, /^--highlight-style=(?:pygments|tango|espresso|zenburn|kate|monochrome|breezedark|haddock)$/, /^--reference-location=(?:block|section|document)$/, /^--markdown-headings=(?:atx|setext)$/, /^--eol=(?:lf|crlf|native)$/]
  for (const argument of args) if (!switches.has(argument) && !patterns.some((pattern) => pattern.test(argument))) throw new Error(`不支持的转换参数：${argument}。可用目录深度、换行、标题、代码配色等选项；文件路径请使用专用选择入口。`)
  return [...args]
}
