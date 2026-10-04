import { z } from 'zod'

export const pdfOptionsSchema = z.object({
  pageSize: z.enum(['A4', 'A3', 'A5', 'Letter', 'Legal']).default('A4'),
  landscape: z.boolean().default(false),
  marginMm: z.number().min(0).max(50).default(16),
  pageNumbers: z.boolean().default(false),
  header: z.string().max(200).default(''),
  footer: z.string().max(200).default(''),
})

export const markdownExtensionsSchema = z.object({
  highlight: z.boolean().default(true),
  superscript: z.boolean().default(true),
  subscript: z.boolean().default(true),
  underline: z.boolean().default(true),
  emoji: z.boolean().default(true),
  emojiCompletion: z.boolean().default(true),
})
export type MarkdownExtensionOptions = z.infer<typeof markdownExtensionsSchema>
export const defaultMarkdownExtensions = markdownExtensionsSchema.parse({})

export const preferencesSchema = z.object({
  interfaceZoom: z.number().min(75).max(150).default(100),
  showFormattingToolbar: z.boolean().default(false),
  fontSize: z.number().min(12).max(32).default(17),
  lineHeight: z.number().min(1.2).max(2.5).default(1.78),
  contentWidth: z.number().min(480).max(1400).default(860),
  fontFamily: z.enum(['serif', 'sans-serif', 'monospace']).default('serif'),
  sourceWrap: z.boolean().default(true),
  sourceLineNumbers: z.boolean().default(true),
  smartPunctuation: z.boolean().default(false),
  autoPair: z.boolean().default(true),
  autoLink: z.boolean().default(true),
  codeWrap: z.boolean().default(false),
  codeLineNumbers: z.boolean().default(true),
  defaultCodeLanguage: z.string().trim().max(40).regex(/^[\w+#.-]*$/).default(''),
  tabSize: z.number().int().min(2).max(8).default(2),
  spellcheck: z.boolean().default(true),
  autoSave: z.boolean().default(false),
  autoSaveSeconds: z.number().int().min(5).max(300).default(30),
  restoreSession: z.boolean().default(false),
  exportToc: z.boolean().default(false),
  exportMetadata: z.boolean().default(false),
  customCss: z.string().max(100000).default(''),
  markdownExtensions: markdownExtensionsSchema.default(() => markdownExtensionsSchema.parse({})),
  pdf: pdfOptionsSchema.default(() => pdfOptionsSchema.parse({})),
})
export type Preferences = z.infer<typeof preferencesSchema>
export type PdfOptions = z.infer<typeof pdfOptionsSchema>
export const defaultPreferences = preferencesSchema.parse({})

export function parsePreferences(value: unknown): Preferences {
  const result = preferencesSchema.safeParse(value)
  return result.success ? result.data : preferencesSchema.parse({})
}
