import type { MarkdownHeading } from '../shared/markdown-outline'

export interface OutlineTreeNode {
  readonly heading: MarkdownHeading
  readonly index: number
  readonly parent: number | null
  readonly children: readonly number[]
  readonly depth: number
}
export interface OutlineTree {
  readonly headings: readonly MarkdownHeading[]
  readonly nodes: readonly OutlineTreeNode[]
  readonly roots: readonly number[]
  readonly signature: string
  readonly valid: boolean
}
export interface OutlineDocumentControls {
  readonly signature: string
  readonly collapsed: ReadonlySet<number>
  readonly query: string
  readonly flat: boolean
}
export type OutlineControlsStore = ReadonlyMap<string, OutlineDocumentControls>
type OwnedTree = { documentId: string; tree: OutlineTree }
export type OutlineDocumentControlAction = OwnedTree & (
  | { type: 'reconcile' }
  | { type: 'fold'; index: number }
  | { type: 'query'; query: string }
  | { type: 'flat'; flat: boolean }
)
export type OutlineControlAction = OutlineDocumentControlAction | { type: 'retain'; documentIds: readonly string[] }
export interface OutlineProjectedRow extends OutlineTreeNode {
  readonly match: boolean
  readonly context: boolean
  readonly expandable: boolean
  readonly expanded: boolean
}
export interface OutlineProjection {
  readonly rows: readonly OutlineProjectedRow[]
  readonly visible: ReadonlySet<number>
  readonly searching: boolean
  readonly normalizedQuery: string
}

/** Build once per canonical heading-array identity, never from Markdown or a
 * selection event. Strictly lower heading levels are real ancestors; skipped
 * levels and leading H3 headings do not create synthetic parents. Original
 * heading objects and indexes are retained for App's exact snapshot guard. */
export function buildOutlineTree(headings: readonly MarkdownHeading[]): OutlineTree {
  const nodes: { heading: MarkdownHeading; index: number; parent: number | null; children: number[]; depth: number }[] = []
  const roots: number[] = [], stack: number[] = []
  let valid = true
  headings.forEach((heading, index) => {
    if (!Number.isInteger(heading.level) || heading.level < 1 || heading.level > 6) valid = false
    while (stack.length && headings[stack[stack.length - 1]].level >= heading.level) stack.pop()
    const parent = stack.at(-1) ?? null
    nodes.push({ heading, index, parent, children: [], depth: parent === null ? 0 : nodes[parent].depth + 1 })
    if (parent === null) roots.push(index)
    else nodes[parent].children.push(index)
    stack.push(index)
  })
  // Line shifts caused by body edits keep controls. Any observable title/level
  // sequence change invalidates index-based folds, including deletion and undo.
  const signature = JSON.stringify(headings.map(({ level, text }) => [level, text]))
  return { headings, nodes, roots, signature, valid }
}

export function controlsForOutlineTree(state: OutlineDocumentControls | undefined, tree: OutlineTree): OutlineDocumentControls {
  return state?.signature === tree.signature ? state : {
    signature: tree.signature, collapsed: new Set<number>(), query: state?.query ?? '', flat: state?.flat ?? false,
  }
}

/** Only current READY Sidebar/App owners may dispatch document actions. The
 * signature check adds a second barrier against a captured old fold index.
 * Reconciliation keeps query/layout but never guesses identity for renamed,
 * added, removed or reordered headings, including repeated/empty labels. */
export function outlineControlsReducer(store: OutlineControlsStore, action: OutlineControlAction): OutlineControlsStore {
  if (action.type === 'retain') {
    const retained = new Set(action.documentIds)
    if ([...store.keys()].every((id) => retained.has(id))) return store
    return new Map([...store].filter(([id]) => retained.has(id)))
  }
  if (!action.documentId || !action.tree.valid) return store
  const saved = store.get(action.documentId)
  const current = controlsForOutlineTree(saved, action.tree)
  if (action.type === 'reconcile') {
    if (current === saved) return store
  } else {
    if (saved && saved.signature !== action.tree.signature) return store
    if (action.type === 'fold') {
      const node = action.tree.nodes[action.index]
      if (!Number.isSafeInteger(action.index) || !node?.children.length) return store
      const collapsed = new Set(current.collapsed)
      if (collapsed.has(action.index)) collapsed.delete(action.index)
      else collapsed.add(action.index)
      return new Map(store).set(action.documentId, { ...current, collapsed })
    }
    if (action.type === 'query') {
      if (saved && current.query === action.query) return store
      return new Map(store).set(action.documentId, { ...current, query: action.query })
    }
    if (action.type === 'flat') {
      if (saved && current.flat === action.flat) return store
      return new Map(store).set(action.documentId, { ...current, flat: action.flat })
    }
  }
  return new Map(store).set(action.documentId, current)
}

/** Search all title labels, temporarily ignoring level and folds, and include
 * every actual ancestor as context. Flat mode omits tree indentation/folding;
 * neither projection mutates the saved controls. Normal tree mode collapses
 * complete descendant branches, not arbitrary subsequent rows. */
export function projectOutlineRows(tree: OutlineTree, state: OutlineDocumentControls, maxLevel = 6): OutlineProjection {
  const normalizedQuery = state.query.trim().toLowerCase(), searching = Boolean(normalizedQuery)
  const visible = new Set<number>(), rows: OutlineProjectedRow[] = []
  if (!tree.valid || !Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 6) return { rows, visible, searching, normalizedQuery }
  const controls = controlsForOutlineTree(state, tree)
  const matches = tree.nodes.map(({ heading }) => searching && heading.text.toLowerCase().includes(normalizedQuery))
  const included = tree.nodes.map(({ heading }, index) => searching ? matches[index] : heading.level <= maxLevel)
  if (searching) tree.nodes.forEach((node) => {
    if (!matches[node.index]) return
    for (let parent = node.parent; parent !== null && !included[parent]; parent = tree.nodes[parent].parent) included[parent] = true
  })
  const folding = !controls.flat && !searching, hidden: boolean[] = []
  tree.nodes.forEach((node) => {
    hidden[node.index] = folding && node.parent !== null && (hidden[node.parent] || controls.collapsed.has(node.parent))
    if (!included[node.index] || hidden[node.index]) return
    const expandable = !controls.flat && node.children.some((index) => included[index])
    const expanded = expandable && (!folding || !controls.collapsed.has(node.index))
    rows.push({ ...node, depth: controls.flat ? 0 : node.depth, match: matches[node.index], context: searching && !matches[node.index], expandable, expanded })
    visible.add(node.index)
  })
  return { rows, visible, searching, normalizedQuery }
}

/** Selection-only work: at most six real parent steps, no label/line read,
 * parser, row reconstruction or editor transaction. A nearby visible sibling
 * is never a substitute for the current heading's ancestor. */
export function projectActiveOutlineIndex(tree: OutlineTree, visible: ReadonlySet<number>, activeIndex: number | null): number | null {
  if (!tree.valid || activeIndex === null || !Number.isSafeInteger(activeIndex) || activeIndex < 0 || activeIndex >= tree.nodes.length) return null
  for (let index: number | null = activeIndex; index !== null; index = tree.nodes[index].parent) if (visible.has(index)) return index
  return null
}
