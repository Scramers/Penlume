import { useLocalization } from '../localization'
import type { WritingStatistics } from '../../shared/writing-statistics'

interface WritingStatsPanelProps {
  documentStats: WritingStatistics
  selectionStats: WritingStatistics | null
  onClose: () => void
}

function StatsTable({ stats }: { stats: WritingStatistics }) {
  const { t, locale } = useLocalization()
  return (
    <dl className="writing-stats__grid">
      <dt>{t("词数")}</dt><dd>{stats.words.toLocaleString(locale)}</dd>
      <dt>{t("字符（含空格）")}</dt><dd>{stats.characters.toLocaleString(locale)}</dd>
      <dt>{t("字符（不含空格）")}</dt><dd>{stats.charactersWithoutSpaces.toLocaleString(locale)}</dd>
      <dt>{t("段落")}</dt><dd>{stats.paragraphs.toLocaleString(locale)}</dd>
      <dt>{t("行数")}</dt><dd>{stats.lines.toLocaleString(locale)}</dd>
      <dt>{t("预计阅读")}</dt><dd>{t("{count} 分钟", { count: stats.readingMinutes })}</dd>
    </dl>
  )
}

export function WritingStatsPanel({
  documentStats,
  selectionStats,
  onClose,
}: WritingStatsPanelProps) {
  const { t, locale } = useLocalization()
  return (
    <section className="writing-stats" aria-label={t("字数统计")}>
      <header>
        <strong>{selectionStats ? t("选中内容") : t("当前文档")}</strong>
        <button aria-label={t("关闭字数统计")} onClick={onClose} type="button">×</button>
      </header>
      <StatsTable stats={selectionStats ?? documentStats} />
      {selectionStats ? (
        <details>
          <summary>{t("查看整个文档")}</summary>
          <StatsTable stats={documentStats} />
        </details>
      ) : null}
    </section>
  )
}
