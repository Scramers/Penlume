import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { INTERFACE_LANGUAGE_EVENT, INTERFACE_LANGUAGE_STORAGE_KEY, normalizeInterfaceLanguage, parseLocalizedMessage, translate, type InterfaceLanguage, type LocalizedText, type TranslationParams } from '../shared/localization'

export { localized } from '../shared/localization'
type Translate = (text: string, params?: TranslationParams) => string
interface Localization { locale: InterfaceLanguage; setLocale: (locale: InterfaceLanguage) => void; t: Translate }
const fallback: Localization = { locale: 'zh-CN', setLocale: () => {}, t: (text, params) => translate('zh-CN', text, params) }
const LocalizationContext = createContext<Localization>(fallback)

export function readInterfaceLanguage(): InterfaceLanguage {
  try { return normalizeInterfaceLanguage(localStorage.getItem(INTERFACE_LANGUAGE_STORAGE_KEY)) } catch { return 'zh-CN' }
}

export function LocalizationProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: InterfaceLanguage }) {
  const [locale, setLocaleState] = useState<InterfaceLanguage>(() => initialLocale ?? readInterfaceLanguage())
  const current = useRef(locale)
  current.current = locale
  // Stable identity keeps document/editor callbacks alive while reading the latest locale.
  const t = useCallback<Translate>((key, params) => translate(current.current, key, params), [])
  const setLocale = useCallback((value: InterfaceLanguage) => {
    const next = normalizeInterfaceLanguage(value)
    try { localStorage.setItem(INTERFACE_LANGUAGE_STORAGE_KEY, next) } catch { /* The current window can still switch when storage is unavailable. */ }
    setLocaleState(next)
  }, [])
  useEffect(() => { document.documentElement.lang = locale; window.dispatchEvent(new CustomEvent(INTERFACE_LANGUAGE_EVENT, { detail: locale })) }, [locale])
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === INTERFACE_LANGUAGE_STORAGE_KEY) setLocaleState(normalizeInterfaceLanguage(event.newValue)) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <LocalizationContext.Provider value={value}>{children}</LocalizationContext.Provider>
}

export function useLocalization(): Localization { return useContext(LocalizationContext) }

/** Keep feedback as a key + data so visible statuses also switch immediately. */
export function useLocalizedState(initial: string | LocalizedText | null) {
  const { t } = useLocalization()
  const [value, setValueState] = useState<LocalizedText | null>(() => typeof initial === 'string' ? parseLocalizedMessage(initial) : initial)
  const setValue = useCallback((next: string | LocalizedText | null) => setValueState(typeof next === 'string' ? parseLocalizedMessage(next) : next), [])
  const result = value === null ? null : t(value.key, value.params)
  return [result, setValue] as const
}
