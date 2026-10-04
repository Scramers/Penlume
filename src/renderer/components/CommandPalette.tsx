import { useLocalization } from '../localization'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Icon, type IconName } from './Icon'

export interface PaletteCommand { id: string; title: string; group: string; shortcut?: string; keywords?: string; icon: IconName; run: () => void }
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const { t } = useLocalization()
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0)
  const listId = useId(), list = useRef<HTMLDivElement>(null)
  const results = useMemo(() => {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    return commands.filter((command) => terms.every((term) => `${command.title} ${command.group} ${command.keywords ?? ''}`.toLocaleLowerCase().includes(term)))
  }, [commands, query])
  const activeIndex = Math.min(selected, Math.max(0, results.length - 1))
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [activeIndex, query])
  const execute = (command: PaletteCommand) => { onClose(); command.run() }
  return <Modal title={t("命令面板")} onClose={onClose}>
    <div className="command-search"><Icon name="search" /><input autoFocus aria-label={t("搜索命令")} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={results[activeIndex] ? `${listId}-${results[activeIndex].id}` : undefined} placeholder={t("输入操作，例如：导出、专注、保存全部…")} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0) }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)) }
      if (event.key === 'Enter' && results[activeIndex]) { event.preventDefault(); execute(results[activeIndex]) }
    }} /></div>
    <div className="command-list" role="listbox" aria-label={t("可用命令")} id={listId} ref={list}>
      {results.map((command, index) => <button role="option" aria-selected={index === activeIndex} id={`${listId}-${command.id}`} key={command.id} className="command-item" onMouseEnter={() => setSelected(index)} onClick={() => execute(command)} type="button"><span className="command-item__icon"><Icon name={command.icon} /></span><span className="command-item__name">{command.title}<small>{command.group}</small></span>{command.shortcut ? <kbd>{command.shortcut}</kbd> : null}</button>)}
      {!results.length ? <p className="command-empty">{t("没有匹配的命令。试试“文件”或“视图”。")}</p> : null}
    </div><div className="command-hint"><span>{t("↑ ↓ 选择 · Enter 执行")}</span><span>{t("{count} 项操作 · Esc 关闭", { count: results.length })}</span></div>
  </Modal>
}
