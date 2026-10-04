import { useEffect, useRef, useState } from 'react'
import { clampSize } from '../workspace-layout'

interface Props {
  label: string
  value: number
  min: number
  max: number
  resetValue: number
  step?: number
  pixelsPerUnit?: number
  orientation?: 'vertical' | 'horizontal'
  onChange: (value: number) => void
}

export function ResizeHandle({ label, value, min, max, resetValue, step = 10, pixelsPerUnit = 1, orientation = 'vertical', onChange }: Props) {
  const drag = useRef<{ start: number; value: number; scale: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => { drag.current = null; setDragging(false) }, [orientation])
  useEffect(() => {
    if (!dragging) return
    const cancel = () => { if (drag.current) latest.current(drag.current.value); drag.current = null; setDragging(false) }
    document.body.classList.add(`resizing-${orientation}`)
    window.addEventListener('blur', cancel)
    return () => { document.body.classList.remove(`resizing-${orientation}`); window.removeEventListener('blur', cancel) }
  }, [dragging, orientation])
  return <div className={`resize-handle resize-handle--${orientation}`} role="separator" tabIndex={0}
    aria-label={label} title={label} aria-orientation={orientation} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)}
    onDoubleClick={() => onChange(clampSize(resetValue, min, max))}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { start: orientation === 'vertical' ? event.clientX : event.clientY, value, scale: Math.max(0.01, pixelsPerUnit) }
      setDragging(true)
    }} onPointerMove={(event) => {
      if (!drag.current) return
      const position = orientation === 'vertical' ? event.clientX : event.clientY
      onChange(clampSize(drag.current.value + (position - drag.current.start) / drag.current.scale, min, max))
    }} onPointerUp={() => { drag.current = null; setDragging(false) }}
    onPointerCancel={() => { if (drag.current) onChange(drag.current.value); drag.current = null; setDragging(false) }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && drag.current) { onChange(drag.current.value); drag.current = null; setDragging(false); event.preventDefault(); return }
      const less = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
      const more = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
      if (![less, more, 'Home', 'End', 'Enter'].includes(event.key)) return
      event.preventDefault()
      onChange(clampSize(event.key === 'Home' ? min : event.key === 'End' ? max : event.key === 'Enter' ? resetValue : value + (event.key === less ? -1 : 1) * step * (event.shiftKey ? 5 : 1), min, max))
    }} />
}
