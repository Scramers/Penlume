import { useLocalization, useLocalizedState } from '../localization'
import { useState } from 'react'
import type { WorkspaceMutation } from '../../shared/contracts'
import { Modal } from './Modal'

export function FileActionsPanel({ filePath, rootPath, onRun, onClose }: { filePath: string | null; rootPath: string; onRun: (request: WorkspaceMutation) => Promise<void>; onClose: () => void }) {
  const { t } = useLocalization()
  const [action, setAction] = useState<WorkspaceMutation['action']>(filePath ? 'rename' : 'create-file')
  const [target, setTarget] = useState(filePath ? filePath.slice(rootPath.length + 1) : '新文档.md')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useLocalizedState('')
  const run = async () => { setBusy(true); setError(''); try { await onRun({ action, path: filePath ?? undefined, target: target || undefined }); onClose() } catch (reason) { setError(String(reason)) } finally { setBusy(false) } }
  return <Modal title={filePath ? t("管理文档") : t("管理工作区")} onClose={busy ? undefined : onClose}>
    <form className="preferences" onSubmit={(event) => { event.preventDefault(); void run() }}>
      {filePath ? <p className="path-label">{filePath}</p> : null}
      <label>{t("操作")}<select aria-label={t("文件操作")} value={action} disabled={busy} onChange={(event) => setAction(event.target.value as WorkspaceMutation['action'])}>
        <option value="create-file">{t("新建文档")}</option><option value="create-directory">{t("新建文件夹")}</option>
        {filePath ? <><option value="rename">{t("重命名或移动文档")}</option><option value="delete">{t("移入恢复区")}</option></> : null}
        <option value="restore">{t("恢复最近移除的文档")}</option>
      </select></label>
      {action !== 'delete' && action !== 'restore' ? <label>{t("相对于工作区的路径")}<input autoFocus aria-label={t("目标路径")} required value={target} onChange={(event) => setTarget(event.target.value)} placeholder="notes/新文档.md" /></label> : <p>{action === 'delete' ? t("文档会移入此工作区的恢复区，之后可从“管理工作区”恢复。图片资源会保留。") : t("恢复最近移除的文档；同名文档已经存在时不会覆盖。")}</p>}
      {error ? <p role="alert">{error}</p> : null}
      <div className="modal-actions"><button disabled={busy} type="button" onClick={onClose}>{t("取消")}</button><button disabled={busy} type="submit" className={action === 'delete' ? 'button--danger' : 'button--primary'}>{busy ? t("处理中…") : t("执行")}</button></div>
    </form>
  </Modal>
}
