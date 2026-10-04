import { useLocalization } from '../localization'
import type { TableAction, TableContext } from '../editor/table-commands'
import './TableTools.css'

export interface TableToolsProps {
  context: TableContext | null
  onAction: (action: TableAction) => void
  disabled?: boolean
}

const groups: { label: string; actions: { action: TableAction; label: string; shortLabel?: string }[] }[] = [
  { label: '表格行', actions: [{ action: 'add-row-before', label: '向上插入行' }, { action: 'add-row-after', label: '向下插入行' }, { action: 'select-row', label: '选择整行' }, { action: 'delete-row', label: '删除所选行' }] },
  { label: '列', actions: [{ action: 'add-column-before', label: '向左插入列' }, { action: 'add-column-after', label: '向右插入列' }, { action: 'select-column', label: '选择整列' }, { action: 'delete-column', label: '删除所选列' }] },
  { label: '对齐', actions: [{ action: 'align-left', label: '列左对齐', shortLabel: '左对齐' }, { action: 'align-center', label: '列居中对齐', shortLabel: '居中' }, { action: 'align-right', label: '列右对齐', shortLabel: '右对齐' }] },
]

/** Mouse actions retain the editor's cell selection; keyboard activation remains fully accessible. */
export function TableTools({ context, onAction, disabled = false }: TableToolsProps) {
  const { t } = useLocalization()
  if (!context) return null
  const button = ({ action, label, shortLabel }: { action: TableAction; label: string; shortLabel?: string }) => {
    const isAlignment = action.startsWith('align-')
    const pressed = isAlignment && context.alignment === action.slice('align-'.length)
    return <button key={action} type="button" data-table-action={action} aria-label={t(label)} title={t(label)}
      disabled={disabled || !context.available[action]} aria-pressed={isAlignment ? pressed : undefined}
      onMouseDown={(event) => event.preventDefault()} onClick={() => onAction(action)}>{t(shortLabel ?? label)}</button>
  }
  return <section className="table-tools" aria-label={t('表格操作')} data-table-tools="true">
    <div className="table-tools__context">
      <strong>{t('表格')}</strong>
      <span>{t('{rows} 行 × {columns} 列', { rows: context.rows, columns: context.columns })}</span>
      <span>{t('第 {row} 行，第 {column} 列', { row: context.row, column: context.column })}{context.isHeader ? ` · ${t('表头')}` : ''}</span>
      {context.selectedRows > 1 || context.selectedColumns > 1 ? <span>{t('已选 {rows} 行、{columns} 列', { rows: context.selectedRows, columns: context.selectedColumns })}</span> : null}
    </div>
    <div className="table-tools__actions">
      {groups.map((group) => <div className="table-tools__group" role="group" aria-label={t(group.label)} key={group.label}>{group.actions.map(button)}</div>)}
      <div className="table-tools__group table-tools__group--danger">{button({ action: 'delete-table', label: '删除整张表格' })}</div>
    </div>
    <small className="table-tools__hint">{t(context.rectangular ? 'Tab 切换单元格，末格新增一行' : '当前表格包含合并单元格，结构操作暂不可用。')}</small>
  </section>
}
