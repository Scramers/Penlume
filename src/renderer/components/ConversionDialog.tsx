import { translateMessage } from '../../shared/localization'
import { useLocalization, useLocalizedState, localized } from '../localization'
import { useEffect, useRef, useState } from 'react'
import { pandocFormats, pandocOptionsSchema, type PandocExportRequest, type PandocFormat, type PandocOptions, type PandocStatus } from '../../shared/pandoc'
import type { DocumentSnapshot } from '../../shared/contracts'
import { Modal } from './Modal'
import { Icon } from './Icon'
import '../conversion.css'

interface Props { documentName: string; getRequest: () => Omit<PandocExportRequest, 'format' | 'options'>; onImported: (snapshot: DocumentSnapshot) => void; onClose: () => void }
export function ConversionDialog({ documentName, getRequest, onImported, onClose }: Props) {
  const { t, locale } = useLocalization()
  const [status, setStatus] = useState<PandocStatus | null>(null)
  const [format, setFormat] = useState<PandocFormat>('docx')
  const [options, setOptions] = useState<PandocOptions>(() => { try { return pandocOptionsSchema.parse(JSON.parse(localStorage.getItem('ttypora.conversionOptions') ?? '{}')) } catch { return pandocOptionsSchema.parse({}) } })
  const [argumentsText, setArgumentsText] = useState(options.extraArgs.join('\n'))
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(true)
  const [message, setMessage] = useLocalizedState(''), [warnings, setWarnings] = useState(''), [error, setError] = useLocalizedState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; void refresh(); const unsubscribe = window.ttypora.onPandocProgress((progress) => setMessage(progress.message)); return () => { alive.current = false; unsubscribe() } }, [])
  async function refresh() { setChecking(true); try { const next = await window.ttypora.pandocStatus(); if (alive.current) setStatus(next) } catch (failure) { if (alive.current) setError(String(failure)) } finally { if (alive.current) setChecking(false) } }
  async function engineAction(action: () => Promise<PandocStatus | null>) { setChecking(true); setError(''); try { const next = await action(); if (next && alive.current) setStatus(next) } catch (failure) { if (alive.current) setError(String(failure)) } finally { if (alive.current) setChecking(false) } }
  async function convert(direction: 'export' | 'import') {
    if (busy) return
    setBusy(true); setError(''); setWarnings(''); setMessage(direction === 'export' ? localized("选择输出位置…") : localized("选择导入文档…"))
    try {
      const input = getRequest(), configured = pandocOptionsSchema.parse({ ...options, extraArgs: argumentsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) })
      localStorage.setItem('ttypora.conversionOptions', JSON.stringify(configured))
      const result = direction === 'export' ? await window.ttypora.pandocExport({ ...input, format, options: configured }) : await window.ttypora.pandocImport(input.excludedPaths)
      if (!alive.current) return
      if (!result) { setMessage('已取消'); return }
      setMessage(localized(direction === 'export' ? "已导出：{value1}" : "已导入：{value1}", { value1: result.path })); setWarnings(result.warnings)
      if (result.snapshot) onImported(result.snapshot)
    } catch (failure) { if (alive.current) { setError(failure instanceof Error ? failure.message : String(failure)); setMessage('') } }
    finally { if (alive.current) setBusy(false) }
  }
  const update = <K extends keyof PandocOptions>(key: K, value: PandocOptions[K]) => setOptions((current) => ({ ...current, [key]: value }))
  return <Modal title={t("文档转换")} onClose={busy ? undefined : onClose} footer={<><button onClick={onClose} disabled={busy}>{t("关闭")}</button>{busy ? <button onClick={() => { window.ttypora.cancelPandoc(); setMessage('正在取消转换…') }}>{t("取消转换")}</button> : <button className="button--primary" disabled={!status?.available || checking} onClick={() => void convert('export')}><Icon name="export" size={16} />{t("导出文档")}</button>}</>}>
    <div className="conversion-dialog">
      <div className="conversion-dialog__intro"><span className="conversion-dialog__icon"><Icon name="export" size={25} /></span><div><h3>{t("把创作带到更多地方")}</h3><p>{t("将「{name}」转换为 Word、电子书或排版源码，也可导入已有文档。", { name: documentName })}</p></div></div>
      <div className={`conversion-engine${status?.available ? ' conversion-engine--ready' : ''}`}><div><strong>{checking ? t("正在检查转换引擎…") : status?.version ?? t("转换引擎尚未就绪")}</strong><small>{status?.available ? ({ bundled: t("随应用提供 · 可离线使用"), configured: t("使用选定程序"), system: t("使用系统程序") }[status.source ?? 'system']) : translateMessage(locale, status?.message ?? '')}</small></div><button onClick={() => void refresh()} disabled={busy || checking}>{t("重新检测")}</button></div>
      <label className="conversion-dialog__label">{t("输出格式")}<select aria-label={t("输出格式")} value={format} onChange={(event) => setFormat(event.target.value as PandocFormat)} disabled={busy}>{pandocFormats.map((item) => <option key={item.id} value={item.id}>{t("{name}（.{extension}）", { name: t(item.label), extension: item.extension })}</option>)}</select><small>{t(pandocFormats.find((item) => item.id === format)?.detail ?? '')}</small></label>
      <div className="conversion-options"><label><input type="checkbox" checked={options.toc} onChange={(event) => update('toc', event.target.checked)} disabled={busy} />{t("生成目录")}</label><label><input type="checkbox" checked={options.numberedSections} onChange={(event) => update('numberedSections', event.target.checked)} disabled={busy} />{t("章节编号")}</label><label><input type="checkbox" checked={options.standalone} onChange={(event) => update('standalone', event.target.checked)} disabled={busy} />{t("完整独立文档")}</label></div>
      {format === 'docx' ? <div className="conversion-reference"><label><input type="checkbox" checked={options.useReferenceDocument} onChange={(event) => update('useReferenceDocument', event.target.checked)} disabled={busy} />{t("使用 Word 参考样式")}</label><button disabled={busy || checking} onClick={() => void engineAction(() => window.ttypora.choosePandocReference())}>{t("选择参考文档")}</button>{status?.settings.referenceDocumentPath ? <small title={status.settings.referenceDocumentPath}>{status.settings.referenceDocumentPath}</small> : null}</div> : null}
      <div className="conversion-import"><div><strong>{t("导入已有文档")}</strong><p>{t("选择 Word、ODT、EPUB、HTML、LaTeX 等文件，另存为 Markdown，保留原文件和提取图片。")}</p></div><button disabled={!status?.available || busy || checking} onClick={() => void convert('import')}>{t("选择并导入…")}</button></div>
      <details className="conversion-advanced"><summary>{t("高级设置")}</summary><div><label className="conversion-dialog__label">{t("附加转换选项（每行一个）")}<textarea aria-label={t("附加转换选项")} value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} placeholder={'--toc-depth=3\n--wrap=none\n--highlight-style=zenburn'} disabled={busy} rows={4} /></label><small>{t("支持目录深度、标题层级、换行与代码配色；输入输出路径由文件选择框指定。")}</small><label className="conversion-dialog__label">{t("转换超时（秒）")}<input type="number" min={10} max={300} aria-label={t("转换超时")} key={status?.settings.timeoutSeconds ?? 90} defaultValue={status?.settings.timeoutSeconds ?? 90} onBlur={(event) => { const seconds = Number(event.target.value); if (seconds >= 10 && seconds <= 300 && Number.isInteger(seconds)) void engineAction(() => window.ttypora.configurePandocTimeout(seconds)) }} disabled={busy} /></label><div className="conversion-engine-actions"><button disabled={busy || checking} onClick={() => void engineAction(() => window.ttypora.choosePandocExecutable())}>{t("选择 Pandoc 程序")}</button><button disabled={busy || checking || !status?.settings.executablePath} onClick={() => void engineAction(() => window.ttypora.resetPandocExecutable())}>{t("恢复自动检测")}</button></div>{status?.executablePath ? <small className="conversion-engine-path">{status.executablePath}</small> : null}</div></details>
      {message ? <p className="conversion-status" role="status" aria-live="polite">{busy ? <span className="conversion-spinner" /> : <Icon name="check" size={16} />}{message}</p> : null}
      {warnings ? <details className="conversion-warnings" open><summary>{t("转换提示")}</summary><pre>{warnings.split(/\r?\n/).map((warning) => translateMessage(locale, warning)).join('\n')}</pre></details> : null}
      {error ? <p className="conversion-error" role="alert">{error}</p> : null}
    </div>
  </Modal>
}
