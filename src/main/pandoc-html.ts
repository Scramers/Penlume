import type { Element, Root, RootContent } from 'hast'

interface MarkdownNode { type: string; value?: string; url?: string; identifier?: string; alt?: string; children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }
interface SourceEdit { from: number; to: number; value: string }
interface HtmlSpan { from: number; to: number; value: string; parentEnd: number }
interface Tag { name: string; closing: boolean; selfClosing: boolean; end: number }
const strippedTags = ['script', 'style', 'iframe', 'object', 'embed', 'applet', 'template', 'noscript', 'noembed', 'noframes', 'textarea', 'xmp', 'plaintext', 'svg', 'foreignobject', 'base', 'link', 'meta']
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const mathTags = ['math', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mtext', 'mspace', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'semantics', 'annotation', 'menclose', 'mpadded', 'mphantom', 'mmultiscripts', 'mprescripts', 'none', 'mfenced', 'mstyle', 'ms', 'mlabeledtr', 'maligngroup', 'malignmark']
const loadDependencies = () => Promise.all([import('hast-util-from-html'), import('hast-util-sanitize'), import('hast-util-to-html')])
let dependencies: ReturnType<typeof loadDependencies> | undefined
const htmlTools = () => dependencies ??= loadDependencies()

/** Parse a single tag without treating a quoted `>` as the end of the tag. */
function singleTag(raw: string): Tag | null {
  const source = raw.trim()
  const start = source.match(/^<\s*(\/?)\s*([a-z][a-z\d:-]*)(?=[\s/>])/i)
  if (!start) return null
  let quote = ''
  for (let i = start[0].length; i < source.length; i++) {
    const char = source[i]
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") quote = char
    else if (char === '>') return i === source.length - 1 ? { name: start[2].toLowerCase(), closing: Boolean(start[1]), selfClosing: /\/\s*$/.test(source.slice(0, i)), end: i + 1 } : null
  }
  return null
}

function normalizeUrl(value: unknown, image: boolean): string | null {
  if (typeof value !== 'string') return null
  // Browsers ignore C0 controls in schemes; inspect their normalized spelling.
  const url = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  const scheme = url.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase()
  if (!scheme) return value.trim()
  if (image && scheme === 'data') return /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,[\da-z+/=]+$/i.test(url) ? url : null
  if (!(image ? ['http', 'https'] : ['http', 'https', 'mailto', 'tel']).includes(scheme)) return null
  // Canonicalize the protocol for hast-util-sanitize's case-sensitive check.
  return url.replace(/^[^:]+:/, scheme + ':')
}

function cleanUrls(root: Root): void {
  const visit = (node: Root | RootContent) => {
    if (node.type === 'element') {
      for (const key of ['href', 'src', 'cite', 'longDesc']) {
        if (!(key in node.properties)) continue
        const safe = normalizeUrl(node.properties[key], key === 'src')
        if (safe === null) delete node.properties[key]
        else node.properties[key] = safe
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(root)
}

async function sanitizeHtmlTree(html: string, document: boolean): Promise<{ tree: Root; allowedTags: ReadonlySet<string>; serialize: (tree: Root | Element) => string }> {
  const [{ fromHtml }, { sanitize, defaultSchema }, { toHtml }] = await htmlTools()
  const schema = structuredClone(defaultSchema)
  schema.tagNames = [...(schema.tagNames ?? []), 'u', 'mark', 'nav', 'figure', 'figcaption', 'colgroup', 'col', ...mathTags, ...(document ? ['html', 'head', 'body', 'title'] : [])]
  schema.strip = strippedTags
  schema.clobberPrefix = ''
  schema.attributes = {
    '*': ['id', 'className', 'title', 'lang', 'dir', 'ariaLabel', 'ariaLabelledBy', 'ariaDescribedBy'],
    html: ['lang', 'dir'],
    a: ['href', 'name', 'dataFootnoteRef', 'dataFootnoteBackref'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
    ol: ['start', 'reversed', 'type'],
    li: ['value'],
    th: ['colSpan', 'rowSpan', 'scope', 'align'],
    td: ['colSpan', 'rowSpan', 'align'],
    col: ['span', 'width'],
    colgroup: ['span', 'width'],
    blockquote: ['cite'],
    q: ['cite'],
    input: [['disabled', true], ['type', 'checkbox'], 'checked'],
    math: [['display', 'inline', 'block']],
    mfenced: ['open', 'close', 'separators'],
    annotation: [['encoding', 'application/x-tex', 'text/plain']],
  }
  schema.protocols = { href: ['http', 'https', 'mailto', 'tel'], src: ['http', 'https', 'data'], cite: ['http', 'https'], longDesc: ['http', 'https'] }
  const parsed = fromHtml(html, { fragment: !document })
  cleanUrls(parsed)
  const tree = sanitize(parsed, schema) as Root
  return { tree, allowedTags: new Set(schema.tagNames), serialize: (node) => toHtml(node, { characterReferences: { useNamedReferences: true } }) }
}

function findElement(root: Root | Element, tagName: string): Element | null {
  if (root.type === 'element' && root.tagName === tagName) return root
  for (const child of root.children) if (child.type === 'element') { const found = findElement(child, tagName); if (found) return found }
  return null
}

async function sanitizeHtmlSpan(value: string): Promise<string> {
  const tag = singleTag(value)
  if (tag?.closing) {
    const [, { defaultSchema }] = await htmlTools()
    const allowed = [...(defaultSchema.tagNames ?? []), 'u', 'mark', 'nav', 'figure', 'figcaption', 'colgroup', 'col', ...mathTags]
    return allowed.includes(tag.name) && !voidTags.has(tag.name) ? `</${tag.name}>` : ''
  }
  let html = value
  // Fragment parsers need a table context to retain standalone table tags.
  if (tag && ['td', 'th'].includes(tag.name)) html = `<table><tbody><tr>${value}</tr></tbody></table>`
  else if (tag?.name === 'tr') html = `<table><tbody>${value}</tbody></table>`
  else if (tag && ['thead', 'tbody', 'tfoot', 'colgroup', 'col'].includes(tag.name)) html = `<table>${value}</table>`
  const result = await sanitizeHtmlTree(html, false)
  if (!tag) return result.serialize(result.tree)
  const element = findElement(result.tree, tag.name)
  if (!element) return ''
  const serialized = result.serialize({ ...element, children: [] })
  if (voidTags.has(tag.name)) return serialized
  // Keep an opening Markdown token open. Serializing it as an empty pair would
  // move its real text outside <u>, <a>, <sub>, etc. in Pandoc's input.
  return serialized.replace(new RegExp(`</${tag.name}>$`, 'i'), '')
}

async function parseMarkdown(markdown: string, metadata: 'initial' | 'anywhere' | 'none'): Promise<MarkdownNode> {
  const [{ unified }, { default: remarkParse }, { default: remarkMath }, { default: remarkFrontmatter }] = await Promise.all([import('unified'), import('remark-parse'), import('remark-math'), import('remark-frontmatter')])
  const parser = unified().use(remarkParse).use(remarkMath)
  if (metadata !== 'none') parser.use(remarkFrontmatter, [{ type: 'yaml', marker: '-', anywhere: metadata === 'anywhere' }, { type: 'yaml', fence: { open: '---', close: '...' }, anywhere: metadata === 'anywhere' }])
  return parser.parse(markdown) as MarkdownNode
}

function applySourceEdits(source: string, edits: SourceEdit[]): string {
  const sorted = edits.slice().sort((a, b) => b.from - a.from)
  let result = source
  for (const edit of sorted) result = result.slice(0, edit.from) + edit.value + result.slice(edit.to)
  return result
}

async function sanitizeMarkdownHtml(markdown: string, metadata: 'initial' | 'anywhere' | 'none'): Promise<string> {
  const tree = await parseMarkdown(markdown, metadata)
  const spans: HtmlSpan[] = []
  const visit = (node: MarkdownNode, parent: MarkdownNode) => {
    // Only actual HTML tokens are replaced. Code, math and YAML stay byte-for-byte.
    if (['code', 'inlineCode', 'math', 'inlineMath', 'yaml', 'toml'].includes(node.type)) return
    const from = node.position?.start.offset, to = node.position?.end.offset
    if (node.type === 'html' && node.value && typeof from === 'number' && typeof to === 'number') spans.push({ from, to, value: node.value, parentEnd: parent.position?.end.offset ?? to })
    node.children?.forEach((child) => visit(child, node))
  }
  visit(tree, tree)
  spans.sort((a, b) => a.from - b.from)
  const edits: Array<{ from: number; to: number; value: string }> = []
  let coveredUntil = -1
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    if (span.from < coveredUntil) continue
    const tag = singleTag(span.value)
    if (tag && !tag.closing && !voidTags.has(tag.name) && strippedTags.includes(tag.name)) {
      let closing: HtmlSpan | undefined
      for (let j = i + 1; j < spans.length && spans[j].from < span.parentEnd; j++) { const token = singleTag(spans[j].value); if (token?.closing && token.name === tag.name) { closing = spans[j]; break } }
      const to = closing?.to ?? span.parentEnd
      edits.push({ from: span.from, to, value: '' }); coveredUntil = to
    } else edits.push({ from: span.from, to: span.to, value: await sanitizeHtmlSpan(span.value) })
  }
  return applySourceEdits(markdown, edits)
}

export async function sanitizePandocMarkdownHtml(markdown: string): Promise<string> { return sanitizeMarkdownHtml(markdown, 'initial') }

function referenceKey(value: string): string { return value.trim().replace(/\s+/g, ' ').toLowerCase() }
const protectedMarkdownTypes = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'yaml', 'toml'])

async function sanitizeMarkdownLinks(markdown: string, metadata: 'anywhere' | 'none'): Promise<string> {
  const tree = await parseMarkdown(markdown, metadata)
  const definitions: MarkdownNode[] = [], linkedReferences = new Set<string>()
  const collect = (node: MarkdownNode) => {
    if (protectedMarkdownTypes.has(node.type)) return
    if (node.type === 'definition' && node.url && node.identifier) definitions.push(node)
    if (node.type === 'linkReference' && node.identifier) linkedReferences.add(referenceKey(node.identifier))
    node.children?.forEach(collect)
  }
  collect(tree)
  const dangerousReferences = new Set<string>()
  const unsafeDefinitions = new Set<MarkdownNode>()
  for (const definition of definitions) {
    const key = referenceKey(definition.identifier!)
    // A raster data URL may be an image-only definition. It must not become an
    // ordinary hyperlink when that same reference is used as a link elsewhere.
    if (normalizeUrl(definition.url, false) === null && (linkedReferences.has(key) || normalizeUrl(definition.url, true) === null)) { dangerousReferences.add(key); unsafeDefinitions.add(definition) }
  }
  const edits: SourceEdit[] = []
  const visit = async (node: MarkdownNode): Promise<void> => {
    if (protectedMarkdownTypes.has(node.type)) return
    const from = node.position?.start.offset, to = node.position?.end.offset
    if (typeof from === 'number' && typeof to === 'number') {
      if (unsafeDefinitions.has(node)) { edits.push({ from, to, value: '' }); return }
      const unsafeLink = node.type === 'link' && normalizeUrl(node.url, false) === null
      const unsafeImage = node.type === 'image' && normalizeUrl(node.url, true) === null
      const unsafeReference = (node.type === 'linkReference' || node.type === 'imageReference') && node.identifier && dangerousReferences.has(referenceKey(node.identifier))
      if (unsafeLink || unsafeImage || unsafeReference) {
        const first = node.children?.[0]?.position?.start.offset, last = node.children?.at(-1)?.position?.end.offset
        let label = typeof first === 'number' && typeof last === 'number' ? markdown.slice(first, last) : (node.alt ?? '')
        if (node.type === 'image' || node.type === 'imageReference') label = label.replace(/[\\<>\[\]*_`]/g, '\\$&')
        // Nested images inside an unsafe link's label need their own URL check.
        else if (label) label = await sanitizeMarkdownLinks(label, 'none')
        edits.push({ from, to, value: label }); return
      }
    }
    for (const child of node.children ?? []) await visit(child)
  }
  await visit(tree)
  return applySourceEdits(markdown, edits)
}

const rawMetadataVariables = new Set(['header-includes', 'include-in-header', 'include-before', 'include-after', 'include-before-body', 'include-after-body'])

async function sanitizeYamlMetadata(value: string, onWarning: (message: string) => void): Promise<string> {
  const { parseDocument, visitAsync, Scalar, isPair, isScalar, isAlias, isCollection } = await import('yaml')
  const document = parseDocument(value, { keepSourceTokens: true, strict: true })
  if (document.errors.length) throw new Error('文档中的 YAML 元数据格式有误，已停止转换；原文档未修改。')
  let changed = false
  const engineCommands = /\\[a-z@]+/i
  const hasRawEngine = (node: unknown, seen = new Set<unknown>()): boolean => {
    if (!node || seen.has(node)) return false
    seen.add(node)
    if (isScalar(node)) return typeof node.value === 'string' && engineCommands.test(node.value)
    if (isAlias(node)) return hasRawEngine(node.resolve(document), seen)
    if (isCollection(node)) return node.items.some((item) => hasRawEngine(isPair(item) ? item.value : item, seen))
    return false
  }
  await visitAsync(document, { Alias: (_key, alias, path) => {
    const rawField = path.flatMap((item) => isPair(item) && isScalar(item.key) && typeof item.key.value === 'string' ? [item.key.value] : []).find((field) => rawMetadataVariables.has(field.toLowerCase().replaceAll('_', '-')))
    if (rawField && hasRawEngine(alias.resolve(document))) {
      changed = true
      onWarning(`元数据字段 ${rawField} 引用的原始引擎指令已清空；其他字段与正文均保留。`)
      return new Scalar('')
    }
  }, Scalar: async (key, scalar, path) => {
    if (key === 'key' || typeof scalar.value !== 'string') return
    const fields = path.flatMap((item) => isPair(item) && isScalar(item.key) && typeof item.key.value === 'string' ? [item.key.value] : [])
    const rawField = fields.find((field) => rawMetadataVariables.has(field.toLowerCase().replaceAll('_', '-')))
    if (rawField && engineCommands.test(scalar.value)) {
      // These template variables are inserted outside the body. Raw TeX/RTF
      // commands here could escape the ordinary Markdown rendering boundary.
      // Retain the scalar and its anchor so aliases remain valid, but clear it.
      scalar.value = ''; scalar.type = Scalar.QUOTE_DOUBLE; changed = true
      onWarning(`元数据字段 ${rawField} 中的原始引擎指令已清空；其他标题、作者与正文均保留。`)
      return
    }
    const links = await sanitizeMarkdownLinks(scalar.value, 'none')
    const safe = await sanitizeMarkdownHtml(links, 'none')
    if (safe !== scalar.value) { scalar.value = safe; scalar.type = Scalar.QUOTE_DOUBLE; changed = true; onWarning(`元数据字段 ${fields[0] ?? '值'} 已按安全规则整理，显示文字与安全格式保留。`) }
  } })
  // Preserve original comments, quotes and layout exactly when all metadata is safe.
  return changed ? document.toString({ lineWidth: 0 }).replace(/\n$/, '') : value
}

/** Clean every Pandoc input boundary while leaving code and math body text intact. */
export async function sanitizePandocInput(markdown: string, onWarning?: (message: string) => void): Promise<string> {
  const warnings = new Set<string>()
  const warn = (message: string) => { if (!warnings.has(message)) { warnings.add(message); onWarning?.(message) } }
  const tree = await parseMarkdown(markdown, 'anywhere')
  const metadataEdits: SourceEdit[] = []
  const visit = async (node: MarkdownNode): Promise<void> => {
    if (node.type === 'yaml' && typeof node.value === 'string') {
      const from = node.position?.start.offset, to = node.position?.end.offset
      if (typeof from === 'number' && typeof to === 'number') {
        const safe = await sanitizeYamlMetadata(node.value, warn)
        if (safe !== node.value) {
          const raw = markdown.slice(from, to), opening = raw.match(/^---[^\S\r\n]*(?:\r?\n)/)?.[0], closing = raw.match(/(?:\r?\n)(?:---|\.\.\.)[^\S\r\n]*$/)?.[0]
          if (!opening || !closing) throw new Error('无法安全定位 YAML 元数据边界，已停止转换。')
          metadataEdits.push({ from, to, value: opening + safe + closing })
        }
      }
      return
    }
    if (protectedMarkdownTypes.has(node.type)) return
    for (const child of node.children ?? []) await visit(child)
  }
  await visit(tree)
  const metadataSafe = applySourceEdits(markdown, metadataEdits)
  const linksSafe = await sanitizeMarkdownLinks(metadataSafe, 'anywhere')
  if (linksSafe !== metadataSafe) warn('危险的 Markdown 链接或图片地址已移除，显示文字已保留。')
  const htmlSafe = await sanitizeMarkdownHtml(linksSafe, 'anywhere')
  if (htmlSafe !== linksSafe) warn('原始 HTML 已按安全规则整理，脚本、事件属性与危险协议不会进入导出。')
  return htmlSafe
}

/** Produce a standalone, inert HTML document from Pandoc's output. */
export async function sanitizePandocHtmlOutput(html: string): Promise<string> {
  const result = await sanitizeHtmlTree(html, true)
  const document = findElement(result.tree, 'html')!
  const head = findElement(document, 'head')!
  const safeMeta: Element[] = [
    { type: 'element', tagName: 'meta', properties: { charSet: 'utf-8' }, children: [] },
    { type: 'element', tagName: 'meta', properties: { name: 'viewport', content: 'width=device-width, initial-scale=1' }, children: [] },
    { type: 'element', tagName: 'meta', properties: { httpEquiv: ['Content-Security-Policy'], content: "default-src 'none'; img-src data: https: http:; style-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'" }, children: [] },
  ]
  head.children.unshift(...safeMeta)
  return '<!doctype html>\n' + result.serialize(result.tree)
}
