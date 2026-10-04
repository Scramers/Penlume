import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addTheme, allThemes, combinedThemeCss, defaultThemeLibrary, deleteTheme, duplicateTheme, parseThemeLibrary, selectTheme, selectedTheme, THEME_LIBRARY_STORAGE_KEY, updateTheme, type ThemeAppearance, type ThemeInput, type ThemeLibraryState } from '../shared/theme-library'

function readLibrary(): ThemeLibraryState {
  try { return parseThemeLibrary(JSON.parse(localStorage.getItem(THEME_LIBRARY_STORAGE_KEY) ?? 'null')) } catch { return defaultThemeLibrary() }
}

export function useThemeLibrary() {
  const [state, setState] = useState(readLibrary)
  const [storageError, setStorageError] = useState<string | null>(null)
  const current = useRef(state)
  const commit = useCallback((next: ThemeLibraryState) => {
    current.current = next
    setState(next)
    try { localStorage.setItem(THEME_LIBRARY_STORAGE_KEY, JSON.stringify(next)); setStorageError(null) }
    catch { setStorageError('主题已应用，但本地存储空间不足，重启后可能无法保留。请导出重要主题。') }
  }, [])
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== THEME_LIBRARY_STORAGE_KEY) return
      try { const next = parseThemeLibrary(JSON.parse(event.newValue ?? 'null')); current.current = next; setState(next) } catch { /* Ignore incomplete writes from another window. */ }
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  const choose = useCallback((appearance: ThemeAppearance, id: string) => { commit(selectTheme(current.current, appearance, id)) }, [commit])
  const add = useCallback((input: ThemeInput) => { const result = addTheme(current.current, input); commit(result.state); return result }, [commit])
  const update = useCallback((id: string, input: ThemeInput) => { const result = updateTheme(current.current, id, input); commit(result.state); return result }, [commit])
  const copy = useCallback((id: string) => { const result = duplicateTheme(current.current, id); commit(result.state); return result.theme }, [commit])
  const remove = useCallback((id: string) => { commit(deleteTheme(current.current, id)) }, [commit])
  return useMemo(() => ({ state, themes: allThemes(state), storageError, select: choose, add, update, duplicate: copy, remove,
    selected: (appearance: ThemeAppearance) => selectedTheme(state, appearance),
    editorCss: (appearance: ThemeAppearance, legacyCustomCss = '') => combinedThemeCss(selectedTheme(state, appearance), legacyCustomCss, 'editor'),
    exportCss: (appearance: ThemeAppearance, legacyCustomCss = '') => combinedThemeCss(selectedTheme(state, appearance), legacyCustomCss, 'export'),
  }), [state, storageError, choose, add, update, copy, remove])
}
export type ThemeLibraryController = ReturnType<typeof useThemeLibrary>
