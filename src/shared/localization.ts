import { englishMessages } from './localization-en'

export type InterfaceLanguage = 'zh-CN' | 'en'
export type TranslationParams = Readonly<Record<string, string | number | LocalizedText>>
export interface LocalizedText { key: string; params?: TranslationParams }
export const INTERFACE_LANGUAGE_STORAGE_KEY = 'ttypora.interface-language'
export const INTERFACE_LANGUAGE_EVENT = 'ttypora:interface-language'
export const interfaceLanguages = [{ id: 'zh-CN', label: '简体中文' }, { id: 'en', label: 'English' }] as const

export function normalizeInterfaceLanguage(value: unknown): InterfaceLanguage {
  return value === 'en' ? 'en' : 'zh-CN'
}

/** Only explicit message keys are translated. Parameter values are always user data. */
export function translate(locale: InterfaceLanguage, text: string, params?: TranslationParams): string {
  const message = locale === 'en' && Object.hasOwn(englishMessages, text) ? englishMessages[text] : text
  return params ? message.replace(/\{([\w]+)\}/g, (placeholder, name: string) => {
    if (!Object.hasOwn(params, name)) return placeholder
    const value = params[name]
    return typeof value === 'object' ? translate(locale, value.key, value.params) : String(value)
  }) : message
}

export function localized(key: string, params?: TranslationParams): LocalizedText { return { key, params } }
export function hasEnglishTranslation(key: string): boolean { return Object.hasOwn(englishMessages, key) }
export const englishMessageKeys = Object.freeze(Object.keys(englishMessages))

const templateMatchers = Object.entries(englishMessages).flatMap(([key, english]) => {
  if (!/\{\w+\}/.test(key) || (key.replace(/\{\w+\}/g, '').match(/[\u4e00-\u9fff]/g)?.length ?? 0) < 2) return []
  return [key, english].map((source) => {
    const names: string[] = []
    const escaped = source.split(/(\{\w+\})/g).map((part) => {
      if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]*?)' }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }).join('')
    return { key, names, pattern: new RegExp(`^${escaped}$`) }
  })
})

/** For trusted UI feedback received as text from IPC; never pass document text or paths. */
export function parseLocalizedMessage(message: string): LocalizedText {
  if (Object.hasOwn(englishMessages, message)) return localized(message)
  const sourceKey = englishMessageKeys.find((key) => englishMessages[key] === message)
  if (sourceKey) return localized(sourceKey)
  for (const { key, names, pattern } of templateMatchers) {
    const match = pattern.exec(message)
    if (match) return localized(key, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])))
  }
  return localized(message)
}

export function translateMessage(locale: InterfaceLanguage, message: string): string {
  const value = parseLocalizedMessage(message)
  return translate(locale, value.key, value.params)
}

export function localizedThemeName(locale: InterfaceLanguage, theme: { id: string; builtIn: boolean; name: string }): string {
  const builtIns: Record<string, string> = { 'builtin-studio': '澄蓝', 'builtin-paper': '暖纸', 'builtin-jade': '苔庭', 'builtin-rose': '雾玫', 'builtin-midnight': '深空', 'builtin-graphite': '石墨', 'builtin-forest': '夜林', 'builtin-dusk': '暮紫' }
  return theme.builtIn && Object.hasOwn(builtIns, theme.id) ? translate(locale, builtIns[theme.id]) : theme.name
}

/** Display-only translation for unnamed documents. Never use this as a disk filename. */
export function localizedDocumentName(locale: InterfaceLanguage, displayName: string, filePath: string | null): string {
  return locale === 'en' && !filePath && /^(?:未命名|未命名文档)(?:\.md)?$/.test(displayName) ? translate(locale, '未命名文档') : displayName
}
