import { translateMessage } from '../../shared/localization'
import { useLocalization, useLocalizedState, localized } from '../localization'
import { useEffect, useRef, useState } from 'react'
import type { ImageLibraryItem, ImageLibraryMutation, ImageLibraryMutationResult, ImageLibrarySnapshot } from '../../shared/image-library'
import { Icon } from './Icon'
import { Modal } from './Modal'
import '../image-library.css'

export interface ImageLibraryProps {
  documentName: string
  initialSnapshot?: ImageLibrarySnapshot | null
  onRefresh: () => Promise<ImageLibrarySnapshot>
  onMutate: (mutation: ImageLibraryMutation) => Promise<ImageLibraryMutationResult>
  onUpload?: (imageIds?: string[]) => void
  onClose: () => void
}
const STATUS: Record<ImageLibraryItem['status'], string> = { local: '本地图片', remote: '远程图片', embedded: '内嵌图片', missing: '文件缺失', blocked: '不可访问' }
function sizeLabel(size: number | null): string { if (size === null) return '大小未知'; if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`; return `${(size / 1024 / 1024).toFixed(1)} MB` }
function Preview({ url, name }: { url: string | null; name: string }) {
  const { t, locale } = useLocalization()
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  return <div className="image-library__preview">{url && !broken ? <img src={url} alt={name} loading="lazy" onError={() => setBroken(true)} /> : <div className="image-library__placeholder"><Icon name="image" size={30} /><span>{broken ? t("无法预览此图片") : t("暂无本地预览")}</span></div>}</div>
}

export function ImageLibrary({ documentName, initialSnapshot = null, onRefresh, onMutate, onUpload, onClose }: ImageLibraryProps) {
  const { t, locale } = useLocalization()
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [tab, setTab] = useState<'references' | 'orphans' | 'recovery'>('references')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useLocalizedState(null)
  const [notice, setNotice] = useLocalizedState(null)
  const callbacks = useRef({ onRefresh, onMutate }); callbacks.current = { onRefresh, onMutate }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; if (!initialSnapshot) void refresh(); return () => { alive.current = false } }, [])
  const selected = snapshot?.items.find((item) => item.id === selectedId) ?? null
  useEffect(() => { setNewName(selected?.name ?? '') }, [selected?.id])
  async function refresh() {
    setBusy(true); setError(null)
    try { const result = await callbacks.current.onRefresh(); if (alive.current) setSnapshot(result) }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : localized("无法读取图片资源。")) }
    finally { if (alive.current) setBusy(false) }
  }
  async function mutate(mutation: ImageLibraryMutation) {
    if (busy) return
    setBusy(true); setError(null); setNotice(null)
    try { const result = await callbacks.current.onMutate(mutation); if (alive.current) { setSnapshot(result.snapshot); setNotice(result.notice) } }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : localized("图片操作未完成。")) }
    finally { if (alive.current) setBusy(false) }
  }
  const matches = (value: string) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  const items = snapshot?.items.filter((item) => matches(`${item.name} ${item.urls.join(' ')}`)) ?? []
  const orphans = snapshot?.orphans.filter((item) => matches(item.name)) ?? []
  const recovery = snapshot?.recovery.filter((item) => matches(item.name)) ?? []
  return <Modal title={t("图片资源管理")} onClose={busy ? undefined : onClose} footer={<><span className="image-library__footer-note">{t("引用修改支持文档撤销 · 原文件保留 · 恢复区可还原")}</span><button type="button" onClick={onClose} disabled={busy}>{t("完成")}</button></>}>
    <div className="image-library" aria-busy={busy}>
      <div className="image-library__intro"><div><strong>{documentName}</strong><p>{t("整理图片引用、收纳本地资源，找回缺失的文件。")}</p></div><div className="image-library__detail-actions">{onUpload ? <button type="button" disabled={busy} onClick={() => onUpload()}><Icon name="export" size={14} />{t("上传图片…")}</button> : null}<button type="button" disabled={busy} onClick={() => void refresh()}><Icon name="clock" size={14} />{busy ? t("处理中…") : t("刷新检查")}</button></div></div>
      <div className="image-library__tabs" role="tablist" aria-label={t("图片资源分类")}>
        <button type="button" role="tab" aria-selected={tab === 'references'} onClick={() => setTab('references')}>{t("文档引用")} <span>{snapshot?.items.length ?? 0}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'orphans'} onClick={() => setTab('orphans')}>{t("未使用资源")} <span>{snapshot?.orphans.length ?? 0}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'recovery'} onClick={() => setTab('recovery')}>{t("恢复区")} <span>{snapshot?.recovery.length ?? 0}</span></button>
      </div>
      <label className="image-library__search"><Icon name="search" size={16} /><input aria-label={t("筛选图片资源")} placeholder={t("搜索文件名或图片 URL")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {error ? <p className="image-library__message image-library__message--error" role="alert">{error}</p> : null}
      {notice ? <p className="image-library__message" role="status">{notice}</p> : null}
      {snapshot?.warnings.map((warning) => <p className="image-library__warning" key={warning}>{translateMessage(locale, warning)}</p>)}
      {tab === 'references' ? <div className="image-library__content" role="tabpanel" aria-label={t("文档引用")}>
        <div className="image-library__list">
          {!items.length ? <p className="image-library__empty">{snapshot ? query ? t("没有匹配的图片。") : t("当前文档没有图片引用。") : t("正在检查文档图片…")}</p> : items.map((item) => <button key={item.id} type="button" className="image-library__row" aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)}><div className={`image-library__symbol image-library__symbol--${item.status}`}><Icon name="image" size={19} /></div><div><strong>{item.name}</strong><small>{t(STATUS[item.status])} · {t("{count} 处引用", { count: item.references })} · {t(sizeLabel(item.size))}</small></div><span className={`image-library__badge image-library__badge--${item.status}`}>{item.inAssets ? t("已收纳") : t(STATUS[item.status])}</span></button>)}
        </div>
        <aside className="image-library__detail">
          {selected ? <><Preview url={selected.previewUrl} name={selected.name} /><strong className="image-library__detail-name">{selected.name}</strong><div className="image-library__properties"><span>{t(STATUS[selected.status])}</span><span>{t(sizeLabel(selected.size))}</span><span>{t("{count} 处引用", { count: selected.references })}</span></div>{selected.message ? <p className="image-library__warning">{translateMessage(locale, selected.message)}</p> : null}<div className="image-library__urls">{selected.urls.map((url) => <code key={url}>{url.length > 512 ? `${url.slice(0, 512)}…` : url}</code>)}</div>
            {selected.status === 'local' && selected.version ? <>{onUpload ? <button type="button" disabled={busy} onClick={() => onUpload([selected.id])}>{t("上传此图片…")}</button> : null}<button type="button" className="image-library__primary" disabled={busy || selected.inAssets} onClick={() => void mutate({ action: 'copy', imageId: selected.id, expectedVersion: selected.version! })}>{selected.inAssets ? t("已在文档资源目录") : t("复制到文档资源目录")}</button><form className="image-library__rename" onSubmit={(event) => { event.preventDefault(); void mutate({ action: 'rename', imageId: selected.id, expectedVersion: selected.version!, name: newName }) }}><label htmlFor="image-resource-name">{t("图片文件名")}</label><div><input id="image-resource-name" value={newName} disabled={busy} onChange={(event) => setNewName(event.target.value)} /><button type="submit" disabled={busy || !newName.trim() || newName === selected.name}>{t("重命名引用")}</button></div><small>{t("生成新文件并更新全部图片引用。保留原文件，保证撤销后图片仍可使用。")}</small></form></> : null}
            <button type="button" className="image-library__remove" disabled={busy} onClick={() => void mutate({ action: 'remove-reference', imageId: selected.id })}>{t("移除全部图片引用")}</button><small className="image-library__hint">{t("保留图片说明文字与资源文件，可通过文档撤销恢复引用。")}</small>
          </> : <div className="image-library__empty"><Icon name="image" size={32} /><p>{t("选择一张图片，查看引用并整理资源。")}</p></div>}
        </aside>
      </div> : null}
      {tab === 'orphans' ? <div role="tabpanel" aria-label={t("未使用资源")}><p className="image-library__hint">{t("检查范围：已授权目录中的 {count} 份文档及打开标签的未保存内容。仅列出当前文档资源目录中的图片。", { count: snapshot?.scannedDocuments ?? 0 })}</p><div className="image-library__resource-list">{!orphans.length ? <p className="image-library__empty">{query ? t("没有匹配的资源。") : t("未发现可整理的孤立图片。")}</p> : orphans.map((item) => <div className="image-library__resource" key={item.path}><Preview url={item.previewUrl} name={item.name} /><div><strong>{item.name}</strong><small>{t(sizeLabel(item.size))}</small></div><button type="button" disabled={busy || !snapshot?.scanComplete} onClick={() => void mutate({ action: 'quarantine', path: item.path, expectedVersion: item.version })}>{t("移入恢复区")}</button></div>)}</div><p className="image-library__hint">{t("移入前再次检查所有引用和文件版本。引用检查不完整时禁止移动。")}</p></div> : null}
      {tab === 'recovery' ? <div role="tabpanel" aria-label={t("恢复区")}><p className="image-library__hint">{t("图片保存在本地恢复区。恢复到原目录；若同名文件已存在，保留两份并停止覆盖。")}</p><div className="image-library__resource-list">{!recovery.length ? <p className="image-library__empty">{query ? t("没有匹配的恢复记录。") : t("恢复区为空。")}</p> : recovery.map((item) => <div className="image-library__resource" key={item.id}><div className="image-library__symbol"><Icon name="image" size={22} /></div><div><strong>{item.name}</strong><small>{t(sizeLabel(item.size))} · {new Date(item.removedAt).toLocaleString(locale)}</small></div><button type="button" disabled={busy} onClick={() => void mutate({ action: 'restore', recoveryId: item.id })}>{t("恢复图片")}</button></div>)}</div></div> : null}
    </div>
  </Modal>
}
