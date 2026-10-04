import { useEffect, useId, useState } from 'react'

interface Props {
  label: string
  value: number
  min: number
  max: number
  step?: number
  integer?: boolean
  description?: string
  unit?: string
  onChange: (value: number) => void
}

export function NumberSetting({ label, value, min, max, step = 1, integer = false, description, unit, onChange }: Props) {
  const id = useId()
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const parsed = draft.trim() === '' ? NaN : Number(draft)
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, integer ? Math.round(parsed) : parsed)) : value
    setDraft(String(next))
    if (next !== value) onChange(next)
  }
  return <div className="setting-row"><div className="setting-copy"><label htmlFor={id}>{label}</label>
    {description ? <p id={`${id}-help`} className="setting-description">{description}</p> : null}
  </div><div className="setting-number"><input id={id} aria-describedby={`${description ? `${id}-help ` : ''}${id}-range`} type="number" min={min} max={max} step={step} value={draft}
    onChange={(event) => setDraft(event.currentTarget.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }}
  />{unit ? <span className="setting-unit" aria-hidden="true">{unit}</span> : null}<span id={`${id}-range`} className="setting-range">{min}–{max}{unit ? ` ${unit}` : ''}</span></div></div>
}
