import { useLocalization } from '../localization'
import { useEffect, useId, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose?: () => void
}

export function Modal({ title, children, footer, onClose }: ModalProps) {
  const { t } = useLocalization()
  const titleId = useId()
  const root = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = root.current
    const focusable = () => Array.from(element?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter((item) => item.offsetParent !== null)
    ;(element?.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? element)?.focus()
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && close.current) { event.preventDefault(); event.stopPropagation(); close.current() }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0], last = items[items.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    element?.addEventListener('keydown', handle)
    return () => { element?.removeEventListener('keydown', handle); previous?.focus() }
  }, [])
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="modal"
        role="dialog"
        ref={root}
        tabIndex={-1}
      >
        <header className="modal__header">
          <h2 id={titleId}>{title}</h2>
          {onClose ? (
            <button
              aria-label={t("关闭")}
              className="icon-button"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          ) : null}
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </section>
    </div>
  )
}
