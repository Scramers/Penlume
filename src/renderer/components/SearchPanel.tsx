import { useLocalization } from '../localization'
import { useEffect, useRef } from 'react'
import type { EditorSearchSummary } from '../editor/editor-adapter'

export type SearchPanelMode = 'hidden' | 'find' | 'replace'

interface SearchPanelProps {
  mode: Exclude<SearchPanelMode, 'hidden'>
  query: string
  replacement: string
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
  summary: EditorSearchSummary
  onQueryChange: (value: string) => void
  onReplacementChange: (value: string) => void
  onCaseSensitiveChange: (value: boolean) => void
  onWholeWordChange: (value: boolean) => void
  onRegexpChange: (value: boolean) => void
  onFindNext: () => void
  onFindPrevious: () => void
  onReplaceNext: () => void
  onReplaceAll: () => void
  onClose: () => void
}

export function SearchPanel({
  mode,
  query,
  replacement,
  caseSensitive,
  wholeWord,
  regexp,
  summary,
  onQueryChange,
  onReplacementChange,
  onCaseSensitiveChange,
  onWholeWordChange,
  onRegexpChange,
  onFindNext,
  onFindPrevious,
  onReplaceNext,
  onReplaceAll,
  onClose,
}: SearchPanelProps) {
  const { t } = useLocalization()
  const queryRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    queryRef.current?.focus()
    queryRef.current?.select()
  }, [mode])

  const resultLabel = !summary.valid
    ? t("表达式无效")
    : query.length === 0
      ? t("输入查找内容")
      : summary.count === 0
        ? t("无结果")
        : `${summary.current || '–'} / ${summary.count}`

  return (
    <section className="search-panel" aria-label={t("查找与替换")}>
      <div className="search-panel__row">
        <input
          aria-label={t("查找")}
          className={!summary.valid ? 'search-panel__input search-panel__input--invalid' : 'search-panel__input'}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter') {
              event.preventDefault()
              if (event.shiftKey) onFindPrevious()
              else onFindNext()
            }
          }}
          placeholder={t("查找")}
          ref={queryRef}
          spellCheck={false}
          value={query}
        />
        <span className="search-panel__count" role="status">{resultLabel}</span>
        <button
          aria-pressed={caseSensitive}
          className={caseSensitive ? 'search-panel__toggle search-panel__toggle--active' : 'search-panel__toggle'}
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
          title={t("区分大小写")}
          type="button"
        >
          Aa
        </button>
        <button
          aria-pressed={wholeWord}
          className={wholeWord ? 'search-panel__toggle search-panel__toggle--active' : 'search-panel__toggle'}
          onClick={() => onWholeWordChange(!wholeWord)}
          title={t("全词匹配")}
          type="button"
        >
          W
        </button>
        <button
          aria-pressed={regexp}
          className={regexp ? 'search-panel__toggle search-panel__toggle--active' : 'search-panel__toggle'}
          onClick={() => onRegexpChange(!regexp)}
          title={t("正则表达式")}
          type="button"
        >
          .*
        </button>
        <button onClick={onFindPrevious} title={t("上一个（Shift+Enter）")} type="button">↑</button>
        <button onClick={onFindNext} title={t("下一个（Enter）")} type="button">↓</button>
        <button aria-label={t("关闭查找")} onClick={onClose} type="button">×</button>
      </div>
      {mode === 'replace' ? (
        <div className="search-panel__row search-panel__row--replace">
          <input
            aria-label={t("替换为")}
            className="search-panel__input"
            onChange={(event) => onReplacementChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'Enter') {
                event.preventDefault()
                onReplaceNext()
              }
            }}
            placeholder={t("替换为")}
            value={replacement}
          />
          <button onClick={onReplaceNext} type="button">{t("替换")}</button>
          <button onClick={onReplaceAll} type="button">{t("全部替换")}</button>
        </div>
      ) : null}
    </section>
  )
}
