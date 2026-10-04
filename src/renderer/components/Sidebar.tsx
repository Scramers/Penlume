import { useLocalization } from '../localization'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { WorkspaceEntry, WorkspaceSnapshot } from '../../shared/contracts'
import type { MarkdownHeading } from '../../shared/markdown-outline'
import { buildOutlineTree, controlsForOutlineTree, projectActiveOutlineIndex, projectOutlineRows, type OutlineDocumentControlAction, type OutlineDocumentControls } from '../outline-controls'
import '../outline-controls.css'

export type SidebarMode = 'hidden' | 'files' | 'outline'

interface SidebarProps {
  activePath: string | null
  outlineDocumentId: string
  outlineControlState?: OutlineDocumentControls
  onOutlineControlAction: (action: OutlineDocumentControlAction) => void
  headings: MarkdownHeading[]
  activeHeadingIndex?: number | null
  outlinePending?: boolean
  outlineError?: string | null
  mode: Exclude<SidebarMode, 'hidden'>
  workspace: WorkspaceSnapshot | null
  onClose: () => void
  onHeadingClick: (heading: MarkdownHeading, index: number) => void
  onModeChange: (mode: Exclude<SidebarMode, 'hidden'>) => void
  onOpenFile: (filePath: string) => void
  onOpenWorkspace: () => void
  onRefreshWorkspace: () => void
  onManage: (filePath: string | null) => void
}

interface TreeEntryProps {
  activePath: string | null
  depth: number
  entry: WorkspaceEntry
  onOpenFile: (filePath: string) => void
  onManage: (filePath: string | null) => void
}

function TreeEntry({ activePath, depth, entry, onOpenFile, onManage }: TreeEntryProps) {
  const { t } = useLocalization()
  const [expanded, setExpanded] = useState(depth < 1)
  const style = { '--tree-indent': `${7 + depth * 15}px` } as CSSProperties

  if (entry.type === 'directory') {
    return (
      <li>
        <button
          className="tree-entry tree-entry--directory"
          onClick={() => setExpanded((current) => !current)}
          style={style}
          title={entry.path}
          type="button"
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span>{entry.name}</span>
        </button>
        {expanded ? (
          <ul>
            {entry.children?.map((child) => (
              <TreeEntry
                activePath={activePath}
                depth={depth + 1}
                entry={child}
                key={child.path}
                onOpenFile={onOpenFile}
                onManage={onManage}
              />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <li className="file-tree-row">
      <button
        className={`tree-entry tree-entry--file${activePath === entry.path ? ' tree-entry--active' : ''}`}
        onClick={() => onOpenFile(entry.path)}
        onContextMenu={(event) => { event.preventDefault(); onManage(entry.path) }}
        style={style}
        title={entry.path}
        type="button"
      >
        <span aria-hidden="true">◇</span>
        <span>{entry.name}</span>
      </button>
      <button className="file-tree-menu" aria-label={t("管理 {value1}", { value1: entry.name })} onClick={() => onManage(entry.path)}>⋯</button>
    </li>
  )
}

export function Sidebar({
  activePath,
  outlineDocumentId,
  outlineControlState,
  onOutlineControlAction,
  headings,
  activeHeadingIndex = null,
  outlinePending = false,
  outlineError = null,
  mode,
  workspace,
  onClose,
  onHeadingClick,
  onModeChange,
  onOpenFile,
  onOpenWorkspace,
  onRefreshWorkspace,
  onManage,
}: SidebarProps) {
  const { t } = useLocalization()
  const [filter, setFilter] = useState('')
  const [flat, setFlat] = useState(false)
  const [reverse, setReverse] = useState(false)
  const [headingLimit, setHeadingLimit] = useState(6)
  const tree = useMemo(() => buildOutlineTree(headings), [headings])
  const controls = useMemo(() => controlsForOutlineTree(outlineControlState, tree), [outlineControlState, tree])
  const outlineUnavailable = outlinePending || Boolean(outlineError) || !tree.valid
  const projection = useMemo(() => outlineUnavailable
    ? { rows: [], visible: new Set<number>(), searching: Boolean(controls.query.trim()), normalizedQuery: controls.query.trim().toLowerCase() }
    : projectOutlineRows(tree, controls, headingLimit), [tree, controls, headingLimit, outlineUnavailable])
  const visibleHeadingIndex = outlineUnavailable ? null : projectActiveOutlineIndex(tree, projection.visible, activeHeadingIndex)
  const owner = useMemo(() => ({ documentId: outlineDocumentId, tree, ready: !outlineUnavailable }), [outlineDocumentId, tree, outlineUnavailable])
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const view = useMemo(() => ({ owner, projection }), [owner, projection])
  const viewRef = useRef(view)
  viewRef.current = view
  const navigationRefs = useRef(new Map<number, HTMLButtonElement>())
  const rowsByIndex = useMemo(() => new Map(projection.rows.map((row) => [row.index, row])), [projection])
  useEffect(() => {
    if (owner.ready && ownerRef.current === owner) onOutlineControlAction({ type: 'reconcile', documentId: owner.documentId, tree: owner.tree })
  }, [owner, onOutlineControlAction])
  const currentView = () => owner.ready && ownerRef.current === owner && viewRef.current === view
  const controlAction = (action: OutlineDocumentControlAction) => { if (currentView()) onOutlineControlAction(action) }
  const fold = (index: number) => {
    if (!currentView() || !projection.visible.has(index) || projection.searching || controls.flat) return
    controlAction({ type: 'fold', documentId: outlineDocumentId, tree, index })
  }
  const focusParent = (index: number) => {
    const parent = projectActiveOutlineIndex(tree, projection.visible, tree.nodes[index].parent)
    if (parent !== null) navigationRefs.current.get(parent)?.focus()
  }
  const outlineKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!currentView() || !projection.visible.has(index) || projection.searching || controls.flat) return
    const row = rowsByIndex.get(index)
    if (!row) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation()
      if (row.expandable && row.expanded) fold(index)
      else focusParent(index)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation()
      if (row.expandable && !row.expanded) fold(index)
      else if (row.expanded) {
        const child = row.children.find((childIndex) => projection.visible.has(childIndex))
        if (child !== undefined) navigationRefs.current.get(child)?.focus()
      }
    }
  }
  const renderOutlineRow = (index: number, nested: boolean): ReactNode => {
    const row = rowsByIndex.get(index)
    if (!row) return null
    const label = row.heading.text || t("空标题")
    const children = nested && row.expanded ? row.children.filter((child) => projection.visible.has(child)) : []
    return (
      <li key={index} data-outline-index={index} data-outline-context={row.context ? 'true' : undefined}>
        <div className="outline-heading-row">
          {nested ? row.expandable ? (
            <button className="outline-toggle" data-outline-index={index} aria-expanded={row.expanded}
              aria-label={row.expanded ? t("折叠 {value1}", { value1: label }) : t("展开 {value1}", { value1: label })}
              disabled={outlineUnavailable || projection.searching} onClick={() => fold(index)}
              onKeyDown={(event) => outlineKeyDown(event, index)} type="button">
              <span aria-hidden="true">{row.expanded ? '▾' : '▸'}</span>
            </button>
          ) : <span className="outline-toggle-spacer" aria-hidden="true" /> : null}
          <button aria-current={index === visibleHeadingIndex ? 'location' : undefined}
            className={index === visibleHeadingIndex ? 'outline-navigation outline-heading--active' : 'outline-navigation'}
            data-outline-navigation="true" data-outline-index={index}
            disabled={outlineUnavailable} ref={(element) => { if (element) navigationRefs.current.set(index, element); else navigationRefs.current.delete(index) }}
            onClick={() => { if (currentView() && projection.visible.has(index)) onHeadingClick(row.heading, index) }}
            onKeyDown={(event) => outlineKeyDown(event, index)}
            title={t("第 {value1} 行", { value1: row.heading.line })} type="button">{label}</button>
          {row.context ? <span className="outline-context-marker" title={t("匹配标题的上级")} aria-hidden="true">↳</span> : null}
        </div>
        {children.length ? <ol className="outline-children">{children.map((child) => renderOutlineRow(child, true))}</ol> : null}
      </li>
    )
  }
  const filterTree = (entries: WorkspaceEntry[]): WorkspaceEntry[] => entries.flatMap((entry) => {
    if (entry.type === 'directory') {
      const children = filterTree(entry.children ?? [])
      if (flat) return children
      return children.length || !filter ? [{ ...entry, children }] : []
    }
    return entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) ? [entry] : []
  }).sort((a, b) => a.type !== b.type ? a.type === 'directory' ? -1 : 1 : (reverse ? -1 : 1) * a.name.localeCompare(b.name, undefined, { numeric: true }))
  return (
    <aside className="sidebar" aria-label={t("文档侧栏")}>
      <header className="sidebar__header">
        <div className="sidebar__tabs" role="tablist">
          <button
            aria-selected={mode === 'files'}
            className={mode === 'files' ? 'sidebar__tab sidebar__tab--active' : 'sidebar__tab'}
            onClick={() => onModeChange('files')}
            role="tab"
            type="button"
          >
            {t("文件")}
          </button>
          <button
            aria-selected={mode === 'outline'}
            className={mode === 'outline' ? 'sidebar__tab sidebar__tab--active' : 'sidebar__tab'}
            onClick={() => onModeChange('outline')}
            role="tab"
            type="button"
          >
            {t("大纲")}
          </button>
        </div>
        <button aria-label={t("关闭侧栏")} className="icon-button" onClick={onClose} type="button">
          ×
        </button>
      </header>

      {mode === 'files' ? (
        <div className="sidebar__content">
          <div className="sidebar__actions">
            <button onClick={onOpenWorkspace} type="button">{t("打开文件夹")}</button>
            {workspace ? <button onClick={onRefreshWorkspace} type="button">{t("刷新")}</button> : null}
            {workspace ? <button onClick={() => onManage(null)} type="button">{t("管理工作区")}</button> : null}
          </div>
          {workspace ? (
            <>
              <div className="workspace-title" title={workspace.rootPath}>{workspace.displayName}</div>
              <div className="sidebar-filters"><input aria-label={t("筛选文件")} placeholder={t("筛选文件…")} value={filter} onChange={(event) => setFilter(event.target.value)} /><button aria-pressed={flat} onClick={() => setFlat(!flat)}>{flat ? t("列表") : t("文件树")}</button><button onClick={() => setReverse(!reverse)} title={t("切换排序")}>{reverse ? 'Z–A' : 'A–Z'}</button></div>
              <ul className="file-tree">
                {filterTree(workspace.entries).map((entry) => (
                  <TreeEntry
                    activePath={activePath}
                    depth={0}
                    entry={entry}
                    key={entry.path}
                    onOpenFile={onOpenFile}
                    onManage={onManage}
                  />
                ))}
              </ul>
              {workspace.truncated ? (
                <p className="sidebar__hint">{t("文件数量过多，仅显示前 5,000 项。")}</p>
              ) : null}
            </>
          ) : (
            <p className="sidebar__empty">{t("打开一个文件夹以浏览 Markdown 和文本文件。")}</p>
          )}
        </div>
      ) : (
        <div className="sidebar__content">
          <div className="outline-title-filter"><input type="search" aria-label={t("筛选标题")} placeholder={t("筛选标题…")}
            value={controls.query} disabled={outlineUnavailable}
            onChange={(event) => controlAction({ type: 'query', documentId: outlineDocumentId, tree, query: event.target.value })} /></div>
          <label className="outline-depth">{t("显示标题层级")}<select value={headingLimit} disabled={outlineUnavailable || projection.searching}
            onChange={(event) => { if (currentView() && !projection.searching) setHeadingLimit(Number(event.target.value)) }}>
            {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>H1–H{level}</option>)}</select></label>
          <div className="outline-layout-controls"><button className="outline-flat-toggle" type="button" aria-pressed={controls.flat}
            disabled={outlineUnavailable} onClick={() => controlAction({ type: 'flat', documentId: outlineDocumentId, tree, flat: !controls.flat })}>{t("平铺大纲")}</button></div>
          {projection.searching ? <p className="outline-controls-hint">{t("筛选显示全部层级，清空后恢复。")}</p> : null}
          <nav aria-label={t("文档大纲")} aria-busy={outlinePending && !outlineError}>
            <ol className="outline-list">
              {controls.flat ? projection.rows.map((row) => renderOutlineRow(row.index, false))
                : tree.roots.filter((index) => projection.visible.has(index)).map((index) => renderOutlineRow(index, true))}
            </ol>
            {!projection.rows.length ? <p className="sidebar__empty" role="status">{t(outlineError || !tree.valid ? "大纲暂不可用"
              : outlinePending ? "正在更新大纲…" : !headings.length ? "当前文档还没有标题。"
                : projection.searching ? "没有匹配的标题。" : "当前层级没有标题。")}</p> : null}
          </nav>
        </div>
      )}
    </aside>
  )
}
