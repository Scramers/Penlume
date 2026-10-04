import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { EditorBookmark } from '../src/shared/document-history'
import { restoreSourceBookmark, sourceBookmarkField, sourceEditorBookmark } from '../src/renderer/editor/source-bookmark'

const markdown = '| A | B |\n| --- | --- |\n| C | D |\n'
const rectangle: EditorBookmark = {
  anchor: 29, head: 2,
  tableSelection: { sourceOffset: 0, anchor: { row: 1, column: 1 }, head: { row: 0, column: 0 } },
}
const create = () => EditorState.create({ doc: markdown, extensions: [sourceBookmarkField] })
const restore = (state: EditorState) => state.update({ selection: { anchor: rectangle.anchor, head: rectangle.head }, effects: restoreSourceBookmark.of(rectangle) }).state

describe('source view carries a restored rectangular table selection', () => {
  it('retains reverse anchor/head coordinates across source focus and scroll transactions', () => {
    let state = restore(create())
    state = state.update({}).state
    expect(sourceEditorBookmark(state, 0.75)).toEqual({ ...rectangle, scrollRatio: 0.75 })
  })

  it('preserves the rectangle when display preferences reconfigure', () => {
    const display = new Compartment()
    let state = restore(EditorState.create({ doc: markdown, extensions: [sourceBookmarkField, display.of(EditorState.tabSize.of(2))] }))
    state = state.update({ effects: display.reconfigure(EditorState.tabSize.of(4)) }).state
    expect(state.tabSize).toBe(4)
    expect(sourceEditorBookmark(state).tableSelection).toEqual(rectangle.tableSelection)
  })

  it('drops rectangle metadata after an actual source selection action, even if the range later returns', () => {
    let state = restore(create())
    state = state.update({ selection: { anchor: 4 } }).state
    expect(sourceEditorBookmark(state)).toEqual({ anchor: 4, head: 4, scrollRatio: 0 })
    state = state.update({ selection: { anchor: rectangle.anchor, head: rectangle.head } }).state
    expect(sourceEditorBookmark(state).tableSelection).toBeUndefined()
  })

  it('drops stale cell positions after source content edits', () => {
    const state = restore(create()).update({ changes: { from: 0, insert: '# Heading\n\n' } }).state
    expect(sourceEditorBookmark(state).tableSelection).toBeUndefined()
  })

  it('allows an explicit history snapshot to restore metadata with the replacement document', () => {
    let state = restore(create()).update({ changes: { from: 0, to: markdown.length, insert: 'Changed' } }).state
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: markdown }, selection: { anchor: rectangle.anchor, head: rectangle.head }, effects: restoreSourceBookmark.of(rectangle) }).state
    expect(state.doc.toString()).toBe(markdown)
    expect(sourceEditorBookmark(state).tableSelection).toEqual(rectangle.tableSelection)
  })

  it('never carries table metadata into a different or multiple source range', () => {
    const state = create().update({ selection: EditorSelection.create([EditorSelection.range(1, 3), EditorSelection.range(5, 7)]), effects: restoreSourceBookmark.of(rectangle) }).state
    expect(sourceEditorBookmark(state).tableSelection).toBeUndefined()
  })
})
