import { useLocalization } from '../localization'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'

function readTarget(key: string): number {
  try { const value = Number(JSON.parse(localStorage.getItem('ttypora.writingGoals') ?? '{}')[key]); return Number.isFinite(value) ? Math.min(1000000, Math.max(0, Math.round(value))) : 0 } catch { return 0 }
}
export function useWritingGoal(key: string, documentId: string) {
  const [target, setTargetState] = useState(() => readTarget(key))
  const previous = useRef({ key, documentId })
  useEffect(() => {
    const old = previous.current
    if (old.documentId === documentId && old.key !== key) {
      try {
        const goals = JSON.parse(localStorage.getItem('ttypora.writingGoals') ?? '{}')
        if (goals[old.key]) { goals[key] = goals[old.key]; delete goals[old.key]; localStorage.setItem('ttypora.writingGoals', JSON.stringify(goals)) }
      } catch { /* invalid preferences are ignored */ }
    }
    previous.current = { key, documentId }
    setTargetState(readTarget(key))
  }, [key, documentId])
  const setTarget = useCallback((value: number) => {
    let goals: Record<string, number> = {}
    try { goals = JSON.parse(localStorage.getItem('ttypora.writingGoals') ?? '{}') } catch { /* reset corrupt preferences */ }
    const safe = Math.min(1000000, Math.max(0, Math.round(value)))
    if (safe) goals[key] = safe; else delete goals[key]
    localStorage.setItem('ttypora.writingGoals', JSON.stringify(goals)); setTargetState(safe)
  }, [key])
  return { target, setTarget }
}
export function WritingGoal({ target, words, onChange, onClose }: { target: number; words: number; onChange: (target: number) => void; onClose: () => void }) {
  const { t, locale } = useLocalization()
  const [value, setValue] = useState(target || 1000)
  const progress = target ? Math.min(100, Math.round(words / target * 100)) : 0
  return <Modal title={t("写作目标")} onClose={onClose}>
    <div className="goal-summary"><div className="goal-ring" style={{ background: `conic-gradient(var(--accent) ${progress}%, var(--border) 0)` }}><div>{target ? `${progress}%` : t("开始")}<small>{t("当前文档")}</small></div></div><div><strong>{words.toLocaleString(locale)} <small>{t("字符")}</small></strong><p>{target ? words >= target ? t("本篇目标已完成。继续记录你的想法。") : t("距离目标还有 {value1} 字符", { value1: (target - words).toLocaleString(locale) }) : t("给这一篇文章设定一个可实现的目标。")}</p></div></div>
    <form onSubmit={(event) => { event.preventDefault(); onChange(value); onClose() }}><label className="goal-input">{t("本篇文档目标（正文字符，不含空白）")}<input aria-label={t("目标字数")} type="number" min="1" max="1000000" required value={value} onChange={(event) => setValue(Number(event.target.value))} /></label><div className="goal-presets">{[500, 1000, 2000, 5000].map((preset) => <button type="button" key={preset} onClick={() => setValue(preset)}>{t("{count} 字符", { count: preset.toLocaleString(locale) })}</button>)}</div><div className="modal-actions"><button type="button" onClick={() => { onChange(0); onClose() }}>{t("清除目标")}</button><button className="button--primary" type="submit">{t("保存目标")}</button></div></form>
  </Modal>
}
