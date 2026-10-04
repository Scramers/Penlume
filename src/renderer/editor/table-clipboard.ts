import { Fragment, Slice, type Node, type Schema } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { CellSelection, isInTable, selectedRect, TableMap, type TableRect } from '@milkdown/kit/prose/tables'

export interface TableClipboardLimits { rows: number; columns: number; cells: number; characters: number }
export const TABLE_CLIPBOARD_LIMITS: Readonly<TableClipboardLimits> = Object.freeze({ rows: 100, columns: 50, cells: 2000, characters: 2 * 1024 * 1024 })
export type TableClipboardReason = 'not-grid' | 'not-table' | 'invalid-tsv' | 'irregular-grid' | 'merged-cells' | 'unsupported-shape' | 'invalid-schema' | 'size-limit' | 'invalid-target'
export type TableClipboardResult<T> = { ok: true; value: T } | { ok: false; reason: TableClipboardReason }
export interface TableClipboardGrid { width: number; height: number; cells: readonly (readonly Node[])[] }
export type TablePasteInput = { isPlainText: true; text: string } | { isPlainText: false; slice: Slice }
const success = <T>(value: T): TableClipboardResult<T> => ({ ok: true, value })
const reject = (reason: TableClipboardReason): { ok: false; reason: TableClipboardReason } => ({ ok: false, reason })

function validLimits(limits: TableClipboardLimits): boolean {
  return Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
}
export function validTableClipboardDimensions(rows: number, columns: number, limits: TableClipboardLimits = TABLE_CLIPBOARD_LIMITS): boolean {
  return validLimits(limits) && Number.isSafeInteger(rows) && Number.isSafeInteger(columns) && rows > 0 && columns > 0 &&
    rows <= limits.rows && columns <= limits.columns && columns <= Math.floor(limits.cells / rows)
}

/** Quoted TSV uses record separators only outside quotes. No trim or Markdown parsing. */
export function parseTableTsv(text: string, options: { allowSingleColumn?: boolean; limits?: TableClipboardLimits } = {}): TableClipboardResult<string[][]> {
  const limits = options.limits ?? TABLE_CLIPBOARD_LIMITS
  if (!validLimits(limits) || text.length > limits.characters) return reject('size-limit')
  if (!options.allowSingleColumn && !text.includes('\t')) return reject('not-grid')
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, closedQuote = false, started = false, sawTab = false, endedRecord = false, parsedCells = 0
  const pushField = () => {
    if (row.length >= limits.columns || parsedCells >= limits.cells) return false
    row.push(field); field = ''; closedQuote = false; started = false
    parsedCells++
    return true
  }
  const pushRow = () => {
    rows.push(row); row = []
    return rows.length <= limits.rows
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index++ }
        else { quoted = false; closedQuote = true }
      } else field += character
      continue
    }
    if (closedQuote && character !== '\t' && character !== '\r' && character !== '\n') return reject('invalid-tsv')
    if (character === '"') {
      if (started) return reject('invalid-tsv')
      quoted = true; started = true; endedRecord = false
    } else if (character === '\t') {
      if (!pushField()) return reject('size-limit')
      sawTab = true; endedRecord = false
    } else if (character === '\r' || character === '\n') {
      if (!pushField() || !pushRow()) return reject('size-limit')
      if (character === '\r' && text[index + 1] === '\n') index++
      endedRecord = true
    } else { field += character; started = true; endedRecord = false }
  }
  if (quoted) return reject('invalid-tsv')
  if (!endedRecord && (!pushField() || !pushRow())) return reject('size-limit')
  if (!options.allowSingleColumn && !sawTab) return reject('not-grid')
  const width = rows[0]?.length ?? 0
  if (!rows.every((line) => line.length === width)) return reject('irregular-grid')
  return validTableClipboardDimensions(rows.length, width, limits) ? success(rows) : reject('size-limit')
}

/** The final record has no implicit extra row; quotes protect tabs, newlines and quotes. */
export function serializeTableTsv(rows: readonly (readonly string[])[], limits: TableClipboardLimits = TABLE_CLIPBOARD_LIMITS): TableClipboardResult<string> {
  const width = rows[0]?.length ?? 0
  if (!validTableClipboardDimensions(rows.length, width, limits)) return reject('size-limit')
  if (rows.some((row) => row.length !== width || row.some((value) => typeof value !== 'string'))) return reject('irregular-grid')
  let length = (rows.length - 1) * 2 + rows.length * (width - 1)
  for (const [rowIndex, row] of rows.entries()) for (const value of row) {
    length += value.length
    if (/[\t\r\n"]/.test(value) || width === 1 && rowIndex === rows.length - 1 && rows.length > 1 && value === '') length += 2 + (value.match(/"/g)?.length ?? 0)
    if (length > limits.characters) return reject('size-limit')
  }
  return success(rows.map((row, rowIndex) => row.map((value) => /[\t\r\n"]/.test(value) || width === 1 && rowIndex === rows.length - 1 && rows.length > 1 && value === '' ? `"${value.replace(/"/g, '""')}"` : value).join('\t')).join('\r\n'))
}

function isCell(node: Node): boolean { return node.type.name === 'table_header' || node.type.name === 'table_cell' }
function isRow(node: Node): boolean { return node.type.name === 'table_header_row' || node.type.name === 'table_row' }
function fragmentNodes(fragment: Fragment): Node[] { const nodes: Node[] = []; fragment.forEach((node) => nodes.push(node)); return nodes }
function hasTableData(fragment: Fragment): boolean {
  const pending = [{ fragment, index: 0 }]
  while (pending.length) {
    const cursor = pending[pending.length - 1]
    if (cursor.index === cursor.fragment.childCount) { pending.pop(); continue }
    const node = cursor.fragment.child(cursor.index++)
    if (node.type.name === 'table' || isRow(node) || isCell(node)) return true
    if (node.childCount) pending.push({ fragment: node.content, index: 0 })
  }
  return false
}

/** Accept whole GFM tables and the open row/cell fragments produced by CellSelection.content(). */
export function tableGridFromSlice(slice: Slice, limits: TableClipboardLimits = TABLE_CLIPBOARD_LIMITS): TableClipboardResult<TableClipboardGrid> {
  if (!validLimits(limits)) return reject('size-limit')
  if (!slice.content.childCount) return reject('not-grid')
  if (slice.content.childCount > Math.max(limits.rows + 1, limits.columns)) return reject(hasTableData(slice.content) ? 'size-limit' : 'not-grid')
  let nodes = fragmentNodes(slice.content), wholeTable = false
  if (nodes.length === 1 && nodes[0].type.name === 'table') {
    if (nodes[0].childCount > limits.rows + 1) return reject('size-limit')
    wholeTable = true; nodes = fragmentNodes(nodes[0].content)
  }
  const tableData = hasTableData(slice.content)
  if (slice.openStart > 1 || slice.openEnd > 1) return reject(tableData ? 'unsupported-shape' : 'not-grid')
  let cells: Node[][]
  if (nodes.length && nodes.every(isRow)) {
    // DOMParser can insert a required but empty header before a no-th HTML table.
    if (wholeTable && nodes.length > 1 && nodes[0].type.name === 'table_header_row' && !nodes[0].childCount) nodes = nodes.slice(1)
    if (nodes.some((row, index) => index > 0 && row.type.name === 'table_header_row')) return reject('unsupported-shape')
    if (nodes.some((row) => row.childCount > limits.columns)) return reject('size-limit')
    const width = nodes[0]?.childCount ?? 0
    if (!validTableClipboardDimensions(nodes.length, width, limits)) return reject('size-limit')
    if (nodes.some((row) => row.childCount !== width)) return reject('irregular-grid')
    cells = nodes.map((row) => fragmentNodes(row.content))
  } else if (nodes.length && nodes.every(isCell)) cells = [nodes]
  else return reject(tableData ? 'unsupported-shape' : 'not-grid')
  const width = cells[0]?.length ?? 0
  if (!validTableClipboardDimensions(cells.length, width, limits)) return reject('size-limit')
  let characters = 0
  for (const row of cells) {
    if (row.length !== width || row.some((cell) => !isCell(cell))) return reject('irregular-grid')
    for (const cell of row) {
      if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) return reject('merged-cells')
      try { cell.check() } catch { return reject('invalid-schema') }
      characters += cell.content.size
      if (characters > limits.characters) return reject('size-limit')
    }
  }
  return success({ width, height: cells.length, cells })
}

function alignment(value: unknown): 'left' | 'center' | 'right' { return value === 'center' || value === 'right' ? value : 'left' }
function gfmTypes(schema: Schema): boolean {
  return ['table', 'table_header_row', 'table_row', 'table_header', 'table_cell', 'paragraph'].every((name) => Boolean(schema.nodes[name]))
}

/**
 * Final paste-rule adapter: pass isPlainText explicitly, and keep a failure in the
 * calling editor's paste protocol so recognized unsupported grids are consumed
 * without delegating to the unsafe native handlers. No module-level paste state.
 */
export function normalizeTableClipboardSlice(slice: Slice, schema: Schema, options: { insideTable: boolean; isPlainText: boolean; limits?: TableClipboardLimits }): TableClipboardResult<Slice> {
  const extracted = tableGridFromSlice(slice, options.limits)
  if (!extracted.ok) return extracted
  if (!gfmTypes(schema) || extracted.value.cells.some((row) => row.some((cell) => cell.type.schema !== schema))) return reject('invalid-schema')
  const top = fragmentNodes(slice.content)
  if (options.isPlainText || options.insideTable && top.every(isRow)) return success(slice)
  const sourceTable = top.length === 1 && top[0].type.name === 'table' ? top[0] : null
  const sourceRows = sourceTable ? fragmentNodes(sourceTable.content).filter((row, index) => index !== 0 || row.childCount > 0) : top.every(isRow) ? top : []
  const { cells } = extracted.value
  try {
    const rows = cells.map((line, row) => (row ? schema.nodes.table_row : schema.nodes.table_header_row).createChecked(sourceRows[row]?.attrs,
      line.map((cell, column) => (row ? schema.nodes.table_cell : schema.nodes.table_header).createChecked({ ...cell.attrs, alignment: alignment(cells[0][column].attrs.alignment) }, cell.content, cell.marks)), sourceRows[row]?.marks))
    const table = schema.nodes.table.createChecked(sourceTable?.attrs, rows, sourceTable?.marks)
    return success(new Slice(Fragment.from(table), sourceTable ? slice.openStart : 0, sourceTable ? slice.openEnd : 0))
  } catch { return reject('invalid-schema') }
}

function targetRect(state: EditorState): TableClipboardResult<TableRect> {
  if (!isInTable(state)) return reject('not-table')
  if (!(state.selection instanceof CellSelection) && !(state.selection instanceof TextSelection)) return reject('invalid-target')
  if (state.selection instanceof TextSelection) {
    const { $from, $to } = state.selection
    if (!$from.sameParent($to) || $from.parent.type.name !== 'paragraph') return reject('invalid-target')
    if ([...(state.storedMarks ?? $from.marks()), ...$to.marks()].some((mark) => mark.type.spec.code)) return reject('not-grid')
  }
  try {
    // Inspect spans before TableMap allocates a map using their reported widths.
    for (let depth = state.selection.$head.depth; depth > 0; depth--) {
      const node = state.selection.$head.node(depth)
      if (node.type.name !== 'table') continue
      let merged = false
      node.forEach((row) => row.forEach((cell) => { if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) merged = true }))
      if (merged) return reject('merged-cells')
      break
    }
    const rect = selectedRect(state)
    if (rect.table.type.name !== 'table' || !gfmTypes(state.schema) || rect.map.problems?.length || !rect.map.width) return reject('invalid-target')
    for (let row = 0; row < rect.map.height; row++) {
      const line = rect.table.child(row)
      if (line.type.name !== (row ? 'table_row' : 'table_header_row') || line.childCount !== rect.map.width) return reject('invalid-target')
      for (let column = 0; column < line.childCount; column++) {
        const cell = line.child(column)
        if (cell.type.name !== (row ? 'table_cell' : 'table_header')) return reject('invalid-target')
        if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) return reject('merged-cells')
      }
    }
    return success(rect)
  } catch { return reject('invalid-target') }
}

function textGrid(schema: Schema, values: string[][]): TableClipboardGrid {
  return { width: values[0].length, height: values.length, cells: values.map((row) => row.map((value) => schema.nodes.table_cell.createChecked(null, schema.nodes.paragraph.createChecked(null, value ? schema.text(value) : [])))) }
}
function scalarHtmlGrid(slice: Slice, schema: Schema): TableClipboardResult<TableClipboardGrid> {
  const nodes = fragmentNodes(slice.content)
  if (slice.openStart > 1 || slice.openEnd > 1) return reject('unsupported-shape')
  try {
    const paragraph = nodes.length === 1 && nodes[0].type === schema.nodes.paragraph ? nodes[0] : nodes.every((node) => node.isInline && node.type.schema === schema) ? schema.nodes.paragraph.createChecked(null, nodes) : null
    if (!paragraph || paragraph.type.schema !== schema) return reject('unsupported-shape')
    const cell = schema.nodes.table_cell.createChecked(null, paragraph)
    return success({ width: 1, height: 1, cells: [[cell]] })
  } catch { return reject('invalid-schema') }
}

/**
 * Construct, but never dispatch, one valid whole-table replacement. The caller
 * closes BOTH PM and application history before/after dispatch; uiEvent=paste
 * alone does not separate subsequent typing. A rejection leaves state untouched.
 */
export function tablePasteTransaction(state: EditorState, input: TablePasteInput, limits: TableClipboardLimits = TABLE_CLIPBOARD_LIMITS): TableClipboardResult<Transaction> {
  const target = targetRect(state)
  if (!target.ok) return target
  const rect = target.value, selection = state.selection
  let extracted: TableClipboardResult<TableClipboardGrid>
  if (input.isPlainText) {
    const parsed = parseTableTsv(input.text, { allowSingleColumn: selection instanceof CellSelection, limits })
    if (!parsed.ok) return parsed
    try { extracted = success(textGrid(state.schema, parsed.value)) } catch { return reject('invalid-schema') }
  } else {
    extracted = tableGridFromSlice(input.slice, limits)
    if (!extracted.ok && extracted.reason === 'not-grid' && selection instanceof CellSelection) extracted = scalarHtmlGrid(input.slice, state.schema)
  }
  if (!extracted.ok) return extracted
  const grid = extracted.value
  if (grid.cells.some((row) => row.some((cell) => cell.type.schema !== state.schema))) return reject('invalid-schema')
  if (grid.cells.reduce((total, row) => total + row.reduce((size, cell) => size + cell.content.size, 0), 0) > limits.characters) return reject('size-limit')
  const selected = selection instanceof CellSelection
  const height = selected ? rect.bottom - rect.top : grid.height, width = selected ? rect.right - rect.left : grid.width
  if (!validTableClipboardDimensions(height, width, limits)) return reject('size-limit')
  const rowsCount = Math.max(rect.map.height, rect.top + height), columnsCount = Math.max(rect.map.width, rect.left + width)
  if ((rowsCount > rect.map.height || columnsCount > rect.map.width) && !validTableClipboardDimensions(rowsCount, columnsCount, limits)) return reject('size-limit')
  const { schema } = state
  const columns = Array.from({ length: columnsCount }, (_, column) => {
    const reference = rect.table.firstChild?.maybeChild(column) ?? grid.cells[0][column - rect.left]
    return { alignment: alignment(reference?.attrs.alignment), colwidth: reference?.attrs.colwidth ?? null }
  })
  try {
    const rows = Array.from({ length: rowsCount }, (_, row) => {
      const previous = rect.table.maybeChild(row), cellType = row ? schema.nodes.table_cell : schema.nodes.table_header
      const cells = Array.from({ length: columnsCount }, (_, column) => {
        if (row >= rect.top && row < rect.top + height && column >= rect.left && column < rect.left + width) {
          const source = grid.cells[(row - rect.top) % grid.height][(column - rect.left) % grid.width]
          return cellType.createChecked({ ...source.attrs, colspan: 1, rowspan: 1, ...columns[column] }, source.content, source.marks)
        }
        return previous?.maybeChild(column) ?? cellType.createChecked({ colspan: 1, rowspan: 1, ...columns[column] }, schema.nodes.paragraph.create())
      })
      return (row ? schema.nodes.table_row : schema.nodes.table_header_row).createChecked(previous?.attrs, cells, previous?.marks)
    })
    const table = schema.nodes.table.createChecked(rect.table.attrs, rows, rect.table.marks)
    const tr = state.tr
    if (!table.eq(rect.table)) tr.replaceWith(rect.tableStart - 1, rect.tableStart - 1 + rect.table.nodeSize, table)
    const map = TableMap.get(table), position = (row: number, column: number) => rect.tableStart + map.map[row * map.width + column]
    let anchor = position(rect.top, rect.left), head = position(rect.top + height - 1, rect.left + width - 1)
    if (selection instanceof CellSelection) {
      const a = rect.map.findCell(selection.$anchorCell.pos - rect.tableStart), h = rect.map.findCell(selection.$headCell.pos - rect.tableStart)
      anchor = position(a.top, a.left); head = position(h.top, h.left)
    }
    tr.setSelection(CellSelection.create(tr.doc, anchor, head)).setMeta('uiEvent', 'paste').setMeta('paste', true).scrollIntoView()
    tr.doc.check()
    return success(tr)
  } catch { return reject('invalid-schema') }
}

/** Plain-text copy for a table selection; native serializeForClipboard owns HTML and PM metadata. */
export function tableSelectionTsv(state: EditorState, limits: TableClipboardLimits = TABLE_CLIPBOARD_LIMITS): TableClipboardResult<string> {
  if (!(state.selection instanceof CellSelection)) return reject('not-grid')
  const extracted = tableGridFromSlice(state.selection.content(), limits)
  if (!extracted.ok) return extracted
  return serializeTableTsv(extracted.value.cells.map((row) => row.map((cell) => cell.textBetween(0, cell.content.size, '\n', (leaf) =>
    leaf.type.spec.leafText?.(leaf) ?? (leaf.type.name === 'hardbreak' || leaf.type.name === 'hard_break' ? '\n' : typeof leaf.attrs.value === 'string' ? leaf.attrs.value : typeof leaf.attrs.alt === 'string' ? leaf.attrs.alt : '\uFFFC')))), limits)
}
