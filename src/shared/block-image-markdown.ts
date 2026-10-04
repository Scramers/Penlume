/** The editor keeps an image's description, caption and resize ratio separately. */
export interface BlockImageAttributes {
  src: string
  alt: string
  caption: string
  ratio: number
  /** Captured only on an explicit user resize. null/absent retains legacy percentage sizing. */
  resizeWidth?: number | null
}

export interface BlockImageMarkdownNode {
  type: string
  value?: string
  url?: string
  alt?: string | null
  title?: string | null
  ttyporaRatio?: number
  ttyporaResizeWidth?: number | null
  children?: BlockImageMarkdownNode[]
  position?: unknown
}

export function blockImageRatio(value: unknown): number {
  // Resize metadata comes from document HTML, so bound it before it reaches the native layout.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.0001 || value > 10) return 1
  return value
}

export function blockImageResizeWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100000 ? value : null
}

/** Only our explicit HTML metadata carries a resize ratio; numeric Markdown alt is text. */
export function blockImageAttributes(node: { url?: unknown; alt?: unknown; title?: unknown; ttyporaRatio?: unknown; ttyporaResizeWidth?: unknown }): BlockImageAttributes {
  return { src: typeof node.url === 'string' ? node.url : '', alt: typeof node.alt === 'string' ? node.alt : '', caption: typeof node.title === 'string' ? node.title : '', ratio: blockImageRatio(node.ttyporaRatio), resizeWidth: blockImageResizeWidth(node.ttyporaResizeWidth) }
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>\t\r\n]/g, (character) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', '\t': '&#9;', '\r': '&#13;', '\n': '&#10;' })[character]!)
}

function decodeAttribute(value: string): string {
  return value.replace(/&(amp|quot|lt|gt|#9|#10|#13);/g, (_, entity: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#9': '\t', '#10': '\n', '#13': '\r' })[entity]!)
}

// Expand exponent notation so dimensions are also valid HTML/CSS values.
function decimal(value: number): string {
  const source = value.toString()
  if (!source.includes('e')) return source
  const [coefficient, exponent] = source.split('e')
  const digits = coefficient.replace('.', '')
  const point = (coefficient.indexOf('.') < 0 ? coefficient.length : coefficient.indexOf('.')) + Number(exponent)
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length)
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

/** null means ordinary Markdown. Resized images use a deliberately narrow, portable HTML form. */
export function serializeResizedBlockImage(attributes: BlockImageAttributes): string | null {
  const ratio = blockImageRatio(attributes.ratio)
  const resizeWidth = blockImageResizeWidth(attributes.resizeWidth)
  // Do not silently replace invalid explicit pixel metadata with percentage sizing.
  if (attributes.resizeWidth != null && resizeWidth === null) return null
  // A ratio of one can still carry a user-selected pixel width after reopening or resizing.
  if (ratio === 1 && resizeWidth === null) return null
  // Keep older generated percentages readable without rewriting them merely on load.
  const width = resizeWidth === null ? `${decimal(Number((ratio * 100).toPrecision(12)))}%` : decimal(resizeWidth)
  return `<img src="${escapeAttribute(attributes.src)}" alt="${escapeAttribute(attributes.alt)}" title="${escapeAttribute(attributes.caption)}" width="${width}" data-ttypora-ratio="${decimal(ratio)}">`
}

/** Recognize only the exact generated shape. All other HTML remains an editable raw HTML block. */
export function parseResizedBlockImage(html: string): BlockImageAttributes | null {
  const source = html.trim()
  const match = source.match(/^<img src="([^"<>\u0000-\u001f]*)" alt="([^"<>\u0000-\u001f]*)" title="([^"<>\u0000-\u001f]*)" width="([\d.]+)(%?)" data-ttypora-ratio="([\d.]+)">$/)
  if (!match) return null
  const attributes: BlockImageAttributes = { src: decodeAttribute(match[1]), alt: decodeAttribute(match[2]), caption: decodeAttribute(match[3]), ratio: Number(match[6]), resizeWidth: match[5] ? null : Number(match[4]) }
  // Equality rejects unknown entities, invalid pixel widths and inconsistent legacy percentages.
  return serializeResizedBlockImage(attributes) === source ? attributes : null
}

/** Promote standalone generated images before the general raw-HTML editor plugin runs. */
export function restoreResizedBlockImages(tree: BlockImageMarkdownNode): void {
  const blockContainers = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])
  const visit = (parent: BlockImageMarkdownNode) => {
    if (!blockContainers.has(parent.type) || !parent.children) return
    parent.children = parent.children.map((node) => {
      const raw = node.type === 'html' ? node : node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'html' ? node.children[0] : null
      const attributes = raw?.value ? parseResizedBlockImage(raw.value) : null
      if (attributes) return { type: 'image-block', url: attributes.src, alt: attributes.alt, title: attributes.caption, ttyporaRatio: attributes.ratio, ttyporaResizeWidth: attributes.resizeWidth ?? null, position: node.position }
      if (node.type === 'list' && node.children) node.children.forEach(visit)
      else visit(node)
      return node
    })
  }
  visit(tree)
}

export function remarkBlockImageCompatibility() {
  return (tree: BlockImageMarkdownNode) => restoreResizedBlockImages(tree)
}
