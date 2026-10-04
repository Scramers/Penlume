import { translateMessage } from '../../shared/localization'
import { useLocalization, useLocalizedState, localized } from '../localization'
import { useEffect, useRef, useState } from 'react'
import type { ImageLibraryItem } from '../../shared/image-library'
import { imageUploaderConfigurationSchema, type ApplyImageUploadsResult, type ImageUploadProgress, type ImageUploadRequest, type ImageUploadTask, type ImageUploaderConfiguration, type ImageUploaderSettings } from '../../shared/image-uploader'
import { Icon } from './Icon'
import { Modal } from './Modal'
import '../image-uploader.css'

export interface ImageUploaderProps {
  documentName: string
  documentPath: string
  images: ImageLibraryItem[]
  initialImageIds?: string[]
  onReadSettings: () => Promise<ImageUploaderSettings>
  onChooseExecutable: () => Promise<ImageUploaderSettings | null>
  onResetExecutable?: () => Promise<ImageUploaderSettings>
  onSaveSettings: (configuration: ImageUploaderConfiguration) => Promise<ImageUploaderSettings>
  onUpload: (images: ImageUploadRequest['images']) => Promise<ImageUploadTask>
  onCancel: () => void
  onGetTask: (taskId?: string) => Promise<ImageUploadTask | null>
  onProgress: (listener: (progress: ImageUploadProgress) => void) => () => void
  onApply: (taskId: string, selectedItemIds: string[], allowChangedOriginals: string[]) => Promise<ApplyImageUploadsResult>
  onClose: () => void
}
const STATUS = { queued: '等待上传', freezing: '准备冻结副本', uploading: '上传中', success: '成功 · 等待检查', failed: '失败', cancelled: '已取消' }
const sameDocument = (a: string, b: string) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase()
const argsText = (settings: ImageUploaderSettings) => JSON.stringify(settings.args, null, 2)
function sizeLabel(bytes: number | null) { return bytes === null ? '大小未知' : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` }

export function ImageUploader(props: ImageUploaderProps) {
  const { t, locale } = useLocalization()
  const { documentName, documentPath, images, initialImageIds = [], onClose } = props
  const callbacks = useRef(props); callbacks.current = props
  const alive = useRef(true)
  const [settings, setSettings] = useState<ImageUploaderSettings | null>(null)
  const [adapter, setAdapter] = useState<ImageUploaderSettings['adapter']>('picgo')
  const [argumentsText, setArgumentsText] = useState('[\n  "upload",\n  "{file}"\n]')
  const [timeout, setTimeoutSeconds] = useState(90)
  const [selectedImages, setSelectedImages] = useState<string[]>(initialImageIds)
  const [task, setTask] = useState<ImageUploadTask | null>(null)
  const [selectedResults, setSelectedResults] = useState<string[]>([])
  const [applied, setApplied] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useLocalizedState(null)
  const [notice, setNotice] = useLocalizedState(null)
  const localImages = images.filter((image) => image.status === 'local' && image.version && image.path)
  const running = uploading || task?.status === 'running'
  const locked = busy || running
  const dirty = !!settings && (adapter !== settings.adapter || argumentsText !== argsText(settings) || timeout !== settings.timeoutSeconds)
  function useSettings(value: ImageUploaderSettings) { setSettings(value); setAdapter(value.adapter); setArgumentsText(argsText(value)); setTimeoutSeconds(value.timeoutSeconds) }
  function receiveTask(value: ImageUploadTask | null) { if (value && sameDocument(value.documentPath, documentPath)) setTask(value) }
  useEffect(() => {
    alive.current = true
    const unsubscribe = callbacks.current.onProgress((event) => { if (alive.current && sameDocument(event.task.documentPath, documentPath)) { receiveTask(event.task) } })
    void Promise.all([callbacks.current.onReadSettings(), callbacks.current.onGetTask()]).then(([configuration, existing]) => { if (alive.current) { useSettings(configuration); receiveTask(existing) } }).catch((failure) => { if (alive.current) setError(failure instanceof Error ? failure.message : localized("无法读取上传器设置。")) })
    return () => { alive.current = false; unsubscribe() }
  }, [documentPath])
  async function action(operation: () => Promise<void>) {
    if (locked) return
    setBusy(true); setError(null); setNotice(null)
    try { await operation() } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : localized("图片上传操作未完成。")) }
    finally { if (alive.current) setBusy(false) }
  }
  async function saveSettings() {
    await action(async () => { const configuration = imageUploaderConfigurationSchema.parse({ adapter, args: JSON.parse(argumentsText), timeoutSeconds: timeout }); const saved = await callbacks.current.onSaveSettings(configuration); if (alive.current) { useSettings(saved); setNotice('设置已保存。只有点击“上传所选图片”才会执行上传器。') } })
  }
  async function upload() {
    const selected = localImages.filter((image) => selectedImages.includes(image.id))
    if (locked || !settings?.executablePath || dirty || !selected.length) return
    setUploading(true); setError(null); setNotice(null); setSelectedResults([]); setApplied([]); setTask(null)
    try { const result = await callbacks.current.onUpload(selected.map((image) => ({ imageId: image.id, expectedVersion: image.version! }))); if (alive.current) receiveTask(result) }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : localized("无法开始上传。")) }
    finally { if (alive.current) setUploading(false) }
  }
  async function apply() {
    if (!task || !selectedResults.length) return
    const current = task
    await action(async () => {
      const allowed = current.items.filter((item) => selectedResults.includes(item.id) && item.sourceChanged).map((item) => item.id)
      const result = await callbacks.current.onApply(current.id, selectedResults, allowed)
      if (alive.current) { setNotice(result.notice); setApplied((previous) => [...new Set([...previous, ...selectedResults])]); setSelectedResults([]) }
    })
  }
  const chosenCount = localImages.filter((image) => selectedImages.includes(image.id)).length
  const currentItem = task?.items.find((item) => item.status === 'uploading') ?? task?.items.find((item) => item.status === 'freezing')
  const progressMessage = task?.status === 'cancelled' ? t('已取消；成功结果保留供检查。') : task?.status === 'complete' ? t('上传任务完成，请逐项选择要应用的结果。') : currentItem ? t(currentItem.status === 'freezing' ? '正在冻结 {value1}…' : '正在上传 {value1}…', { value1: currentItem.name }) : t('上传进行中…')
  const completed = task?.items.filter((item) => ['success', 'failed', 'cancelled'].includes(item.status)).length ?? 0
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id]
  return <Modal title={t("图片上传")} onClose={busy ? undefined : onClose} footer={<><span className="image-uploader__footer-note">{t("本地原件保留 · 应用 URL 可通过文档撤销")}</span><button type="button" disabled={busy} onClick={onClose}>{running ? t("关闭面板（上传继续）") : t("完成")}</button></>}>
    <div className="image-uploader" aria-busy={locked}>
      <div className="image-uploader__intro"><Icon name="image" size={23} /><div><strong>{documentName}</strong><p>{t("选择本机上传器，把图片上传后逐项检查，再应用到文档。")}</p></div></div>
      {error ? <p className="image-uploader__message image-uploader__message--error" role="alert">{error}</p> : null}
      {notice ? <p className="image-uploader__message" role="status">{notice}</p> : null}
      <details className="image-uploader__configuration" open={!settings?.executablePath || undefined}>
        <summary>{t("本机上传器设置")} <span>{settings?.executablePath ? t("已配置") : t("尚未配置")}</span></summary>
        <div className="image-uploader__settings">
          <label className="image-uploader__program">{t("上传程序")}<code>{settings?.executablePath ?? t("请通过本机文件选择器选择 PicGo、PicList 或其他 CLI 程序。")}</code></label>
          <div className="image-uploader__buttons"><button type="button" disabled={locked || !settings} onClick={() => void action(async () => { const value = await callbacks.current.onChooseExecutable(); if (value && alive.current) useSettings(value) })}>{t("选择上传程序…")}</button>{props.onResetExecutable && settings?.executablePath ? <button type="button" disabled={locked} onClick={() => void action(async () => { const value = await callbacks.current.onResetExecutable!(); if (alive.current) useSettings(value) })}>{t("清除程序选择")}</button> : null}</div>
          <div className="image-uploader__settings-row"><label>{t("命令预设")}<select aria-label={t("命令预设")} disabled={locked} value={adapter} onChange={(event) => { const value = event.target.value as ImageUploaderSettings['adapter']; setAdapter(value); if (value !== 'custom') setArgumentsText('[\n  "upload",\n  "{file}"\n]') }}><option value="picgo">PicGo</option><option value="piclist">PicList</option><option value="custom">{t("自定义 CLI")}</option></select></label><label>{t("单图超时（秒）")}<input aria-label={t("单图超时（秒）")} type="number" min={5} max={300} disabled={locked} value={timeout} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></label></div>
          <label>{t("参数数组（JSON）")}<textarea aria-label={t("参数数组（JSON）")} disabled={locked} spellCheck={false} rows={4} value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} /></label>
          <p className="image-uploader__hint">{t("每项是独立参数，{file} 替换为当前图片的冻结副本路径。Windows 的 .cmd/.bat 不能直接使用；Node CLI 请选 node.exe，并把脚本路径作为首个参数。") }</p>
          <p className="image-uploader__hint">{t("PicGo / PicList 预设使用 upload {file}。上传服务、账户和凭证请在对应上传器中设置。选择程序、保存设置和打开此窗口都不会上传。") }</p>
          <button type="button" className="image-uploader__primary" disabled={locked || !settings || !dirty} onClick={() => void saveSettings()}>{t("保存上传器设置")}</button>
        </div>
      </details>
      <section className="image-uploader__section" aria-label={t("选择本地图片")}>
        <div className="image-uploader__section-header"><h3>{t("选择本地图片")} <span>{chosenCount} / {localImages.length}</span></h3><button type="button" disabled={locked || !localImages.length} onClick={() => setSelectedImages(chosenCount === Math.min(localImages.length, 100) ? [] : localImages.slice(0, 100).map((image) => image.id))}>{chosenCount === Math.min(localImages.length, 100) ? t("取消全选") : t("全选")}</button></div>
        <div className="image-uploader__list">{!localImages.length ? <p className="image-uploader__empty">{t("当前文档没有可上传的本地图片。远程图片、缺失资源和越界路径不会上传。")}</p> : localImages.map((image) => <label className="image-uploader__image" key={image.id}><input type="checkbox" disabled={locked || (!selectedImages.includes(image.id) && chosenCount >= 100)} checked={selectedImages.includes(image.id)} onChange={() => setSelectedImages((values) => toggle(values, image.id))} /><Icon name="image" size={18} /><span><strong>{image.name}</strong><small>{t(sizeLabel(image.size))} · {t("{count} 处引用", { count: image.references })}</small></span></label>)}</div>
        <div className="image-uploader__upload-row"><p className="image-uploader__hint">{t("仅上传当前文档引用的已授权图片。单图最多 25 MB，每批最多 100 张、256 MB。原图发生变化会停止该项或要求重新检查。")}</p><button type="button" className="image-uploader__primary" disabled={locked || !settings?.executablePath || dirty || !chosenCount} onClick={() => void upload()}>{t("上传所选图片")}</button>{uploading && !task ? <button type="button" onClick={() => callbacks.current.onCancel()}>{t("取消上传")}</button> : null}</div>
        {dirty ? <p className="image-uploader__hint">{t("参数尚未保存，请先保存设置再开始上传。")}</p> : null}
      </section>
      {task ? <section className="image-uploader__section" aria-label={t("上传结果")}>
        <div className="image-uploader__section-header"><h3>{t("上传结果")} <span>{completed} / {task.items.length}</span></h3>{running ? <button type="button" onClick={() => callbacks.current.onCancel()}>{t("取消上传")}</button> : <button type="button" disabled={busy} onClick={() => void action(async () => { const latest = await callbacks.current.onGetTask(task.id); if (alive.current) { receiveTask(latest); setSelectedResults((values) => values.filter((id) => latest?.items.some((item) => item.id === id && !item.sourceChanged))) } })}>{t("刷新原图检查")}</button>}</div>
        <progress aria-label={t("上传进度")} value={completed} max={task.items.length} /><p className="image-uploader__hint" role="status">{progressMessage || (task.status === 'running' ? t("上传进行中…") : t("逐项检查成功 URL；失败和取消项不会修改文档。"))}</p>
        <div className="image-uploader__results">{task.items.map((item) => <div className={`image-uploader__result image-uploader__result--${item.status}`} key={item.id}><label><input type="checkbox" aria-label={t("应用 {value1} 的上传结果", { value1: item.name })} disabled={locked || item.status !== 'success' || applied.includes(item.id)} checked={selectedResults.includes(item.id)} onChange={() => setSelectedResults((values) => toggle(values, item.id))} /><strong>{item.name}</strong><span>{applied.includes(item.id) ? t("已应用") : t(STATUS[item.status])}</span></label>{item.url ? <code>{item.url}</code> : null}{item.error ? <p className="image-uploader__error">{translateMessage(locale, item.error)}</p> : null}{item.sourceChanged ? <p className="image-uploader__warning">{t("原图已改变。勾选此项表示明确使用上传时的冻结版本；当前本地原件仍保留。")}</p> : null}</div>)}</div>
        {!running ? <div className="image-uploader__upload-row"><p className="image-uploader__hint">{t("仅应用你勾选的成功结果，替换当前文档全部对应图片引用。共享的普通文档链接保持原地址。")}</p><button type="button" className="image-uploader__primary" disabled={locked || !selectedResults.length} onClick={() => void apply()}>{t("应用所选 URL（{count}）", { count: selectedResults.length })}</button></div> : null}
      </section> : null}
    </div>
  </Modal>
}
