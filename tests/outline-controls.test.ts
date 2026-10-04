import { describe, expect, it } from 'vitest'
import { buildOutlineTree, controlsForOutlineTree, outlineControlsReducer, projectActiveOutlineIndex, projectOutlineRows, type OutlineControlsStore, type OutlineTree } from '../src/renderer/outline-controls'

const headings = (levels: number[], labels = levels.map((_, index) => `Heading ${index}`)) => levels.map((level, index) => Object.freeze({ level, line: index * 3 + 1, text: labels[index] }))
const indexes = (tree: OutlineTree, state = controlsForOutlineTree(undefined, tree), limit = 6) => projectOutlineRows(tree, state, limit).rows.map(({ index }) => index)
const reconcile = (store: OutlineControlsStore, documentId: string, tree: OutlineTree) => outlineControlsReducer(store, { type: 'reconcile', documentId, tree })
const fold = (store: OutlineControlsStore, documentId: string, tree: OutlineTree, index: number) => outlineControlsReducer(store, { type: 'fold', documentId, tree, index })

describe('canonical outline hierarchy', () => {
  it('builds actual parents across skipped levels, leading orphans and closed sibling branches', () => {
    const source = Object.freeze(headings([3, 4, 1, 3, 4, 2, 5, 1, 2]))
    const tree = buildOutlineTree(source)
    expect(tree.nodes.map(({ parent }) => parent)).toEqual([null, 0, null, 2, 3, 2, 5, null, 7])
    expect(tree.nodes.map(({ depth }) => depth)).toEqual([0, 1, 0, 1, 2, 1, 2, 0, 1])
    expect(tree.roots).toEqual([0, 2, 7])
    tree.nodes.forEach((node) => expect(node.heading).toBe(source[node.index]))
    expect(tree.headings).toBe(source)
  })

  it('retains distinct indexes for duplicate and empty labels and never normalizes the canonical objects', () => {
    const source = Object.freeze(headings([1, 2, 2, 1], ['Repeat', '', '', 'Repeat']))
    const tree = buildOutlineTree(source)
    expect(indexes(tree)).toEqual([0, 1, 2, 3])
    expect(tree.nodes[1].heading).toBe(source[1])
    expect(tree.nodes[2].heading).toBe(source[2])
    expect(tree.nodes[1].parent).toBe(0)
    expect(tree.nodes[2].parent).toBe(0)
  })

  it.each([0, 7, 1.5, NaN])('makes invalid heading level %s non-navigable', (invalid) => {
    const tree = buildOutlineTree(headings([1, invalid]))
    expect(tree.valid).toBe(false)
    expect(indexes(tree)).toEqual([])
    expect(projectActiveOutlineIndex(tree, new Set([0]), 1)).toBeNull()
  })
})

describe('fold, flat and title search projections', () => {
  const tree = buildOutlineTree(headings([3, 4, 1, 2, 3, 2, 3, 1, 2], ['Orphan', 'Hit orphan', 'One', 'Branch', 'Hit one', 'Sibling', 'Hit two', 'Other root', 'Other body']))
  const base = controlsForOutlineTree(undefined, tree)

  it('collapses full descendants while preserving siblings and other roots', () => {
    expect(indexes(tree, { ...base, collapsed: new Set([3]) })).toEqual([0, 1, 2, 3, 5, 6, 7, 8])
    expect(indexes(tree, { ...base, collapsed: new Set([2]) })).toEqual([0, 1, 2, 7, 8])
    expect(indexes(tree, { ...base, collapsed: new Set([0, 2]) })).toEqual([0, 2, 7, 8])
  })

  it('flat mode restores all level-eligible headings without mutating stored folds or indexes', () => {
    const state = { ...base, collapsed: new Set([0, 2]), flat: true }
    const projected = projectOutlineRows(tree, state, 2)
    expect(projected.rows.map(({ index }) => index)).toEqual([2, 3, 5, 7, 8])
    expect(projected.rows.every(({ depth, expandable }) => depth === 0 && !expandable)).toBe(true)
    expect([...state.collapsed]).toEqual([0, 2])
    projected.rows.forEach((row) => expect(row.heading).toBe(tree.headings[row.index]))
    expect(indexes(tree, { ...state, flat: false }, 2)).toEqual([2, 7, 8])
  })

  it('searches every canonical title irrespective of level/collapse and includes only matching rows and real ancestors', () => {
    const state = { ...base, collapsed: new Set([0, 2]), query: '  HIT  ' }
    const result = projectOutlineRows(tree, state, 1)
    expect(result.rows.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(result.rows.filter(({ match }) => match).map(({ index }) => index)).toEqual([1, 4, 6])
    expect(result.rows.filter(({ context }) => context).map(({ index }) => index)).toEqual([0, 2, 3, 5])
    expect(result.rows.filter(({ expandable }) => expandable).every(({ expanded }) => expanded)).toBe(true)
    expect([...state.collapsed]).toEqual([0, 2])
    expect(indexes(tree, { ...state, query: '' }, 1)).toEqual([2, 7])
  })

  it('flat search also retains all matching contexts, while a whitespace-only query restores normal folds/depth', () => {
    const state = { ...base, query: 'hit', collapsed: new Set([2]), flat: true }
    expect(indexes(tree, state, 1)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(projectOutlineRows(tree, state, 1).rows.every(({ depth }) => depth === 0)).toBe(true)
    expect(indexes(tree, { ...state, flat: false, query: ' \t ' }, 2)).toEqual([2, 7, 8])
    expect(projectOutlineRows(tree, { ...base, query: 'absent' }).rows).toEqual([])
  })

  it('projects hidden current headings only to an actual visible ancestor, never a nearby match or closed branch', () => {
    const collapsed = projectOutlineRows(tree, { ...base, collapsed: new Set([2]) })
    expect(projectActiveOutlineIndex(tree, collapsed.visible, 6)).toBe(2)
    const queried = projectOutlineRows(tree, { ...base, query: 'Hit one' })
    expect(projectActiveOutlineIndex(tree, queried.visible, 6)).toBe(2)
    expect(projectActiveOutlineIndex(tree, queried.visible, 8)).toBeNull()
    const shallow = projectOutlineRows(tree, base, 2)
    expect(projectActiveOutlineIndex(tree, shallow.visible, 1)).toBeNull()
    expect(projectActiveOutlineIndex(tree, shallow.visible, 6)).toBe(5)
  })

  it.each([null, -1, 0.5, 99, NaN])('rejects unavailable/stale current index %s', (index) => {
    expect(projectActiveOutlineIndex(tree, new Set([0, 2]), index)).toBeNull()
  })

  it('selection-only ancestor projection does not inspect titles, source lines or iterate the visible set', () => {
    const cached = buildOutlineTree(headings([1, 2, 3, 4, 5, 6]))
    // Reject any later heading/label/line read or visible-set scan: the caret
    // path must use cached parent coordinates and membership lookups only.
    const guarded = { ...cached, nodes: cached.nodes.map((node) => ({ ...node, get heading(): never { throw new Error('No heading read for a caret-only lookup') } })) }
    const visible = new Proxy(new Set([0]), { get(target, key) { if (key === Symbol.iterator) throw new Error('No visible-set scan'); const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value } })
    expect(projectActiveOutlineIndex(guarded, visible, 5)).toBe(0)
  })
})

describe('document-owned controls and structural invalidation', () => {
  const tree = buildOutlineTree(headings([1, 2, 1], ['Repeated', 'Child', 'Repeated']))

  it('isolates two unsaved document IDs, preserves controls through Save As identity, and prunes a closed tab', () => {
    let store: OutlineControlsStore = reconcile(new Map(), 'unsaved-a', tree)
    store = reconcile(store, 'unsaved-b', tree)
    store = fold(store, 'unsaved-a', tree, 0)
    expect([...store.get('unsaved-a')!.collapsed]).toEqual([0])
    expect([...store.get('unsaved-b')!.collapsed]).toEqual([])
    // Paths are intentionally not accepted by the state API. Save As retains
    // the same document ID and therefore the exact same control entry.
    expect(reconcile(store, 'unsaved-a', tree)).toBe(store)
    const retained = outlineControlsReducer(store, { type: 'retain', documentIds: ['unsaved-b'] })
    expect([...retained.keys()]).toEqual(['unsaved-b'])
    expect(store.has('unsaved-a')).toBe(true)
  })

  it('preserves folds for body-only line shifts and ignores repeated ready reconciliation', () => {
    const shifted = buildOutlineTree(tree.headings.map((heading) => ({ ...heading, line: heading.line + 50 })))
    let store = reconcile(new Map(), 'doc', tree)
    store = fold(store, 'doc', tree, 0)
    expect(shifted.signature).toBe(tree.signature)
    expect(reconcile(store, 'doc', shifted)).toBe(store)
    expect(indexes(shifted, store.get('doc')!)).toEqual([0, 2])
  })

  it.each([
    headings([1, 2, 1], ['Renamed', 'Child', 'Repeated']),
    headings([1, 3, 1], ['Repeated', 'Child', 'Repeated']),
    headings([1, 1], ['Repeated', 'Repeated']),
    headings([1, 2, 2, 1], ['Repeated', 'Child', 'Added', 'Repeated']),
    headings([1, 1, 2], ['Repeated', 'Repeated', 'Child']),
  ].map((changed) => ({ changed })))('clears index folds after observable title-structure changes but retains query/layout', ({ changed }) => {
    let store = fold(reconcile(new Map(), 'doc', tree), 'doc', tree, 0)
    store = outlineControlsReducer(store, { type: 'query', documentId: 'doc', tree, query: 'Repeated' })
    store = outlineControlsReducer(store, { type: 'flat', documentId: 'doc', tree, flat: true })
    const next = buildOutlineTree(changed)
    const reconciled = reconcile(store, 'doc', next)
    expect([...reconciled.get('doc')!.collapsed]).toEqual([])
    expect(reconciled.get('doc')!.query).toBe('Repeated')
    expect(reconciled.get('doc')!.flat).toBe(true)
    expect(outlineControlsReducer(reconciled, { type: 'fold', documentId: 'doc', tree, index: 0 })).toBe(reconciled)
    expect([...reconcile(reconciled, 'doc', tree).get('doc')!.collapsed]).toEqual([])
  })

  it('does not toggle leaves/invalid indexes or mutate prior store/set snapshots', () => {
    const store = reconcile(new Map(), 'doc', tree), oldSet = store.get('doc')!.collapsed
    for (const index of [-1, 0.5, 1, 2, 500]) expect(fold(store, 'doc', tree, index)).toBe(store)
    const next = fold(store, 'doc', tree, 0)
    expect([...oldSet]).toEqual([])
    expect([...next.get('doc')!.collapsed]).toEqual([0])
    expect([...fold(next, 'doc', tree, 0).get('doc')!.collapsed]).toEqual([])
  })
})
