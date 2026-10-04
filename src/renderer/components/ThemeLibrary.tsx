import { localizedThemeName, translate, translateMessage, type InterfaceLanguage } from '../../shared/localization'
import { useLocalization, useLocalizedState, localized } from '../localization'
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { adaptThemeCss, BUILT_IN_THEMES, THEME_CSS_MAX_BYTES, THEME_LIBRARY_MAX_THEMES, type ThemeAppearance, type ThemeInput, type WritingTheme } from '../../shared/theme-library'
import type { ThemeLibraryController } from '../theme-library'
import { Icon } from './Icon'
import { Modal } from './Modal'
import '../theme-library.css'

interface Props { library: ThemeLibraryController; appearance: ThemeAppearance; onClose: () => void }
interface ThemeDraft extends ThemeInput { id?: string; readOnly?: boolean }
const appearanceKey = (appearance: ThemeAppearance) => appearance === 'light' ? '浅色' : '深色'

export function themePreviewHtml(css: string, compact = false, appearance: ThemeAppearance = 'light', locale: InterfaceLanguage = 'zh-CN'): string {
  const baseCss = adaptThemeCss(BUILT_IN_THEMES.find((theme) => theme.appearance === appearance)!.css, 'export')
  const e = (key: string) => translate(locale, key).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const sample = compact ? `<p><a href="#">${e('今日灵感')}</a> · <code>Markdown</code></p>` : `<h2>${e('一份清晰的创作空间')}</h2><p>${e('正文、')}<strong>${e('强调')}</strong>${e('、')}<em>${e('想法')}</em>${e('与')}<a href="#">${e('参考链接')}</a>${e('，在恰好的层次中相遇。')}</p><pre><code>const inspiration = "${e('开始写作')}";</code></pre><table><tr><th>${e('章节')}</th><th>${e('进度')}</th></tr><tr><td>${e('新的故事')}</td><td>${e('正在发生')}</td></tr></table>`
  const safeCss = `${baseCss}\n${adaptThemeCss(css, 'export')}`.replaceAll('<', '\\3c ')
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>html{overflow:hidden}body{margin:0;padding:${compact ? '14px 19px' : '28px 36px'};font:${compact ? '9' : '13'}px/1.75 Georgia,"Songti SC",serif;overflow-wrap:anywhere;background:#fff;color:#273147}h1,h2{font-family:system-ui,"Microsoft YaHei",sans-serif;line-height:1.4}h1{font-size:1.9em;margin:0 0 .7em}h2{font-size:1.25em;margin:.8em 0 .3em}p{margin:.5em 0}a{color:#5965d9}blockquote{margin:.75em 0;padding:.25em 1em;border-left:3px solid #5965d9;color:#737f94}code{font-family:Consolas,monospace}pre{padding:12px;background:#eceefe;border-radius:7px}table{width:100%;border-collapse:collapse}th,td{padding:5px 8px;border:1px solid #dde3ee}${safeCss}</style></head><body><h1>${e('给文字一处风景')}</h1><p>${e('让灵感落在纸上，保持专注，写下你的故事。')}</p><blockquote>${e('好文字，也值得被好好看见。')}</blockquote>${sample}</body></html>`
}

export function ThemeLibrary({ library, appearance, onClose }: Props) {
  const { t, locale } = useLocalization()
  const label = (mode: ThemeAppearance) => t(appearanceKey(mode))
  const themeName = (theme: WritingTheme) => localizedThemeName(locale, theme)
  const themeText = (theme: WritingTheme) => theme.builtIn ? localized(theme.name) : theme.name
  const [browseMode, setBrowseMode] = useState<ThemeAppearance>(appearance)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'builtin' | 'custom'>('all')
  const [focusedId, setFocusedId] = useState(library.selected(appearance).id)
  const [draft, setDraft] = useState<ThemeDraft | null>(null)
  const [error, setError] = useLocalizedState(null)
  const [message, setMessage] = useLocalizedState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const themes = useMemo(() => library.themes.filter((theme) => theme.appearance === browseMode && (filter !== 'builtin' || theme.builtIn) && (filter !== 'custom' || !theme.builtIn) && `${themeName(theme)} ${theme.builtIn ? t(theme.description) : theme.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [library.themes, browseMode, filter, query, locale])
  const focused = library.themes.find((theme) => theme.id === focusedId && theme.appearance === browseMode) ?? themes[0] ?? library.selected(browseMode)
  const selected = library.selected(browseMode)
  const tryAction = (action: () => void) => { try { action(); setError(null) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } }
  const switchMode = (next: ThemeAppearance) => { setBrowseMode(next); setFocusedId(library.selected(next).id); setDraft(null); setDeleteId(null) }
  const duplicate = (theme: WritingTheme) => tryAction(() => { const created = library.duplicate(theme.id); setFocusedId(created.id); setFilter('all'); setQuery(''); setDraft({ ...created }); setMessage(localized("已复制「{value1}」，可自由修改。", { value1: themeText(theme) })) })
  const saveDraft = () => {
    if (!draft || draft.readOnly) return
    tryAction(() => {
      const result = draft.id ? library.update(draft.id, draft) : library.add(draft)
      setDraft(null); setBrowseMode(result.theme.appearance); setFocusedId(result.theme.id); setQuery(''); setFilter('all')
      setMessage(result.removedResources ? localized("主题已保存；已移除 {value1} 处外部资源引用。", { value1: result.removedResources }) : localized("主题已保存。"))
    })
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    try {
      if (!/\.css$/i.test(file.name)) throw new Error(t("请选择 .css 主题文件。"))
      if (file.size > THEME_CSS_MAX_BYTES) throw new Error(t("主题 CSS 不能超过 100 KB。"))
      const css = await file.text()
      const result = library.add({ name: file.name.replace(/\.css$/i, '').slice(0, 56) || t('导入主题'), css, appearance: browseMode, description: t('从本地 CSS 文件导入') })
      setFocusedId(result.theme.id); setFilter('all'); setQuery(''); setDraft({ ...result.theme }); setError(null)
      setMessage(result.removedResources ? localized("已导入；已移除 {value1} 处外部资源引用。保存后即可应用。", { value1: result.removedResources }) : localized("已导入主题，可调整名称和明暗归属。"))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (fileInput.current) fileInput.current.value = '' }
  }
  const exportCss = (theme: WritingTheme) => {
    const url = URL.createObjectURL(new Blob([theme.css], { type: 'text/css;charset=utf-8' }))
    const link = window.document.createElement('a'); link.href = url; link.download = `${theme.name.replace(/[<>:"/\\|?*]/g, '-')}.css`; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <Modal title={t("主题工坊")} onClose={onClose} footer={<><span className="theme-library__footer-note">{t("{count} / {limit} 个自定义主题 · 保存在本机", { count: library.state.userThemes.length, limit: THEME_LIBRARY_MAX_THEMES })}</span><button className="button--primary" onClick={onClose}>{t("完成")}</button></>}>
    <div className="theme-library">
      <div className="theme-library__intro"><div><span className="theme-library__eyebrow">YOUR WRITING, YOUR ATMOSPHERE</span><h3>{t("为每次创作，选择一种氛围。")}</h3><p>{t("浅色和深色分别记住你的选择。内置主题原创设计，也可导入熟悉的 Markdown CSS。")}</p></div><span className="theme-library__count">{library.themes.length}<small>{t("款主题")}</small></span></div>
      {library.storageError ? <p className="theme-library__error" role="alert">{translateMessage(locale, library.storageError)}</p> : null}
      {error ? <p className="theme-library__error" role="alert">{error}</p> : null}
      {message ? <p className="theme-library__message" role="status">{message}</p> : null}
      <div className="theme-library__controls"><div className="theme-library__segmented" aria-label={t("主题明暗分类")}>{(['light', 'dark'] as const).map((mode) => <button key={mode} aria-pressed={browseMode === mode} onClick={() => switchMode(mode)}><Icon name={mode === 'light' ? 'sun' : 'eye'} size={15} />{label(mode)}</button>)}</div><label className="theme-library__search"><Icon name="search" size={15} /><input aria-label={t("搜索主题")} placeholder={t("搜索名称或风格")} value={query} onChange={(event) => setQuery(event.target.value)} /></label><input type="file" accept=".css,text/css" aria-label={t("导入 CSS 主题文件")} className="theme-library__file" ref={fileInput} onChange={(event) => { void importFile(event.target.files?.[0]) }} /><button className="theme-library__import" onClick={() => fileInput.current?.click()}><Icon name="plus" size={15} />{t("导入 CSS")}</button></div>
      {draft ? <section className="theme-library__editor" aria-label={draft.readOnly ? t("查看内置主题") : t("编辑主题")}><div className="theme-library__editor-top"><h4>{draft.readOnly ? t("查看「{value1}」", { value1: draft.readOnly && draft.id ? localizedThemeName(locale, { id: draft.id, name: draft.name, builtIn: true }) : draft.name }) : draft.id ? t("编辑自定义主题") : t("新建主题")}</h4><button onClick={() => setDraft(null)} aria-label={t("关闭主题编辑")}><Icon name="close" size={16} /></button></div><div className="theme-library__editor-columns"><div className="theme-library__fields"><div className="theme-library__field-row"><label>{t("主题名称")}<input aria-label={t("主题名称")} maxLength={56} readOnly={draft.readOnly} value={draft.readOnly && draft.id ? localizedThemeName(locale, { id: draft.id, name: draft.name, builtIn: true }) : draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>{t("适用模式")}<select aria-label={t("主题适用模式")} disabled={draft.readOnly} value={draft.appearance} onChange={(event) => setDraft({ ...draft, appearance: event.target.value as ThemeAppearance })}><option value="light">{t("浅色")}</option><option value="dark">{t("深色")}</option></select></label></div><label>{t("简介")}<input aria-label={t("主题简介")} maxLength={200} readOnly={draft.readOnly} value={draft.readOnly ? t(draft.description ?? '') : draft.description ?? ''} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label>CSS<textarea aria-label={t("主题 CSS")} spellCheck={false} rows={13} maxLength={THEME_CSS_MAX_BYTES} readOnly={draft.readOnly} value={draft.css} onChange={(event) => setDraft({ ...draft, css: event.target.value })} /></label><p className="theme-library__css-hint">{t("支持 #write、.milkdown、.ProseMirror 选择器。外部资源会自动过滤，内嵌图片和字体可保留。原偏好设置中的自定义 CSS 继续作为最后一层叠加。")}</p></div><div className="theme-library__draft-preview"><span>{t("实时预览")}</span><iframe title={t("主题编辑实时预览")} sandbox="" srcDoc={safeThemePreview(draft.css, draft.appearance, locale)} /></div></div><div className="theme-library__editor-actions"><button onClick={() => setDraft(null)}>{draft.readOnly ? t("返回主题库") : t("取消编辑")}</button>{draft.readOnly && draft.id ? <button className="button--primary" onClick={() => duplicate(focused)}>{t("复制后编辑")}</button> : <button className="button--primary" onClick={saveDraft}>{t("保存主题")}</button>}</div></section> : <><div className="theme-library__filters"><div>{([['all', t("全部")], ['builtin', t("内置")], ['custom', t('我的主题')]] as const).map(([value, name]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{name}</button>)}</div><button onClick={() => { setDraft({ name: t('新主题'), appearance: browseMode, css: '#write h1 { color: #5965d9; }', description: '' }); setError(null) }}>{t("新建主题")}</button></div><div className="theme-library__workspace"><div className="theme-library__grid" aria-label={t("{value1}主题列表", { value1: label(browseMode) })}>{themes.map((theme) => <button key={theme.id} className={`theme-card${focused.id === theme.id ? ' theme-card--focused' : ''}`} onClick={() => { setFocusedId(theme.id); setDeleteId(null) }} aria-label={t("预览主题 {value1}", { value1: themeName(theme) })} style={{ '--theme-card-accent': theme.palette.accent } as CSSProperties}><div className="theme-card__preview"><iframe title={t("{value1}主题缩略预览", { value1: themeName(theme) })} sandbox="" tabIndex={-1} srcDoc={themePreviewHtml(theme.css, true, theme.appearance, locale)} loading="lazy" /></div><div className="theme-card__caption"><strong>{themeName(theme)}</strong><span>{theme.id === selected.id ? <><Icon name="check" size={12} />{t("已选")}</> : theme.builtIn ? t("内置") : t("自定义")}</span></div><div className="theme-card__swatches">{[theme.palette.background, theme.palette.text, theme.palette.accent, theme.palette.soft].map((color, i) => <i key={i} style={{ background: color }} />)}</div></button>)}{!themes.length ? <p className="theme-library__empty">{t("没有匹配的主题。试试其他分类，或导入自己的 CSS。")}</p> : null}</div><aside className="theme-library__detail"><div className="theme-library__detail-heading"><span>{focused.builtIn ? t("原创内置主题") : t("我的自定义主题")}</span><h4>{themeName(focused)}</h4><p>{(focused.builtIn ? t(focused.description) : focused.description) || t("用自己的色彩与字体，定制独特的写作环境。")}</p></div><iframe className="theme-library__detail-preview" title={t("{value1}主题详细预览", { value1: themeName(focused) })} sandbox="" tabIndex={-1} srcDoc={themePreviewHtml(focused.css, false, focused.appearance, locale)} /><button className="button--primary theme-library__apply" onClick={() => tryAction(() => { library.select(browseMode, focused.id); setMessage(appearance === browseMode ? localized("已应用「{value1}」。", { value1: themeText(focused) }) : localized("已设为{value1}主题，切换到{value2}模式时生效。", { value1: localized(appearanceKey(browseMode)), value2: localized(appearanceKey(browseMode)) })) })} disabled={selected.id === focused.id}>{selected.id === focused.id ? t("当前{value1}主题", { value1: label(browseMode) }) : t("设为{value1}主题", { value1: label(browseMode) })}</button><div className="theme-library__detail-actions"><button onClick={() => { setDraft({ ...focused, readOnly: focused.builtIn }); setError(null) }}>{focused.builtIn ? t("查看 CSS") : t("编辑 / 重命名")}</button><button onClick={() => duplicate(focused)}>{t("复制")}</button><button onClick={() => exportCss(focused)}>{t("导出 CSS")}</button>{!focused.builtIn ? <button className="button--danger" onClick={() => setDeleteId(focused.id)}>{t("删除")}</button> : null}</div>{deleteId === focused.id ? <div className="theme-library__delete" role="alert"><p>{t("删除「{name}」？当前选中的主题会恢复为默认主题。", { name: themeName(focused) })}</p><button onClick={() => setDeleteId(null)}>{t("保留")}</button><button className="button--danger" onClick={() => tryAction(() => { library.remove(focused.id); setDeleteId(null); setFocusedId(''); setMessage('主题已删除。') })}>{t("确认删除")}</button></div> : null}</aside></div></>}
    </div>
  </Modal>
}

function safeThemePreview(css: string, appearance: ThemeAppearance, locale: InterfaceLanguage): string { try { return themePreviewHtml(css, false, appearance, locale) } catch { return `<!doctype html><html><body>${translate(locale, 'CSS 超过 100 KB，缩小后可预览。')}</body></html>` } }


