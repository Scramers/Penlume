import { describe, expect, it, vi } from 'vitest'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import { Clock, Container, Ctx } from '@milkdown/kit/ctx'
import { CommandManager, CommandsReady, commandsCtx, editorViewCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Schema, type Node } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Command } from '@milkdown/kit/prose/state'
import { CellSelection, TableMap, tableEditing } from '@milkdown/kit/prose/tables'
import { history, redo, undo, undoDepth } from '@milkdown/kit/prose/history'
import { inputRules, undoInputRule } from '@milkdown/kit/prose/inputrules'
import { addColAfterCommand, addColBeforeCommand, addRowAfterCommand, addRowBeforeCommand, deleteSelectedCellsCommand, goToNextTableCellCommand, goToPrevTableCellCommand, setAlignCommand, tableSchema, tableHeaderRowSchema, tableRowSchema, tableHeaderSchema, tableCellSchema } from '@milkdown/kit/preset/gfm'
import { strongSchema, linkSchema, inlineCodeSchema } from '@milkdown/kit/preset/commonmark'
import { ParserState, SerializerState, type NodeSchema } from '@milkdown/kit/transformer'
import { compatibleTableSchema, configureNativeTableCommands, configureTableCompatibility, createTableInputRule, getTableContext, TABLE_INPUT_LIMITS, tableActionCommand, tableTabCommand, type TableAction } from '../src/renderer/editor/table-commands'

const TABLE = '| Head A | Head B | Head C |\n| :--- | :---: | ---: |\n| A1 | B1 | C1 |\n| A2 | B2 | C2 |\n'

function harness(markdown = TABLE) {
  const ctx = new Ctx(new Container(), new Clock())
  ctx.inject(remarkStringifyOptionsCtx)
  ctx.inject(tableSchema.key)
  configureTableCompatibility(ctx)
  const nodes: Record<string, NodeSchema> = {
    doc: {
      content: 'block+',
      parseMarkdown: { match: (node) => node.type === 'root', runner: (state, node, type) => { state.injectRoot(node, type) } },
      toMarkdown: { match: (node) => node.type.name === 'doc', runner: (state, node) => { state.openNode('root'); state.next(node.content) } },
    },
    paragraph: {
      content: 'inline*', group: 'block',
      parseMarkdown: { match: (node) => node.type === 'paragraph', runner: (state, node, type) => { state.openNode(type); state.next(node.children); state.closeNode() } },
      toMarkdown: { match: (node) => node.type.name === 'paragraph', runner: (state, node) => { state.openNode('paragraph'); state.next(node.content); state.closeNode() } },
    },
    text: {
      group: 'inline',
      parseMarkdown: { match: (node) => node.type === 'text', runner: (state, node) => { state.addText(String(node.value ?? '')) } },
      toMarkdown: { match: (node) => node.type.name === 'text', runner: (state, node) => { state.addNode('text', undefined, node.text ?? '') } },
    },
    table: ctx.get(tableSchema.key)(ctx),
    table_header_row: tableHeaderRowSchema.key._defaultValue(ctx),
    table_row: tableRowSchema.key._defaultValue(ctx),
    table_cell: tableCellSchema.key._defaultValue(ctx),
    table_header: tableHeaderSchema.key._defaultValue(ctx),
  }
  const schema = new Schema({ nodes, marks: {
    strong: strongSchema.key._defaultValue(ctx),
    link: linkSchema.key._defaultValue(ctx),
    inlineCode: inlineCodeSchema.key._defaultValue(ctx),
  } })
  const processor = remark().use(remarkGfm)
  const parse = ParserState.create(schema, processor)
  const serialize = SerializerState.create(schema, processor)
  let state = EditorState.create({ doc: parse(markdown), plugins: [history(), tableEditing()] })
  const dispatch = (tr: ReturnType<EditorState['tr']['setSelection']>) => { state = state.applyTransaction(tr).state; state.doc.check() }
  const run = (command: Command) => command(state, dispatch)
  const table = () => {
    let node: Node | undefined, pos = -1
    state.doc.descendants((current, position) => { if (!node && current.type.name === 'table') { node = current; pos = position }; return !node })
    if (!node) throw new Error('No table')
    return { node, start: pos + 1 }
  }
  const cellPos = (row: number, column: number) => {
    const { node, start } = table()
    const map = TableMap.get(node)
    return start + map.map[row * map.width + column]
  }
  const select = (row: number, column: number, offset = 2) => dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPos(row, column) + offset)))
  const selectCells = (anchorRow: number, anchorColumn: number, headRow: number, headColumn: number) => dispatch(state.tr.setSelection(CellSelection.create(state.doc, cellPos(anchorRow, anchorColumn), cellPos(headRow, headColumn))))
  const act = (action: TableAction) => run(tableActionCommand(action))
  const data = () => {
    const result: string[][] = []
    table().node.forEach((row) => { const cells: string[] = []; row.forEach((cell) => cells.push(cell.textContent)); result.push(cells) })
    return result
  }
  const roundTrip = () => {
    const output = serialize(state.doc)
    const parsed = parse(output)
    parsed.check()
    expect(parsed.eq(state.doc), output).toBe(true)
    return output
  }
  return { ctx, schema, parse, serialize, state: () => state, dispatch, run, table, cellPos, select, selectCells, act, data, roundTrip }
}

function inputHarness(token: string, container = 'paragraph', codeMark = false) {
  const { schema, parse, serialize } = harness()
  const marks = codeMark ? [schema.marks.inlineCode.create()] : []
  const paragraph = schema.nodes.paragraph.create(null, token ? schema.text(token, marks) : [])
  const block = container === 'table' ? schema.nodes.table.create(null, [schema.nodes.table_header_row.create(null, [schema.nodes.table_header.create(null, paragraph)])]) : paragraph
  const doc = schema.nodes.doc.create(null, block)
  const position = container === 'table' ? token.length + 4 : token.length + 1
  const plugin = inputRules({ rules: [createTableInputRule()] })
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, position), plugins: [history(), tableEditing(), plugin] })
  const dispatch = (tr: ReturnType<EditorState['tr']['setSelection']>) => { state = state.applyTransaction(tr).state; state.doc.check() }
  const view = { get state() { return state }, dispatch, composing: false } as unknown as EditorView
  const type = (text = ' ') => {
    const handled = plugin.props.handleTextInput?.call(plugin, view, state.selection.from, state.selection.to, text, () => state.tr) ?? false
    // The browser inserts normal text when an InputRule declines to handle it.
    if (!handled) dispatch(state.tr.insertText(text))
    return handled
  }
  return { schema, parse, serialize, state: () => state, dispatch, type, run: (command: Command) => command(state, dispatch) }
}

describe('bounded table shortcut input', () => {
  it.each([
    ['|2x2|', 2, 2], ['|3X4|', 3, 4], ['|002x003|', 2, 3], ['|1x1|', 1, 1],
  ])('creates exactly the requested compatible table from %s', (token, columns, rows) => {
    const editor = inputHarness(token)
    expect(editor.type()).toBe(true)
    const table = editor.state().doc.firstChild!
    expect(table.type.name).toBe('table')
    expect(table.childCount).toBe(rows)
    expect(TableMap.get(table)).toMatchObject({ width: columns, height: rows, problems: null })
    table.forEach((row, _offset, index) => {
      expect(row.type.name).toBe(index ? 'table_row' : 'table_header_row')
      expect(row.childCount).toBe(columns)
      row.forEach((cell) => expect(cell.type.name).toBe(index ? 'table_cell' : 'table_header'))
    })
    expect(editor.state().selection).toBeInstanceOf(TextSelection)
    expect(editor.state().selection.$from.parent.type.name).toBe('paragraph')
    expect(editor.state().selection.$from.node(-1).type.name).toBe('table_header')
    expect(editor.parse(editor.serialize(editor.state().doc)).eq(editor.state().doc)).toBe(true)
  })

  it.each([
    `|${TABLE_INPUT_LIMITS.columns}x1|`, `|1x${TABLE_INPUT_LIMITS.rows}|`,
    `|20x${TABLE_INPUT_LIMITS.rows}|`, `|${TABLE_INPUT_LIMITS.columns}x40|`,
  ])('accepts the row, column and total-cell boundaries at %s', (token) => {
    const editor = inputHarness(token)
    expect(editor.type()).toBe(true)
    const map = TableMap.get(editor.state().doc.firstChild!)
    expect(map.problems).toBeNull()
    expect(map.width * map.height).toBeLessThanOrEqual(TABLE_INPUT_LIMITS.cells)
  })

  it.each([
    '|0x2|', '|2x0|', '|0x0|', '|51x1|', '|1x101|', '|50x41|', '|49x41|',
    '|4294967296x2|', '|2x4294967296|', '|9007199254740993x2|',
    `|${'9'.repeat(350)}x2|`, '|2.5x3|', '|-2x3|', '|2x-3|', '|2e2x3|',
    'prefix |2x2|', '|2x2|suffix', '|x2|', '|2x|',
  ])('leaves %s literal without attempting to allocate a table', (token) => {
    const editor = inputHarness(token)
    const headerAllocation = vi.spyOn(editor.schema.nodes.table_header, 'createAndFill')
    const cellAllocation = vi.spyOn(editor.schema.nodes.table_cell, 'createAndFill')
    try {
      expect(editor.type()).toBe(false)
      expect(editor.state().doc.childCount).toBe(1)
      expect(editor.state().doc.firstChild?.type.name).toBe('paragraph')
      expect(editor.state().doc.textContent).toBe(`${token} `)
      expect(headerAllocation).not.toHaveBeenCalled()
      expect(cellAllocation).not.toHaveBeenCalled()
      expect(editor.run(undoInputRule)).toBe(false)
    } finally { headerAllocation.mockRestore(); cellAllocation.mockRestore() }
  })

  it('retains a valid shortcut as literal inline code or within a table cell', () => {
    for (const editor of [inputHarness('|2x2|', 'paragraph', true), inputHarness('|2x2|', 'table')]) {
      const original = editor.state().doc
      expect(editor.type()).toBe(false)
      expect(editor.state().doc.textContent).toBe('|2x2| ')
      expect(editor.state().doc.firstChild?.type).toBe(original.firstChild?.type)
      expect(editor.state().selection.$from.parent.type.name).toBe('paragraph')
    }
  })

  it('keeps the genuine input-rule undo operation so backspace can restore the complete shortcut', () => {
    const editor = inputHarness('|3x2|')
    expect(editor.type()).toBe(true)
    expect(editor.run(undoInputRule)).toBe(true)
    expect(editor.state().doc.firstChild?.type.name).toBe('paragraph')
    expect(editor.state().doc.textContent).toBe('|3x2| ')
    expect(editor.state().selection.empty).toBe(true)
  })
})

describe('native GFM table commands', () => {
  it('uses the installed Milkdown schema and keeps header-only GFM tables representable', () => {
    const editor = harness('| A | B |\n| --- | ---: |\n')
    expect(editor.table().node.childCount).toBe(1)
    expect(editor.table().node.firstChild?.type.name).toBe('table_header_row')
    editor.roundTrip()
    expect(compatibleTableSchema(editor.schema.nodes.table.spec as NodeSchema).content).toBe('table_header_row table_row*')
  })

  it('reports current row/column, rectangle size and mixed column alignment without changing history', () => {
    const editor = harness()
    editor.select(1, 2)
    expect(getTableContext(editor.state())).toMatchObject({ rows: 3, columns: 3, row: 2, column: 3, selectedRows: 1, selectedColumns: 1, alignment: 'right', isHeader: false, rectangular: true })
    editor.selectCells(0, 0, 2, 1)
    expect(getTableContext(editor.state())).toMatchObject({ selectedRows: 3, selectedColumns: 2, alignment: 'mixed' })
    expect(undoDepth(editor.state())).toBe(0)
  })

  it('inserts above the header by demoting its existing rich cells while preserving all content', () => {
    const editor = harness(TABLE.replace('Head A', '**Head A**').replace('Head B', '[Head B](https://example.com)'))
    const before = editor.state().doc
    const header = editor.table().node.firstChild!
    editor.select(0, 1, 4)
    expect(editor.act('add-row-before')).toBe(true)
    expect(editor.data()).toEqual([['', '', ''], ['Head A', 'Head B', 'Head C'], ['A1', 'B1', 'C1'], ['A2', 'B2', 'C2']])
    expect(editor.table().node.child(1).child(0).content.eq(header.child(0).content)).toBe(true)
    expect(getTableContext(editor.state())).toMatchObject({ row: 2, column: 2 })
    expect(editor.roundTrip()).toContain('**Head A**')
    expect(editor.run(undo)).toBe(true)
    expect(editor.state().doc.eq(before)).toBe(true)
    expect(editor.run(redo)).toBe(true)
    editor.roundTrip()
  })

  it('inserts below the selected range and before the final row while retaining both selected endpoints', () => {
    const editor = harness()
    editor.selectCells(0, 0, 1, 2)
    expect(editor.act('add-row-after')).toBe(true)
    expect(editor.data()).toEqual([['Head A', 'Head B', 'Head C'], ['A1', 'B1', 'C1'], ['', '', ''], ['A2', 'B2', 'C2']])
    expect(editor.state().selection).toBeInstanceOf(CellSelection)
    expect(getTableContext(editor.state())).toMatchObject({ selectedRows: 2, selectedColumns: 3 })
    editor.select(3, 1)
    expect(editor.act('add-row-before')).toBe(true)
    expect(getTableContext(editor.state())).toMatchObject({ row: 5, column: 2 })
    editor.table().node.forEach((row) => expect(row.child(1).attrs.alignment).toBe('center'))
    editor.roundTrip()
  })

  it('adds first and last columns with correct header types, inherited alignments and retained text selection', () => {
    const editor = harness()
    editor.select(1, 0, 3)
    expect(editor.act('add-column-before')).toBe(true)
    expect(editor.data()[1]).toEqual(['', 'A1', 'B1', 'C1'])
    expect(getTableContext(editor.state())).toMatchObject({ row: 2, column: 2 })
    expect(editor.state().selection.from).toBe(editor.cellPos(1, 1) + 3)
    editor.select(2, 3)
    expect(editor.act('add-column-after')).toBe(true)
    editor.table().node.forEach((row, _offset, index) => {
      expect(row.lastChild?.type.name).toBe(index ? 'table_cell' : 'table_header')
      expect(row.lastChild?.attrs.alignment).toBe('right')
    })
    expect(editor.data()[2]).toEqual(['', 'A2', 'B2', 'C2', ''])
    editor.roundTrip()
  })

  it('adds columns to a header-only table without inserting incompatible body cells', () => {
    const editor = harness('| A | B |\n| --- | ---: |\n')
    editor.select(0, 0)
    editor.act('add-column-before')
    editor.select(0, 2)
    editor.act('add-column-after')
    expect(editor.data()).toEqual([['', 'A', 'B', '']])
    editor.table().node.firstChild!.forEach((cell) => expect(cell.type.name).toBe('table_header'))
    editor.roundTrip()
  })

  it('deletes the first header range by promoting the next body row without losing its marks or column alignment', () => {
    const editor = harness(TABLE.replace('A2', '**A2**').replace('B2', '`B2`'))
    const before = editor.state().doc
    editor.selectCells(0, 0, 1, 1)
    expect(editor.act('delete-row')).toBe(true)
    expect(editor.data()).toEqual([['A2', 'B2', 'C2']])
    expect(editor.table().node.firstChild?.type.name).toBe('table_header_row')
    expect(editor.roundTrip()).toContain('**A2**')
    expect(editor.run(undo)).toBe(true)
    expect(editor.state().doc.eq(before)).toBe(true)
    expect(editor.state().selection).toBeInstanceOf(CellSelection)
  })

  it('deletes a final body row and then the remaining body range leaving a legal header-only table', () => {
    const editor = harness()
    editor.select(2, 2)
    editor.act('delete-row')
    expect(editor.data()).toEqual([['Head A', 'Head B', 'Head C'], ['A1', 'B1', 'C1']])
    editor.selectCells(1, 0, 1, 2)
    editor.act('delete-row')
    expect(editor.data()).toEqual([['Head A', 'Head B', 'Head C']])
    expect(getTableContext(editor.state())).toMatchObject({ row: 1, selectedRows: 1, selectedColumns: 3 })
    editor.roundTrip()
    expect(undoDepth(editor.state())).toBe(2)
  })

  it('deletes selected columns including the last, retains other cells and restores all cells with one undo', () => {
    const editor = harness()
    const before = editor.state().doc
    editor.selectCells(0, 1, 2, 2)
    expect(editor.act('delete-column')).toBe(true)
    expect(editor.data()).toEqual([['Head A'], ['A1'], ['A2']])
    expect(editor.state().selection).toBeInstanceOf(CellSelection)
    editor.roundTrip()
    editor.run(undo)
    expect(editor.state().doc.eq(before)).toBe(true)
    expect(getTableContext(editor.state())).toMatchObject({ selectedRows: 3, selectedColumns: 2 })
  })

  it.each(['delete-row', 'delete-column', 'delete-table'] as TableAction[])('deletes the entire table for %s on all cells and preserves neighboring text with undo/redo', (action) => {
    const editor = harness(`Before\n\n${TABLE}\nAfter\n`)
    const before = editor.state().doc
    editor.selectCells(0, 0, 2, 2)
    editor.act(action)
    expect(getTableContext(editor.state())).toBeNull()
    expect(editor.serialize(editor.state().doc)).toBe('Before\n\nAfter\n')
    expect(editor.run(undo)).toBe(true)
    expect(editor.state().doc.eq(before)).toBe(true)
    expect(editor.run(redo)).toBe(true)
    expect(editor.serialize(editor.state().doc)).toBe('Before\n\nAfter\n')
  })

  it('deletes and undoes a one-cell header-only table while leaving a valid empty document', () => {
    const editor = harness('| Only |\n| --- |\n')
    const before = editor.state().doc
    editor.select(0, 0)
    editor.act('delete-row')
    expect(editor.state().doc.firstChild?.type.name).toBe('paragraph')
    editor.run(undo)
    expect(editor.state().doc.eq(before)).toBe(true)
    editor.roundTrip()
  })

  it('aligns every selected column atomically from a body selection so GFM serialization persists it', () => {
    const editor = harness()
    const before = editor.state().doc
    editor.selectCells(1, 0, 2, 1)
    editor.act('align-right')
    editor.table().node.forEach((row) => {
      expect(row.child(0).attrs.alignment).toBe('right')
      expect(row.child(1).attrs.alignment).toBe('right')
      expect(row.child(2).attrs.alignment).toBe('right')
    })
    expect(getTableContext(editor.state())?.available['align-right']).toBe(false)
    expect(editor.state().selection).toBeInstanceOf(CellSelection)
    editor.roundTrip()
    expect(undoDepth(editor.state())).toBe(1)
    editor.run(undo)
    expect(editor.state().doc.eq(before)).toBe(true)
  })

  it('navigates forward/backward and appends one aligned row at the last cell as one undo step', () => {
    const editor = harness()
    editor.select(0, 0)
    const original = editor.state().doc
    expect(editor.run(tableTabCommand(-1))).toBe(false)
    expect(editor.run(tableTabCommand(1))).toBe(true)
    expect(getTableContext(editor.state())).toMatchObject({ row: 1, column: 2 })
    expect(editor.run(tableTabCommand(-1))).toBe(true)
    expect(getTableContext(editor.state())).toMatchObject({ row: 1, column: 1 })
    expect(undoDepth(editor.state())).toBe(0)
    editor.select(2, 2)
    expect(editor.run(tableTabCommand(1))).toBe(true)
    expect(editor.data()[3]).toEqual(['', '', ''])
    expect(getTableContext(editor.state())).toMatchObject({ row: 4, column: 1 })
    expect(editor.table().node.lastChild?.child(2).attrs.alignment).toBe('right')
    editor.roundTrip()
    expect(undoDepth(editor.state())).toBe(1)
    editor.run(undo)
    expect(editor.state().doc.eq(original)).toBe(true)
    expect(getTableContext(editor.state())).toMatchObject({ row: 3, column: 3 })
  })

  it('supports Tab append from a header-only table and keeps pipe escaping and rich content intact', () => {
    const editor = harness('| **A** | `B` | C \\| D |\n| :--- | :---: | ---: |\n')
    editor.select(0, 2)
    editor.run(tableTabCommand(1))
    expect(editor.data()).toEqual([['A', 'B', 'C | D'], ['', '', '']])
    const output = editor.roundTrip()
    expect(output).toContain('**A**')
    expect(output).toContain('C \\| D')
  })

  it('selects complete rows and columns using CellSelection without altering text or history', () => {
    const editor = harness()
    editor.select(1, 1)
    editor.act('select-row')
    expect(getTableContext(editor.state())).toMatchObject({ selectedRows: 1, selectedColumns: 3 })
    expect((editor.state().selection as CellSelection).isRowSelection()).toBe(true)
    editor.select(2, 1)
    editor.act('select-column')
    expect(getTableContext(editor.state())).toMatchObject({ selectedRows: 3, selectedColumns: 1 })
    expect((editor.state().selection as CellSelection).isColSelection()).toBe(true)
    expect(undoDepth(editor.state())).toBe(0)
    editor.roundTrip()
  })

  it('declines destructive structural actions on merged cells without silently discarding their content', () => {
    const editor = harness('| A | B |\n| --- | --- |\n| C | D |\n')
    const { node, start } = editor.table()
    const first = node.firstChild!
    const merged = editor.schema.nodes.table_header.create({ ...first.child(0).attrs, colspan: 2 }, first.child(0).content)
    editor.dispatch(editor.state().tr.replaceWith(start, start + first.nodeSize, first.type.create(null, [merged])))
    editor.select(0, 0)
    const before = editor.state().doc
    expect(getTableContext(editor.state())?.rectangular).toBe(false)
    expect(editor.act('add-row-before')).toBe(false)
    expect(editor.act('delete-column')).toBe(false)
    expect(editor.state().doc.eq(before)).toBe(true)
  })

  it('preserves reversed rectangular endpoints when inserting rows and columns', () => {
    const editor = harness()
    editor.selectCells(2, 2, 0, 1)
    expect(getTableContext(editor.state())).toMatchObject({ row: 1, column: 2, selectedRows: 3, selectedColumns: 2 })
    editor.act('add-row-before')
    editor.act('add-column-before')
    const selection = editor.state().selection as CellSelection
    expect(selection.$anchorCell.pos).toBe(editor.cellPos(3, 3))
    expect(selection.$headCell.pos).toBe(editor.cellPos(1, 2))
    editor.roundTrip()
  })

  it('does not apply table operations to a text range that also contains neighboring paragraphs', () => {
    const editor = harness(`Before\n\n${TABLE}\nAfter\n`)
    editor.dispatch(editor.state().tr.setSelection(TextSelection.create(editor.state().doc, 1, editor.cellPos(1, 1) + 2)))
    const before = editor.state().doc
    expect(getTableContext(editor.state())).toBeNull()
    expect(editor.act('delete-row')).toBe(false)
    expect(editor.run(tableTabCommand(1))).toBe(false)
    expect(editor.state().doc.eq(before)).toBe(true)
  })

  it('changes only selected column alignment and separates consecutive commands into complete undo steps', () => {
    const editor = harness()
    const before = editor.state().doc
    editor.select(2, 1)
    editor.act('align-left')
    editor.table().node.forEach((row) => {
      expect(row.child(0).attrs.alignment).toBe('left')
      expect(row.child(1).attrs.alignment).toBe('left')
      expect(row.child(2).attrs.alignment).toBe('right')
    })
    const aligned = editor.state().doc
    editor.act('add-row-after')
    expect(undoDepth(editor.state())).toBe(2)
    editor.run(undo)
    expect(editor.state().doc.eq(aligned)).toBe(true)
    editor.run(undo)
    expect(editor.state().doc.eq(before)).toBe(true)
  })

  it('routes real Crepe command manager keys through the same header-safe operations', async () => {
    // Milkdown lifecycle timers use the browser's global event target, which Node lacks.
    const lifecycle = new EventTarget()
    vi.stubGlobal('dispatchEvent', lifecycle.dispatchEvent.bind(lifecycle))
    vi.stubGlobal('addEventListener', lifecycle.addEventListener.bind(lifecycle))
    vi.stubGlobal('removeEventListener', lifecycle.removeEventListener.bind(lifecycle))
    try {
    const editor = harness()
    const commands = new CommandManager()
    commands.setCtx(editor.ctx)
    editor.ctx.inject(commandsCtx, commands).record(CommandsReady)
    const ready = editor.ctx.wait(CommandsReady)
    editor.ctx.done(CommandsReady)
    await ready
    editor.ctx.inject(editorViewCtx, { get state() { return editor.state() }, dispatch: editor.dispatch } as unknown as EditorView)
    for (const command of [addRowBeforeCommand, addRowAfterCommand, addColBeforeCommand, addColAfterCommand, setAlignCommand, goToNextTableCellCommand, goToPrevTableCellCommand, deleteSelectedCellsCommand]) await command(editor.ctx)()
    configureNativeTableCommands(editor.ctx)
    editor.select(0, 1)
    expect(commands.call(addRowBeforeCommand.key)).toBe(true)
    expect(editor.data()[1]).toEqual(['Head A', 'Head B', 'Head C'])
    editor.select(2, 1)
    expect(commands.call(setAlignCommand.key, 'right')).toBe(true)
    editor.table().node.forEach((row) => expect(row.child(1).attrs.alignment).toBe('right'))
    editor.selectCells(0, 0, 0, 2)
    expect(commands.call(deleteSelectedCellsCommand.key)).toBe(true)
    expect(editor.data()[0]).toEqual(['Head A', 'Head B', 'Head C'])
    editor.roundTrip()
    } finally { vi.unstubAllGlobals() }
  })
})
