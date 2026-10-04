import { localizedDocumentName } from '../../shared/localization'
import { useLocalization } from '../localization'
import { useEffect, useRef } from 'react'
import { isDirty, type DocumentSession } from '../../shared/document-session'
import { Icon } from './Icon'

export function DocumentTabs({ session, onActivate, onClose, onNew }: { session: DocumentSession; onActivate: (id: string) => void; onClose: (id: string) => void; onNew: () => void }) {
  const { t, locale } = useLocalization()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [session.activeId])
  return <div className={`document-tabs${session.documents.length === 1 ? ' document-tabs--single' : ''}`}>
    <div className="document-tabs__list" role="tablist" aria-label={t("打开的文档")} ref={root}>
      {session.documents.map((document, index) => <div className={`document-tab${document.id === session.activeId ? ' document-tab--active' : ''}`} key={document.id}>
        <button type="button" role="tab" aria-selected={document.id === session.activeId} tabIndex={document.id === session.activeId ? 0 : -1} title={document.path ?? t("未保存文档")} onClick={() => onActivate(document.id)} onKeyDown={(event) => {
          let next = index
          if (event.key === 'ArrowRight') next = (index + 1) % session.documents.length
          else if (event.key === 'ArrowLeft') next = (index + session.documents.length - 1) % session.documents.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = session.documents.length - 1
          else return
          event.preventDefault(); onActivate(session.documents[next].id)
          const buttons = root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]'); buttons?.[next]?.focus()
        }}><Icon name="file" size={15} /><span>{localizedDocumentName(locale, document.displayName, document.path)}</span>{document.conflict ? <span className="tab-conflict" aria-label={t("文件冲突")}>!</span> : isDirty(document) ? <span className="tab-dirty" aria-label={t("未保存")} /> : null}</button>
        <button className="document-tab__close" type="button" aria-label={t("关闭 {value1}", { value1: localizedDocumentName(locale, document.displayName, document.path) })} title={t("关闭文档（Ctrl+W）")} onClick={() => onClose(document.id)}><Icon name="close" size={13} /></button>
      </div>)}
    </div>
    <button type="button" className="tab-new" title={t("新建文档（Ctrl+N）")} aria-label={t("新建文档")} onClick={onNew}><Icon name="plus" size={16} /></button>
  </div>
}
