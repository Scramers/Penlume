import path from 'node:path'
import { isPathInsideRoot } from './workspace-service'

// Rewrite only actual link/image syntax, preserving all unrelated source bytes, code and YAML.
export async function rebaseDocumentLinks(markdown: string, source: string, destination: string, root: string): Promise<string> {
  if (path.dirname(source) === path.dirname(destination)) return markdown
  const [{ unified }, { default: parse }, { default: stringify }, { default: frontmatter }] = await Promise.all([
    import('unified'), import('remark-parse'), import('remark-stringify'), import('remark-frontmatter'),
  ])
  const processor = unified().use(parse).use(frontmatter).use(stringify)
  const tree = processor.parse(markdown)
  type Node = { type: string; url?: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
  const changes: Array<{ from: number; to: number; value: string }> = []
  const rewriteUrl = (url: string): string => {
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(url) || path.isAbsolute(url)) return url
    const split = url.search(/[?#]/)
    const resource = split < 0 ? url : url.slice(0, split)
    const suffix = split < 0 ? '' : url.slice(split)
    const resolved = path.resolve(path.dirname(source), decodeURIComponent(resource))
    if (!isPathInsideRoot(root, resolved)) throw new Error('文档含工作区外部的相对链接，无法自动移动。')
    return path.relative(path.dirname(destination), resolved).split(path.sep).map(encodeURIComponent).join('/') + suffix
  }
  const update = (node: Node): boolean => {
    let changed = false
    if (node.url) { const next = rewriteUrl(node.url); changed = next !== node.url; node.url = next }
    for (const child of node.children ?? []) if (update(child)) changed = true
    return changed
  }
  const walk = (node: Node) => {
    if (node.type === 'html' && /\b(?:src|href)\s*=/.test(node.value ?? '')) throw new Error('文档含 HTML 资源链接，请在原目录重命名，或先将 HTML 链接改为 Markdown 链接。')
    if (['link', 'image', 'definition'].includes(node.type) && node.position) {
      const from = node.position.start.offset, to = node.position.end.offset
      if (typeof from === 'number' && typeof to === 'number' && update(node)) {
        const outputTree = { type: 'root', children: node.type === 'definition' ? [node] : [{ type: 'paragraph', children: [node] }] }
        changes.push({ from, to, value: processor.stringify(outputTree as Parameters<typeof processor.stringify>[0]).trimEnd() })
      }
      return
    }
    node.children?.forEach(walk)
  }
  walk(tree as Node)
  for (const change of changes.sort((a, b) => b.from - a.from)) markdown = markdown.slice(0, change.from) + change.value + markdown.slice(change.to)
  return markdown
}
