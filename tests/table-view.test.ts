import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Schema, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { CellSelection, tableEditing, tableNodes, TableMap } from '@milkdown/kit/prose/tables'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/kit/prose/view'
import { isTableContentMouseEvent, nativeTableSelectionView } from '../src/renderer/editor/table-view'

// The NodeView here is an opaque host fixture, not a reimplementation of Crepe.
// These tests exercise event routing with the real ProseMirror tableEditing
// plugin. The actual Crepe/Vue view is covered by table-tools-smoke.mjs.

class ElementFixture {
  readonly nodeType = 1
  readonly nodeName: string
  parentElement: ElementFixture | null = null
  get parentNode(): ElementFixture | null { return this.parentElement }
  readonly children: ElementFixture[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  className = ''
  removed = false
  readonly classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ') },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
  }
  constructor(tag: string) { this.nodeName = tag.toUpperCase() }
  appendChild(node: ElementFixture): ElementFixture { node.parentElement = this; this.children.push(node); return node }
  contains(node: { parentElement?: ElementFixture | null } | null): boolean {
    for (let cursor: typeof node = node; cursor; cursor = cursor.parentElement ?? null) if (cursor === this) return true
    return false
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  closest(selector: string): ElementFixture | null {
    const matches = (element: ElementFixture, part: string) => {
      if (part.startsWith('.')) return element.classList.contains(part.slice(1))
      const attribute = part.match(/^\[([^=]+)="([^\"]+)"\]$/)
      if (attribute) return element.attributes.get(attribute[1]) === attribute[2]
      return element.nodeName.toLowerCase() === part.toLowerCase()
    }
    for (let element: ElementFixture | null = this; element; element = element.parentElement) if (selector.split(',').some((part) => matches(element!, part.trim()))) return element
    return null
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: Event) => void): void { this.listeners.get(type)?.delete(listener) }
  remove(): void { this.removed = true }
}

const mouse = (target: ElementFixture | object, type = 'mousedown', options: Partial<MouseEvent> = {}) => ({ type, target, button: 0, clientX: 110, clientY: 110, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), ...options }) as unknown as MouseEvent
const raf: FrameRequestCallback[] = []
interface ViewFixture extends NodeView {
  node: ProseMirrorNode
  nodeRef: { value: ProseMirrorNode }
  app: { unmount: () => void }
}

function harness() {
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
    ...tableNodes({ tableGroup: 'block', cellContent: 'paragraph', cellAttributes: {} }),
  } })
  const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text))
  const row = (index: number) => schema.nodes.table_row.create(null, Array.from({ length: 3 }, (_, column) => (index ? schema.nodes.table_cell : schema.nodes.table_header).create(null, paragraph(`${index}:${column}`))))
  const table = schema.nodes.table.create(null, [row(0), row(1)])
  const doc = schema.nodes.doc.create(null, table), map = TableMap.get(table)
  const cellPos = (row: number, column: number) => 1 + map.map[row * map.width + column]
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, cellPos(0, 0) + 2), plugins: [tableEditing()] })
  const prose = new ElementFixture('div')
  const view = {
    get state() { return state },
    editable: true,
    dom: prose,
    root: prose,
    posAtCoords: ({ left, top }: { left: number; top: number }) => {
      const pos = cellPos(Math.min(1, Math.floor(top / 100)), Math.min(2, Math.floor(left / 100)))
      return { pos: pos + 2, inside: pos + 1 }
    },
    dispatch: (tr: ReturnType<EditorState['tr']['setSelection']>) => { state = state.applyTransaction(tr).state },
  } as unknown as EditorView
  const native: ViewFixture = {
    dom: new ElementFixture('div') as unknown as HTMLElement,
    contentDOM: new ElementFixture('tbody') as unknown as HTMLElement,
    node: table,
    nodeRef: { value: table },
    app: { unmount: vi.fn() },
    stopEvent: vi.fn(() => true),
    update(next) { this.node = next; this.nodeRef.value = next; return true },
    ignoreMutation: vi.fn((mutation) => mutation.type !== 'selection'),
    destroy() { this.app.unmount(); this.dom.remove(); this.contentDOM!.remove() },
  }
  prose.appendChild(native.dom as unknown as ElementFixture)
  const tableElement = (native.dom as unknown as ElementFixture).appendChild(new ElementFixture('table'))
  tableElement.appendChild(native.contentDOM as unknown as ElementFixture)
  const cells: ElementFixture[][] = []
  for (let row = 0; row < 2; row++) {
    const tr = (native.contentDOM as unknown as ElementFixture).appendChild(new ElementFixture('tr'))
    cells.push(Array.from({ length: 3 }, () => tr.appendChild(new ElementFixture(row ? 'td' : 'th')).appendChild(new ElementFixture('p'))))
  }
  const selection = (row: number, column: number) => view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, cellPos(row, column) + 2)))
  const event = (row = 1, column = 1, type = 'mousedown', options: Partial<MouseEvent> = {}) => mouse(cells[row][column], type, { clientX: column * 100 + 10, clientY: row * 100 + 10, ...options })
  const processMouseDown = (nodeView: NodeView, event: MouseEvent) => {
    const plugin = state.plugins.find((plugin) => plugin.spec.props?.handleDOMEvents?.mousedown)
    if (!nodeView.stopEvent?.(event) && plugin) plugin.props.handleDOMEvents?.mousedown?.call(plugin, view, event)
  }
  const wrap = () => nativeTableSelectionView(() => (() => native) as NodeViewConstructor)(table, view, () => 0, [], null as never)
  return { native, wrap, view, cells, prose, state: () => state, doc, cellPos, selection, event, processMouseDown }
}

beforeEach(() => {
  raf.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { raf.push(callback); return raf.length })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native table mouse selection routing', () => {
  it('demonstrates that an intercepting NodeView prevents the real tableEditing handler from seeing Shift-click', () => {
    const editor = harness(), event = editor.event(1, 1, 'mousedown', { shiftKey: true })
    editor.processMouseDown(editor.native, event)
    expect(editor.state().selection).toBeInstanceOf(TextSelection)
    expect(editor.native.stopEvent).toHaveBeenCalledWith(event)
    expect(editor.state().doc.eq(editor.doc)).toBe(true)
  })

  it('lets the real tableEditing mousedown handler create a 2 by 2 rectangular CellSelection', () => {
    const editor = harness(), original = vi.spyOn(editor.native, 'stopEvent'), wrapped = editor.wrap()
    editor.processMouseDown(wrapped, editor.event(1, 1, 'mousedown', { shiftKey: true }))
    expect(original).not.toHaveBeenCalled()
    expect(raf).toHaveLength(0)
    expect(editor.state().selection).toBeInstanceOf(CellSelection)
    const selection = editor.state().selection as CellSelection
    expect(selection.$anchorCell.pos).toBe(editor.cellPos(0, 0))
    expect(selection.$headCell.pos).toBe(editor.cellPos(1, 1))
    let selected = 0; selection.forEachCell(() => selected++)
    expect(selected).toBe(4)
    editor.state().doc.check(); expect(editor.state().doc.eq(editor.doc)).toBe(true)
  })

  it('allows the real tableEditing drag listeners to make a rectangle and finish without changing cell text', () => {
    const editor = harness(), original = vi.spyOn(editor.native, 'stopEvent'), wrapped = editor.wrap()
    editor.processMouseDown(wrapped, editor.event(0, 0))
    expect(editor.prose.listeners.get('mousemove')?.size).toBe(1)
    for (const listener of editor.prose.listeners.get('mousemove') ?? []) listener(editor.event(1, 1, 'mousemove'))
    expect(editor.state().selection).toBeInstanceOf(CellSelection)
    const selection = editor.state().selection as CellSelection
    expect(selection.$anchorCell.pos).toBe(editor.cellPos(0, 0)); expect(selection.$headCell.pos).toBe(editor.cellPos(1, 1))
    for (const listener of editor.prose.listeners.get('mouseup') ?? []) listener(editor.event(1, 1, 'mouseup'))
    expect(editor.prose.listeners.get('mousemove')?.size).toBe(0)
    expect(editor.prose.listeners.get('mouseup')?.size).toBe(0)
    expect(editor.state().selection.eq(selection)).toBe(true)
    expect(original).not.toHaveBeenCalled(); expect(editor.state().doc.eq(editor.doc)).toBe(true)
  })

  it('keeps both pointerdown and mousedown off the host handler while extending an existing CellSelection', () => {
    vi.useFakeTimers()
    const editor = harness(), original = vi.spyOn(editor.native, 'stopEvent'), wrapped = editor.wrap()
    editor.view.dispatch(editor.state().tr.setSelection(CellSelection.create(editor.state().doc, editor.cellPos(0, 0), editor.cellPos(1, 1))))
    expect(wrapped.stopEvent?.(editor.event(1, 2, 'pointerdown', { shiftKey: true }))).toBe(false)
    editor.processMouseDown(wrapped, editor.event(1, 2, 'mousedown', { shiftKey: true }))
    vi.runAllTimers(); raf.forEach((callback) => callback(0))
    expect(original).not.toHaveBeenCalled()
    expect(editor.state().selection).toBeInstanceOf(CellSelection)
    const selection = editor.state().selection as CellSelection
    expect(selection.$anchorCell.pos).toBe(editor.cellPos(0, 0))
    expect(selection.$headCell.pos).toBe(editor.cellPos(1, 2))
  })

  it('allows ordinary primary clicks in cell prose and text-node targets to use the native caret route', () => {
    const editor = harness(), wrapped = editor.wrap(), target = editor.cells[1][1]
    expect(wrapped.stopEvent?.(editor.event())).toBe(false)
    const text = { nodeType: 3, parentElement: target }
    expect(wrapped.stopEvent?.(mouse(text))).toBe(false)
    expect(raf).toHaveLength(0)
  })

  it.each(['button', 'input', 'textarea', 'select'])('preserves the original handler for an embedded %s', (tag) => {
    const editor = harness(), original = vi.spyOn(editor.native, 'stopEvent'), wrapped = editor.wrap()
    const target = editor.cells[1][1].appendChild(new ElementFixture(tag))
    const event = mouse(target)
    wrapped.stopEvent?.(event)
    expect(original).toHaveBeenCalledOnce(); expect(original).toHaveBeenCalledWith(event)
  })

  it.each(['atomic', 'tool', 'handle', 'resize'])('preserves the original handler for an embedded %s widget', (kind) => {
    const editor = harness(), original = vi.spyOn(editor.native, 'stopEvent'), wrapped = editor.wrap()
    const target = editor.cells[1][1].appendChild(new ElementFixture('span'))
    if (kind === 'atomic') target.setAttribute('contenteditable', 'false')
    if (kind === 'tool') target.setAttribute('data-display-type', 'tool')
    if (kind === 'handle') target.classList.add('handle')
    if (kind === 'resize') target.classList.add('column-resize-handle')
    const event = mouse(target)
    wrapped.stopEvent?.(event)
    expect(original).toHaveBeenCalledOnce(); expect(original).toHaveBeenCalledWith(event)
  })

  it.each(['drop', 'dragstart', 'dragover', 'dragend'])('keeps upstream %s handling intact', (type) => {
    const editor = harness(), original = vi.spyOn(editor.native, 'stopEvent'), wrapped = editor.wrap(), event = editor.event(1, 1, type)
    expect(wrapped.stopEvent?.(event)).toBe(true)
    expect(original).toHaveBeenCalledOnce(); expect(original).toHaveBeenCalledWith(event)
  })

  it('keeps drag-preview cells, the contentDOM boundary, outside events and non-primary buttons on the original route', () => {
    const editor = harness(), original = vi.spyOn(editor.native, 'stopEvent'), wrapped = editor.wrap()
    const preview = (editor.native.dom as unknown as ElementFixture).appendChild(new ElementFixture('table')).appendChild(new ElementFixture('td')).appendChild(new ElementFixture('p'))
    const events = [mouse(preview), mouse(editor.native.contentDOM as unknown as ElementFixture), mouse(new ElementFixture('div')), editor.event(1, 1, 'mousedown', { button: 2 }), mouse({})]
    for (const event of events) wrapped.stopEvent?.(event)
    expect(original).toHaveBeenCalledTimes(events.length)
    for (const event of events) expect(original).toHaveBeenCalledWith(event)
  })

  it('retains the native view instance, contentDOM, update, mutation and destroy lifecycle', () => {
    const editor = harness(), native = editor.native, wrapped = editor.wrap()
    expect(wrapped).toBe(native); expect(wrapped.contentDOM).toBe(native.contentDOM)
    const changedParagraph = editor.view.state.schema.nodes.paragraph.create(null, editor.view.state.schema.text('changed'))
    const changedCell = native.node.child(1).child(0).type.create(null, changedParagraph)
    const changedRow = native.node.child(1).copy(native.node.child(1).content.replaceChild(0, changedCell))
    const next: ProseMirrorNode = native.node.copy(native.node.content.replaceChild(1, changedRow))
    expect(wrapped.update?.(next, [], null as never)).toBe(true)
    expect(native.node).toBe(next); expect(native.nodeRef.value).toBe(next)
    expect(wrapped.ignoreMutation?.({ type: 'selection', target: native.contentDOM } as never)).toBe(false)
    expect(wrapped.ignoreMutation?.({ type: 'attributes', target: native.contentDOM } as never)).toBe(true)
    const unmount = vi.spyOn(native.app, 'unmount')
    wrapped.destroy?.()
    expect(unmount).toHaveBeenCalledOnce()
    expect((native.dom as unknown as ElementFixture).removed).toBe(true)
    expect((native.contentDOM as unknown as ElementFixture).removed).toBe(true)
  })

  it('keeps the same table view across actual ProseMirror CellSelection and caret decoration changes', () => {
    const editor = harness(), original = vi.spyOn(editor.native, 'update').mockReturnValue(false), destroy = vi.spyOn(editor.native, 'destroy')
    const wrapped = editor.wrap(), dom = wrapped.dom, contentDOM = wrapped.contentDOM, originalTable = editor.state().doc.firstChild!
    const plugin = editor.state().plugins.find((plugin) => plugin.spec.props?.decorations)!
    editor.view.dispatch(editor.state().tr.setSelection(CellSelection.create(editor.state().doc, editor.cellPos(0, 0), editor.cellPos(1, 1))))
    const selectedDecorations = plugin.props.decorations!.call(plugin, editor.state()) as DecorationSet
    expect(selectedDecorations.find()).toHaveLength(4)
    const focusDecoration = Decoration.node(0, originalTable.nodeSize, { class: 'ttypora-focus-block' })
    expect(wrapped.update?.(editor.state().doc.firstChild!, [focusDecoration], selectedDecorations)).toBe(true)
    editor.selection(0, 2)
    const caretDecorations = (plugin.props.decorations!.call(plugin, editor.state()) ?? DecorationSet.empty) as DecorationSet
    expect(caretDecorations.find()).toHaveLength(0)
    expect(wrapped.update?.(editor.state().doc.firstChild!, [], caretDecorations)).toBe(true)
    expect(original).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled()
    expect(wrapped.dom).toBe(dom); expect(wrapped.contentDOM).toBe(contentDOM)
    expect(editor.native.nodeRef.value).toBe(originalTable)
    expect((dom as unknown as ElementFixture).removed).toBe(false)
    expect(editor.state().doc.eq(editor.doc)).toBe(true)
  })

  it('keeps semantically equal cloned table nodes without forcing the host to refresh its reactive node reference', () => {
    const editor = harness(), original = vi.spyOn(editor.native, 'update').mockReturnValue(false), wrapped = editor.wrap()
    const clone = editor.view.state.schema.nodeFromJSON(editor.native.node.toJSON())
    expect(clone).not.toBe(editor.native.node); expect(clone.eq(editor.native.node)).toBe(true)
    expect(wrapped.update?.(clone, [], DecorationSet.empty)).toBe(true)
    expect(wrapped.update?.(clone.copy(clone.content), [], DecorationSet.empty)).toBe(true)
    expect(original).not.toHaveBeenCalled()
    expect(wrapped.dom).toBe(editor.native.dom); expect(editor.native.nodeRef.value).toBe(editor.doc.firstChild)
  })

  it('forwards real document edits and resize attributes to the native update and tracks each accepted node', () => {
    const editor = harness(), original = vi.spyOn(editor.native, 'update'), wrapped = editor.wrap()
    editor.view.dispatch(editor.state().tr.insertText(' edited', editor.cellPos(1, 1) + 2))
    const edited = editor.state().doc.firstChild!, inner = DecorationSet.empty, outer = [Decoration.node(0, edited.nodeSize, { class: 'changed-table' })]
    expect(edited.eq(editor.doc.firstChild!)).toBe(false)
    expect(wrapped.update?.(edited, outer, inner)).toBe(true)
    expect(original).toHaveBeenCalledWith(edited, outer, inner)
    expect(editor.native.node).toBe(edited); expect(editor.native.nodeRef.value).toBe(edited)
    expect(wrapped.update?.(editor.view.state.schema.nodeFromJSON(edited.toJSON()), [], inner)).toBe(true)
    expect(original).toHaveBeenCalledTimes(1)
    const table = editor.state().doc.firstChild!, firstBodyCell = table.child(1).firstChild!
    editor.view.dispatch(editor.state().tr.setNodeMarkup(editor.cellPos(1, 0), undefined, { ...firstBodyCell.attrs, colwidth: [120] }))
    const resized = editor.state().doc.firstChild!
    expect(resized.eq(edited)).toBe(false)
    expect(wrapped.update?.(resized, [], inner)).toBe(true)
    expect(original).toHaveBeenCalledTimes(2)
    expect(editor.native.nodeRef.value).toBe(resized)
    expect(wrapped.update?.(resized, [], inner)).toBe(true); expect(original).toHaveBeenCalledTimes(2)
    editor.state().doc.check()
  })

  it('preserves native rejection and does not treat a rejected document or another node type as the current table', () => {
    const editor = harness(), original = vi.spyOn(editor.native, 'update').mockReturnValue(false), wrapped = editor.wrap()
    editor.view.dispatch(editor.state().tr.insertText(' rejected', editor.cellPos(1, 1) + 2))
    const rejected = editor.state().doc.firstChild!
    expect(wrapped.update?.(rejected, [], DecorationSet.empty)).toBe(false)
    expect(wrapped.update?.(rejected, [], DecorationSet.empty)).toBe(false)
    expect(original).toHaveBeenCalledTimes(2)
    expect(wrapped.update?.(editor.doc.firstChild!, [], DecorationSet.empty)).toBe(true)
    expect(original).toHaveBeenCalledTimes(2)
    const paragraph = editor.view.state.schema.nodes.paragraph.create(null, editor.view.state.schema.text('Different type'))
    expect(wrapped.update?.(paragraph, [], DecorationSet.empty)).toBe(false)
    expect(original).toHaveBeenCalledWith(paragraph, [], DecorationSet.empty)
    expect(original).toHaveBeenCalledTimes(3)
  })

  it('does not bypass a NodeView without contentDOM and leaves absent original handlers unblocked', () => {
    const dom = new ElementFixture('div'), target = dom.appendChild(new ElementFixture('td'))
    const nodeView: NodeView = { dom: dom as unknown as HTMLElement }
    expect(isTableContentMouseEvent(nodeView, mouse(target))).toBe(false)
    const wrapped = nativeTableSelectionView(() => (() => nodeView) as NodeViewConstructor)(null as never, null as never, () => 0, [], null as never)
    expect(wrapped.stopEvent?.(mouse(target))).toBe(false)
    expect(wrapped.update).toBeUndefined()
  })
})
