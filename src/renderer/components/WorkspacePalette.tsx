import { useLocalization } from '../localization'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkspaceEntry,
  WorkspaceSearchResult,
  WorkspaceSnapshot,
} from '../../shared/contracts'

export type WorkspacePaletteMode = 'hidden' | 'quick-open' | 'search'

interface WorkspaceFile {
  name: string
  path: string
  relativePath: string
}

interface WorkspacePaletteProps {
  mode: Exclude<WorkspacePaletteMode, 'hidden'>
  query: string
  workspace: WorkspaceSnapshot | null
  searchResult: WorkspaceSearchResult | null
  searchLoading: boolean
  searchError: string | null
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
  onQueryChange: (value: string) => void
  onCaseSensitiveChange: (value: boolean) => void
  onWholeWordChange: (value: boolean) => void
  onRegexpChange: (value: boolean) => void
  onOpenFile: (path: string, line?: number, column?: number) => void
  onOpenWorkspace: () => void
  onClose: () => void
}

function flattenEntries(
  entries: WorkspaceEntry[],
  rootPath: string,
): WorkspaceFile[] {
  return entries.flatMap((entry) =>
    entry.type === 'file'
      ? [{
          name: entry.name,
          path: entry.path,
          relativePath: entry.path.slice(rootPath.length).replace(/^[\\/]/, ''),
        }]
      : flattenEntries(entry.children ?? [], rootPath),
  )
}

function fuzzyScore(value: string, query: string): number | null {
  const haystack = value.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase().trim()
  if (!needle) return 0
  let searchFrom = 0
  let score = 0
  let previous = -2
  for (const character of needle) {
    const position = haystack.indexOf(character, searchFrom)
    if (position < 0) return null
    score += position === previous + 1 ? 1 : position + 4
    previous = position
    searchFrom = position + 1
  }
  return score
}

export function WorkspacePalette({
  mode,
  query,
  workspace,
  searchResult,
  searchLoading,
  searchError,
  caseSensitive,
  wholeWord,
  regexp,
  onQueryChange,
  onCaseSensitiveChange,
  onWholeWordChange,
  onRegexpChange,
  onOpenFile,
  onOpenWorkspace,
  onClose,
}: WorkspacePaletteProps) {
  const { t } = useLocalization()
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const quickFiles = useMemo(() => {
    if (!workspace) return []
    return flattenEntries(workspace.entries, workspace.rootPath)
      .map((file) => ({ file, score: fuzzyScore(file.relativePath, query) }))
      .filter((entry): entry is { file: WorkspaceFile; score: number } => entry.score !== null)
      .sort((left, right) => left.score - right.score || left.file.relativePath.localeCompare(right.file.relativePath))
      .slice(0, 100)
      .map((entry) => entry.file)
  }, [query, workspace])

  const itemCount = mode === 'quick-open' ? quickFiles.length : (searchResult?.matches.length ?? 0)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [mode])

  useEffect(() => {
    setSelectedIndex(0)
  }, [mode, query, searchResult])

  const activateSelection = () => {
    const path = mode === 'quick-open'
      ? quickFiles[selectedIndex]?.path
      : searchResult?.matches[selectedIndex]?.path
    const match = mode === 'search' ? searchResult?.matches[selectedIndex] : undefined
    if (path) onOpenFile(path, match?.line, match?.column)
  }

  return (
    <div className="workspace-palette-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className={`workspace-palette workspace-palette--${mode}`} aria-label={mode === 'quick-open' ? t("快速打开") : t("工作区搜索")}>
        <header className="workspace-palette__header">
          <input
            aria-label={mode === 'quick-open' ? t("输入文件名") : t("输入搜索内容")}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelectedIndex((current) => Math.min(current + 1, Math.max(0, itemCount - 1)))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex((current) => Math.max(0, current - 1))
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                activateSelection()
              }
            }}
            placeholder={mode === 'quick-open' ? t("按名称快速打开文件…") : t("在文件夹中搜索…")}
            ref={inputRef}
            spellCheck={false}
            value={query}
          />
          {mode === 'search' ? (
            <div className="workspace-palette__options">
              <button aria-pressed={caseSensitive} className={caseSensitive ? 'is-active' : ''} onClick={() => onCaseSensitiveChange(!caseSensitive)} title={t("区分大小写")} type="button">Aa</button>
              <button aria-pressed={wholeWord} className={wholeWord ? 'is-active' : ''} onClick={() => onWholeWordChange(!wholeWord)} title={t("全词匹配")} type="button">W</button>
              <button aria-pressed={regexp} className={regexp ? 'is-active' : ''} onClick={() => onRegexpChange(!regexp)} title={t("正则表达式")} type="button">.*</button>
            </div>
          ) : null}
          <button aria-label={t("关闭")} className="icon-button" onClick={onClose} type="button">×</button>
        </header>

        <div className="workspace-palette__body">
          {!workspace ? (
            <div className="workspace-palette__empty">
              <p>{t("请先打开一个文件夹。")}</p>
              <button className="button--primary" onClick={onOpenWorkspace} type="button">{t("打开文件夹")}</button>
            </div>
          ) : mode === 'quick-open' ? (
            quickFiles.length > 0 ? (
              <ol className="workspace-palette__list">
                {quickFiles.map((file, index) => (
                  <li key={file.path}>
                    <button className={index === selectedIndex ? 'is-selected' : ''} onClick={() => onOpenFile(file.path)} onMouseEnter={() => setSelectedIndex(index)} type="button">
                      <strong>{file.name}</strong>
                      <span>{file.relativePath}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="workspace-palette__empty">{t("没有匹配的文件。")}</p>
          ) : searchError ? (
            <p className="workspace-palette__empty workspace-palette__error">{searchError}</p>
          ) : searchLoading ? (
            <p className="workspace-palette__empty">{t("正在搜索…")}</p>
          ) : query.length === 0 ? (
            <p className="workspace-palette__empty">{t("输入内容以搜索当前文件夹中的 Markdown 和文本文件。")}</p>
          ) : searchResult && searchResult.matches.length > 0 ? (
            <ol className="workspace-palette__list workspace-search-results">
              {searchResult.matches.map((match, index) => (
                <li key={`${match.path}:${match.line}:${match.column}`}>
                  <button className={index === selectedIndex ? 'is-selected' : ''} onClick={() => onOpenFile(match.path, match.line, match.column)} onMouseEnter={() => setSelectedIndex(index)} type="button">
                    <strong>{match.relativePath}<small>{t("第 {value1} 行", { value1: match.line })}</small></strong>
                    <span>{match.preview || t("（空行）")}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="workspace-palette__empty">{t("没有搜索结果。")}</p>
          )}
        </div>
        {workspace && mode === 'search' && searchResult ? (
          <footer className="workspace-palette__footer">
            {t("已扫描 {files} 个文件，找到 {count} 处", { files: searchResult.scannedFiles, count: searchResult.matches.length })}
            {searchResult.truncated ? t("（结果已截断）") : ''}
          </footer>
        ) : null}
      </section>
    </div>
  )
}
