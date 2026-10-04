import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import katexCss from 'katex/dist/katex.min.css?raw'
import { readMetadata, remarkEditorExtensions, remarkExportExtensions, splitFrontMatter } from '../shared/markdown-extensions'
import type { Preferences } from '../shared/preferences'
import { defaultPreferences } from '../shared/preferences'
import { documentTypographyCss } from '../shared/document-typography'
import type { Root as HastRoot, RootContent as HastContent } from 'hast'
import type { Root as MarkdownRoot } from 'mdast'
import { canonicalMediaMime, isSupportedMediaMime, normalizeMediaHtml, remoteMediaUrl } from '../shared/media'
import { exportCodeCss, protectLiteralMathCode, rehypeExportCode } from './code-export'

const fontAssets = import.meta.glob<string>('/node_modules/katex/dist/fonts/*.woff2', { eager: true, query: '?url&inline', import: 'default' })
const standaloneKatexCss = katexCss.replace(/src:[^;]*;/g, (declaration) => {
  const name = declaration.match(/(?:fonts\/)?(KaTeX_[\w-]+\.woff2)/)?.[1]
  const font = name ? fontAssets[`/node_modules/katex/dist/fonts/${name}`] : undefined
  return font ? `src:url(${font}) format('woff2');` : declaration
})

export interface HtmlOptions { unstyled?: boolean; toc?: boolean; metadata?: boolean; customCss?: string; preferences?: Preferences }

function normalizeMediaNodes() {
  return (tree: MarkdownRoot) => {
    const visit = (node: { type?: string; value?: string; children?: unknown[] }) => { if (node.type === 'html' && typeof node.value === 'string') node.value = normalizeMediaHtml(node.value); node.children?.forEach((child) => visit(child as typeof node)) }
    visit(tree)
  }
}

function safeMediaNodes() {
  return (tree: HastRoot) => {
    const visit = (node: HastRoot | HastContent) => {
      if (node.type === 'element' && ['audio', 'video', 'source'].includes(node.tagName)) {
        delete node.properties.autoPlay; delete node.properties.autoplay
        if (node.tagName !== 'source') { node.properties.controls = true; node.properties.preload = 'none' }
        if (typeof node.properties.type === 'string') { if (isSupportedMediaMime(node.properties.type)) node.properties.type = canonicalMediaMime(node.properties.type); else delete node.properties.type }
        if (typeof node.properties.src === 'string') { const remote = remoteMediaUrl(node.properties.src); if (remote) { node.properties.dataMediaRemote = remote; delete node.properties.src } }
        if (typeof node.properties.poster === 'string' && remoteMediaUrl(node.properties.poster)) delete node.properties.poster
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export async function renderDocumentHtml(
  markdown: string,
  title: string,
  options: HtmlOptions = {},
): Promise<string> {
  const metadata = options.metadata ? readMetadata(markdown) : {}
  const exportTitle = typeof metadata.title === 'string' ? metadata.title : title
  const schema: typeof defaultSchema = {
    ...defaultSchema,
    clobberPrefix: '',
    attributes: {
      ...defaultSchema.attributes,
      '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'id'],
      code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-/, 'math-inline', 'math-display']],
      nav: ['className', 'ariaLabel'],
      audio: ['controls', 'preload', 'src', 'title', 'dataMediaRemote'],
      video: ['controls', 'preload', 'playsInline', 'src', 'poster', 'width', 'height', 'title', 'dataMediaRemote'],
      source: ['src', 'type', 'dataMediaRemote'],
    },
    protocols: { ...defaultSchema.protocols, src: ['http', 'https', 'file', 'data'], poster: ['http', 'https', 'file', 'data'] },
    tagNames: [...(defaultSchema.tagNames ?? []), 'nav', 'mark', 'sup', 'sub', 'u', 'audio', 'video', 'source'],
  }
  let source = markdown
  if (options.toc && !/^\[toc\]\s*$/im.test(source)) {
    const { frontMatter, body } = splitFrontMatter(source)
    source = `${frontMatter}\n[TOC]\n\n${body}`
  }
  const body = String(await unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(remarkFrontmatter)
    .use(remarkEditorExtensions, options.preferences?.markdownExtensions).use(remarkExportExtensions).use(normalizeMediaNodes).use(protectLiteralMathCode).use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw).use(rehypeSanitize, schema).use(safeMediaNodes).use(rehypeKatex, { throwOnError: false, trust: false })
    .use(rehypeExportCode, { wrap: options.preferences?.codeWrap ?? defaultPreferences.codeWrap, lineNumbers: options.preferences?.codeLineNumbers ?? defaultPreferences.codeLineNumbers }).use(rehypeStringify).process(source))
  const prefs = options.preferences

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http: file:; media-src data: file: https: http:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(exportTitle)}</title>
${typeof metadata.author === 'string' ? `<meta name="author" content="${escapeHtml(metadata.author)}">` : ''}
<style>
${options.unstyled ? '' : `
:root { color-scheme: light dark; }
body { box-sizing: border-box; max-width: 860px; margin: 0 auto; padding: 48px 56px 96px; color: #242424; background: #fff; font: 17px/1.78 Georgia, 'Noto Serif CJK SC', 'Songti SC', serif; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { font-family: Inter, system-ui, 'Microsoft YaHei', sans-serif; }
h1 { padding-bottom: .28em; border-bottom: 1px solid #ddd; }
a { color: #73543a; }
img { display: block; max-width: 100%; height: auto; margin: 1.2em auto; }
audio, video { display: block; width: 100%; max-height: 480px; margin: 1.2em auto; }
.media-reference-placeholder { margin: 1.2em 0; padding: 1em; border: 1px solid #ccc; border-radius: 8px; break-inside: avoid; overflow-wrap: anywhere; font-family: system-ui, sans-serif; font-size: .9em; }
.media-reference-placeholder img { max-height: 280px; object-fit: contain; }
.media-reference-placeholder a { display: block; margin-top: .5em; }
.image-reference-placeholder { display: inline-block; max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere; padding: .25em .5em; border: 1px solid #ccc; border-radius: 4px; font: .85em/1.5 system-ui, sans-serif; }
.mermaid-export { margin: 1.4em 0; text-align: center; }
.mermaid-export svg { max-width: 100%; height: auto; }
.mermaid-export__error { color: #9b2f2f; text-align: left; }
blockquote { margin-inline: 0; padding: .2em 1em; color: #666; border-left: 4px solid #b99b7b; }
pre { padding: 16px; overflow: auto; background: #f5f4f1; border-radius: 8px; }
code { font: .9em/1.6 'Cascadia Code', Consolas, monospace; }
:not(pre) > code { padding: .15em .35em; background: #f1efeb; border-radius: 4px; }
${exportCodeCss}
table { width: 100%; border-collapse: collapse; }
th, td { padding: 7px 10px; border: 1px solid #d8d5ce; }
th { background: #f5f4f1; }
hr { border: 0; border-top: 1px solid #d8d5ce; }
@media print { body { max-width: none; padding: 0; } a { color: inherit; } }
nav.document-toc { padding: 1em; border: 1px solid #ddd; }
.document-toc p { margin: .3em 0; }
.toc-level-2 { padding-left: 1em; } .toc-level-3 { padding-left: 2em; } .toc-level-4 { padding-left: 3em; }
.markdown-alert { border-left-color: #4484c0; } .markdown-alert-warning, .markdown-alert-caution { border-left-color: #c17536; }
h1,h2,h3,h4,h5,h6 { break-after: avoid; } img, tr, .mermaid-export { break-inside: avoid; }
${documentTypographyCss('body')}
${prefs ? `body { max-width: ${prefs.contentWidth}px; font-size: ${prefs.fontSize}px; line-height: ${prefs.lineHeight}; font-family: ${prefs.fontFamily}; } .code-export { --code-tab-size: ${prefs.tabSize}; }` : ''}
${(options.customCss ?? '').replace(/<\/style/gi, '<\\/style')}
`}
${standaloneKatexCss}
</style>
</head>
<body>
${body}
</body>
</html>`
}
