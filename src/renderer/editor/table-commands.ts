import type { Ctx } from '@milkdown/kit/ctx'
import { commandsCtx } from '@milkdown/kit/core'
import type { Node, ResolvedPos } from '@milkdown/kit/prose/model'
import { closeHistory } from '@milkdown/kit/prose/history'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, Selection, TextSelection, type Command, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { addColumn, addRow, CellSelection, deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable, selectedRect, selectionCell, TableMap, type TableRect } from '@milkdown/kit/prose/tables'
import { addColAfterCommand, addColBeforeCommand, addRowAfterCommand, addRowBeforeCommand, deleteSelectedCellsCommand, goToNextTableCellCommand, goToPrevTableCellCommand, setAlignCommand, tableSchema } from '@milkdown/kit/preset/gfm'
import type { NodeSchema } from '@milkdown/kit/transformer'

export type TableAction = 'add-row-before' | 'add-row-after' | 'add-column-before' | 'add-column-after' | 'delete-row' | 'delete-column' | 'align-left' | 'align-center' | 'align-right' | 'delete-table' | 'select-row' | 'select-column'
export type TableAlignment = 'left' | 'center' | 'right' | 'mixed'
export interface TableContext {
  rows: number
  columns: number
  row: number
  column: number
  selectedRows: number
  selectedColumns: number
  isHeader: boolean
  alignment: TableAlignment
  rectangular: boolean
  available: Record<TableAction, boolean>
}

/** GFM permits a header-only table. Requiring a body row makes deleting its last row impossible. */
export function compatibleTableSchema(previous: NodeSchema): NodeSchema {
  return { ...previous, content: 'table_header_row table_row*' }
}

export function configureTableCompatibility(ctx: Ctx): void {
  ctx.update(tableSchema.key, (previous) => (context) => compatibleTableSchema(previous(context)))
}

/** Bound the allocation made by the |columns x rows| shortcut. Rows include the header. */
export const TABLE_INPUT_LIMITS = { rows: 100, columns: 50, cells: 2000 } as const

/** Replace GFM's unbounded input rule; returning null keeps invalid dimensions as typed text. */
export function createTableInputRule(): InputRule {
  return new InputRule(/^\|(?<col>\d+)[xX](?<row>\d+)\|\s$/, (state, match, start, end) => {
    const columns = Number(match.groups?.col), rows = Number(match.groups?.row)
    if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || rows < 1 ||
      columns > TABLE_INPUT_LIMITS.columns || rows > TABLE_INPUT_LIMITS.rows || columns * rows > TABLE_INPUT_LIMITS.cells) return null
    const { table, table_header_row: headerRow, table_row: bodyRow, table_header: header, table_cell: body } = state.schema.nodes
    const $start = state.doc.resolve(start)
    if (!table || !headerRow || !bodyRow || !header || !body || !$start.depth || !$start.sameParent(state.doc.resolve(end)) ||
      !$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), table)) return null
    const headerCell = header.createAndFill(), bodyCell = rows > 1 ? body.createAndFill() : null
    if (!headerCell || rows > 1 && !bodyCell) return null
    const lines = [headerRow.create(null, Array.from({ length: columns }, () => headerCell))]
    for (let row = 1; row < rows; row++) lines.push(bodyRow.create(null, Array.from({ length: columns }, () => bodyCell!)))
    const tr = state.tr.replaceRangeWith(start, end, table.createChecked(null, lines))
    return tr.setSelection(TextSelection.create(tr.doc, start + 3)).scrollIntoView()
  }, { inCodeMark: false })
}

function tableRect(state: EditorState): TableRect | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  if (rect.table.type.name !== 'table') return null
  if (state.selection instanceof TextSelection) {
    // A text range crossing the table boundary cannot be restored as a cell selection.
    const start = rect.tableStart, end = start + rect.table.content.size
    if (state.selection.from < start || state.selection.to >= end) return null
  }
  return rect
}

function isRectangular({ table, map }: TableRect): boolean {
  if (map.problems?.length || table.childCount !== map.height || !map.width) return false
  for (let row = 0; row < map.height; row++) {
    const line = table.child(row)
    if (line.type.name !== (row === 0 ? 'table_header_row' : 'table_row') || line.childCount !== map.width) return false
    for (let column = 0; column < map.width; column++) {
      const cell = line.child(column)
      if (cell.type.name !== (row === 0 ? 'table_header' : 'table_cell') || cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) return false
    }
  }
  return true
}

function alignment(value: unknown): Exclude<TableAlignment, 'mixed'> {
  return value === 'center' || value === 'right' ? value : 'left'
}

export function getTableContext(state: EditorState): TableContext | null {
  const rect = tableRect(state)
  if (!rect) return null
  const selectedCell = state.selection instanceof CellSelection ? state.selection.$headCell : selectionCell(state)
  const cell = rect.map.findCell(selectedCell.pos - rect.tableStart)
  const rectangular = isRectangular(rect)
  const alignments = new Set<TableAlignment>()
  for (let column = rect.left; column < rect.right; column++) alignments.add(alignment(rect.table.firstChild?.maybeChild(column)?.attrs.alignment))
  const selectedAlignment = alignments.size === 1 ? [...alignments][0] : 'mixed'
  return {
    rows: rect.map.height, columns: rect.map.width, row: cell.top + 1, column: cell.left + 1,
    selectedRows: rect.bottom - rect.top, selectedColumns: rect.right - rect.left,
    isHeader: cell.top === 0, alignment: selectedAlignment, rectangular,
    available: {
      'add-row-before': rectangular, 'add-row-after': rectangular,
      'add-column-before': rectangular, 'add-column-after': rectangular,
      'delete-row': rectangular, 'delete-column': rectangular, 'delete-table': true,
      'align-left': rectangular && selectedAlignment !== 'left',
      'align-center': rectangular && selectedAlignment !== 'center',
      'align-right': rectangular && selectedAlignment !== 'right',
      'select-row': rectangular, 'select-column': rectangular,
    },
  }
}

interface CellAddress { row: number; column: number; offset: number }

function addressAt(rect: TableRect, position: ResolvedPos): CellAddress {
  let cell = position
  // Text selections are inside a paragraph; CellSelection endpoints point before a cell.
  for (let depth = position.depth; depth > 0; depth--) {
    const role = position.node(depth).type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') { cell = position.doc.resolve(position.before(depth)); break }
  }
  const bounds = rect.map.findCell(cell.pos - rect.tableStart)
  return { row: bounds.top, column: bounds.left, offset: position.pos - cell.pos }
}

function cellPosition(table: Node, tableStart: number, address: CellAddress): number {
  const map = TableMap.get(table)
  const row = Math.min(Math.max(address.row, 0), map.height - 1)
  const column = Math.min(Math.max(address.column, 0), map.width - 1)
  return tableStart + map.map[row * map.width + column]
}

/** Retain both endpoints, including rectangular selections and offsets inside edited cells. */
function restoreSelection(state: EditorState, rect: TableRect, tr: Transaction, mapAddress: (address: CellAddress) => CellAddress): void {
  const table = tr.doc.nodeAt(rect.tableStart - 1)
  if (!table || table.type.name !== 'table') return
  const selection = state.selection
  if (selection instanceof CellSelection) {
    const anchor = cellPosition(table, rect.tableStart, mapAddress(addressAt(rect, selection.$anchorCell)))
    const head = cellPosition(table, rect.tableStart, mapAddress(addressAt(rect, selection.$headCell)))
    tr.setSelection(CellSelection.create(tr.doc, anchor, head))
    return
  }
  if (!(selection instanceof TextSelection)) return
  const position = ($pos: ResolvedPos) => {
    const address = mapAddress(addressAt(rect, $pos))
    const pos = cellPosition(table, rect.tableStart, address)
    const node = tr.doc.nodeAt(pos)!
    return Math.min(pos + Math.max(2, address.offset), pos + node.nodeSize - 2)
  }
  tr.setSelection(TextSelection.create(tr.doc, position(selection.$anchor), position(selection.$head)))
}

function rowFrom(table: Node, row: Node, header: boolean): Node {
  const { nodes } = table.type.schema
  const cells: Node[] = []
  row.forEach((cell) => cells.push((header ? nodes.table_header : nodes.table_cell).create(cell.attrs, cell.content, cell.marks)))
  return (header ? nodes.table_header_row : nodes.table_row).create(row.attrs, cells, row.marks)
}

function emptyRow(rect: TableRect, header: boolean): Node {
  const { nodes } = rect.table.type.schema
  const cells = Array.from({ length: rect.map.width }, (_, column) => (header ? nodes.table_header : nodes.table_cell).createAndFill({ alignment: rect.table.firstChild?.child(column).attrs.alignment })!)
  return (header ? nodes.table_header_row : nodes.table_row).create(null, cells)
}

function replaceRows(tr: Transaction, rect: TableRect, rows: Node[]): Transaction {
  return tr.replaceWith(rect.tableStart - 1, rect.tableStart - 1 + rect.table.nodeSize, rect.table.type.create(rect.table.attrs, rows, rect.table.marks))
}

function addTableRow(state: EditorState, rect: TableRect, index: number): Transaction {
  let tr = state.tr
  if (index === 0) {
    const rows: Node[] = [emptyRow(rect, true), rowFrom(rect.table, rect.table.firstChild!, false)]
    rect.table.forEach((row, _offset, i) => { if (i > 0) rows.push(row) })
    tr = replaceRows(tr, rect, rows)
  } else {
    tr = addRow(tr, rect, index)
    const table = tr.doc.nodeAt(rect.tableStart - 1)!
    const map = TableMap.get(table)
    for (let column = 0; column < map.width; column++) {
      const pos = rect.tableStart + map.map[index * map.width + column]
      const cell = tr.doc.nodeAt(pos)!
      tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: rect.table.firstChild?.child(column).attrs.alignment })
    }
  }
  restoreSelection(state, rect, tr, (address) => ({ ...address, row: address.row >= index ? address.row + 1 : address.row }))
  return tr
}

function addTableColumn(state: EditorState, rect: TableRect, index: number, reference: number): Transaction {
  let tr = state.tr
  const inheritedAlignment = rect.table.firstChild?.child(reference).attrs.alignment
  if (rect.map.height === 1) {
    // Upstream addColumn picks a body cell when every row is a header. GFM needs th here.
    const header = rect.table.firstChild!
    const cells: Node[] = []
    header.forEach((cell, _offset, column) => {
      if (column === index) cells.push(state.schema.nodes.table_header.createAndFill({ alignment: inheritedAlignment })!)
      cells.push(cell)
    })
    if (index === rect.map.width) cells.push(state.schema.nodes.table_header.createAndFill({ alignment: inheritedAlignment })!)
    tr = replaceRows(tr, rect, [header.type.create(header.attrs, cells, header.marks)])
  } else {
    tr = addColumn(tr, rect, index)
    const map = TableMap.get(tr.doc.nodeAt(rect.tableStart - 1)!)
    for (let row = 0; row < map.height; row++) {
      const pos = rect.tableStart + map.map[row * map.width + index]
      const cell = tr.doc.nodeAt(pos)!
      tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: inheritedAlignment })
    }
  }
  restoreSelection(state, rect, tr, (address) => ({ ...address, column: address.column >= index ? address.column + 1 : address.column }))
  return tr
}

function commit(dispatch: ((tr: Transaction) => void) | undefined, tr: Transaction): void {
  if (tr.docChanged) closeHistory(tr)
  dispatch?.(tr.scrollIntoView())
}

export function tableActionCommand(action: TableAction): Command {
  return (state, dispatch) => {
    const context = getTableContext(state)
    const rect = tableRect(state)
    if (!context?.available[action] || !rect) return false
    if (!dispatch) return true
    if (action === 'delete-table' || action === 'delete-row' && rect.top === 0 && rect.bottom === rect.map.height || action === 'delete-column' && rect.left === 0 && rect.right === rect.map.width) return deleteTable(state, (tr) => commit(dispatch, tr))
    if (action === 'add-row-before' || action === 'add-row-after') { commit(dispatch, addTableRow(state, rect, action === 'add-row-before' ? rect.top : rect.bottom)); return true }
    if (action === 'add-column-before' || action === 'add-column-after') { commit(dispatch, addTableColumn(state, rect, action === 'add-column-before' ? rect.left : rect.right, action === 'add-column-before' ? rect.left : rect.right - 1)); return true }
    if (action === 'delete-row') {
      let tr: Transaction | undefined
      if (rect.top === 0) {
        const rows: Node[] = []
        rect.table.forEach((row, _offset, index) => { if (index >= rect.bottom) rows.push(rows.length ? row : rowFrom(rect.table, row, true)) })
        tr = replaceRows(state.tr, rect, rows)
      } else deleteRow(state, (transaction) => { tr = transaction })
      if (!tr) return false
      restoreSelection(state, rect, tr, (address) => ({ ...address, row: address.row >= rect.bottom ? address.row - (rect.bottom - rect.top) : Math.min(address.row, rect.top) }))
      commit(dispatch, tr)
      return true
    }
    if (action === 'delete-column') {
      return deleteColumn(state, (tr) => {
        restoreSelection(state, rect, tr, (address) => ({ ...address, column: address.column >= rect.right ? address.column - (rect.right - rect.left) : Math.min(address.column, rect.left) }))
        commit(dispatch, tr)
      })
    }
    if (action === 'select-row' || action === 'select-column') {
      const anchorIndex = action === 'select-row' ? rect.top * rect.map.width : rect.left
      const headIndex = action === 'select-row' ? rect.bottom * rect.map.width - 1 : (rect.map.height - 1) * rect.map.width + rect.right - 1
      commit(dispatch, state.tr.setSelection(CellSelection.create(state.doc, rect.tableStart + rect.map.map[anchorIndex], rect.tableStart + rect.map.map[headIndex])))
      return true
    }
    const nextAlignment = action === 'align-center' ? 'center' : action === 'align-right' ? 'right' : 'left'
    const tr = state.tr
    for (let row = 0; row < rect.map.height; row++) for (let column = rect.left; column < rect.right; column++) {
      const pos = rect.tableStart + rect.map.map[row * rect.map.width + column]
      const cell = state.doc.nodeAt(pos)!
      if (cell.attrs.alignment !== nextAlignment) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: nextAlignment })
    }
    commit(dispatch, tr)
    return true
  }
}

/** Navigation uses upstream cell selection. At the final cell, append one aligned body row atomically. */
export function tableTabCommand(direction: 1 | -1): Command {
  return (state, dispatch, view) => {
    const rect = tableRect(state)
    if (!rect) return false
    if (goToNextCell(direction)(state, dispatch, view)) return true
    if (direction === -1 || !isRectangular(rect)) return false
    if (!dispatch) return true
    const tr = addTableRow(state, rect, rect.map.height)
    const table = tr.doc.nodeAt(rect.tableStart - 1)!
    const pos = rect.tableStart + TableMap.get(table).map[rect.map.height * rect.map.width]
    tr.setSelection(Selection.near(tr.doc.resolve(pos + 2), 1))
    commit(dispatch, tr)
    return true
  }
}

/** Register before the upstream GFM keymap so Tab at the final cell can insert a row. */
export function createTableKeyboardPlugin(): Plugin {
  return new Plugin({ props: { handleKeyDown: (view, event) => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || !view.editable) return false
    return tableTabCommand(event.shiftKey ? -1 : 1)(view.state, view.dispatch, view)
  } } })
}

/** Call after editor.create(): Crepe's floating controls must use the same GFM-safe transactions. */
export function configureNativeTableCommands(ctx: Ctx): void {
  const commands = ctx.get(commandsCtx)
  commands.create(addRowBeforeCommand.key, () => tableActionCommand('add-row-before'))
  commands.create(addRowAfterCommand.key, () => tableActionCommand('add-row-after'))
  commands.create(addColBeforeCommand.key, () => tableActionCommand('add-column-before'))
  commands.create(addColAfterCommand.key, () => tableActionCommand('add-column-after'))
  commands.create(setAlignCommand.key, (value) => tableActionCommand(value === 'center' ? 'align-center' : value === 'right' ? 'align-right' : 'align-left'))
  commands.create(goToNextTableCellCommand.key, () => tableTabCommand(1))
  commands.create(goToPrevTableCellCommand.key, () => tableTabCommand(-1))
  commands.create(deleteSelectedCellsCommand.key, () => (state, dispatch, view) => {
    const selection = state.selection
    if (!(selection instanceof CellSelection)) return false
    const action: TableAction = selection.isColSelection() ? selection.isRowSelection() ? 'delete-table' : 'delete-column' : 'delete-row'
    return tableActionCommand(action)(state, dispatch, view)
  })
}
