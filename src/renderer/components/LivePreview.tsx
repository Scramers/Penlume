import { useLocalization, useLocalizedState } from '../localization'
import { useEffect, useRef, useState } from 'react'
import type { Preferences } from '../../shared/preferences'
import { renderDocumentHtml } from '../export-document'
import { renderMermaidForExport } from '../mermaid-preview'
import { Icon } from './Icon'

export function LivePreview({ markdown, title, sourcePath, preferences, onLink }: { markdown: string; title: string; sourcePath: string | null; preferences: Preferences; onLink: (href: string) => void }) {
  const { t } = useLocalization()
  const [html, setHtml] = useState(''), [error, setError] = useLocalizedState(null), [rendering, setRendering] = useState(true)
  const frame = useRef<HTMLIFrameElement>(null)
  const lastScroll = useRef(0)
  useEffect(() => {
    let canceled = false
    setRendering(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        let rendered = await renderDocumentHtml(markdown, title, { preferences, customCss: preferences.customCss })
        rendered = rendered.replace('</head>', '<style data-preview-layout>body { padding: 24px 24px 72px; box-sizing: border-box; } body > :first-child { margin-top: 0; } @media (max-height: 260px) { body { padding: 16px 20px 48px; } body > h1:first-child { font-size: 1.65em; } }</style></head>')
        if (canceled) return
        rendered = await renderMermaidForExport(rendered)
        if (canceled) return
        rendered = await window.ttypora.preparePreview({ html: rendered, markdown, sourcePath, suggestedName: 'preview.html' })
        if (!canceled) { lastScroll.current = frame.current?.contentWindow?.scrollY ?? 0; setHtml(rendered); setError(null); setRendering(false) }
      })().catch((reason) => { if (!canceled) { setError(String(reason)); setRendering(false) } })
    }, 350)
    return () => { canceled = true; clearTimeout(timer) }
  }, [markdown, title, sourcePath, preferences])
  return <aside className="live-preview" aria-label={t("实时预览")}><header className="pane-header"><span><Icon name="eye" size={14} />{t("实时预览")}</span><small>{rendering ? t("更新中…") : t("已同步")}</small></header>
    {error ? <p role="alert" className="preview-error">{t("预览失败：{error}", { error })}</p> : null}
    <iframe ref={frame} title={t("Markdown 实时预览")} sandbox="allow-same-origin" srcDoc={html || '<!doctype html><html><body></body></html>'} onLoad={() => {
      frame.current?.contentWindow?.scrollTo(0, lastScroll.current)
      frame.current?.contentDocument?.addEventListener('click', (event) => {
        const anchor = (event.target as Element).closest('a[href]')
        const href = anchor?.getAttribute('href')
        if (href && !href.startsWith('#')) { event.preventDefault(); onLink(href) }
      })
    }} />
  </aside>
}
