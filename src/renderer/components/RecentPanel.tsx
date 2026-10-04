import { useLocalization } from '../localization'
import type { RecentEntry } from '../../shared/contracts'
import { Modal } from './Modal'

export function RecentPanel({ entries, onOpen, onPin, onClear, onClose }: { entries: RecentEntry[]; onOpen: (path: string) => void; onPin: (path: string) => void; onClear: () => void; onClose: () => void }) {
  const { t } = useLocalization()
  return <Modal title={t("最近项目")} onClose={onClose} footer={<button onClick={onClear}>{t("清除未固定的记录")}</button>}>
    <div className="recent-list">{[...entries].sort((a, b) => Number(b.pinned) - Number(a.pinned)).map((entry) => <div key={entry.path}>
      <button className="recent-open" title={entry.path} onClick={() => onOpen(entry.path)}><strong>{entry.kind === 'directory' ? '▸ ' : '◇ '}{entry.path.split(/[\\/]/).pop()}</strong><small>{entry.path}</small></button>
      <button aria-label={t("{action} {path}", { action: t(entry.pinned ? '取消固定' : '固定'), path: entry.path })} aria-pressed={entry.pinned} onClick={() => onPin(entry.path)}>{entry.pinned ? '★' : '☆'}</button>
    </div>)}{!entries.length ? <p>{t("还没有最近项目。")}</p> : null}</div>
  </Modal>
}
