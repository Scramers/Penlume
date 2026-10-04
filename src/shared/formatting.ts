export const formatLabels = {
  bold: '粗体', italic: '斜体', strike: '删除线', inlineCode: '行内代码',
  highlight: '高亮', superscript: '上标', subscript: '下标', underline: '下划线',
  heading1: '一级标题', heading2: '二级标题', heading3: '三级标题', paragraph: '正文',
  quote: '引用', bullet: '无序列表', ordered: '有序列表', task: '任务列表',
  code: '代码块', table: '表格', link: '链接', toc: '目录', footnote: '脚注',
  frontMatter: 'Front Matter', alert: '提示块', math: '公式',
} as const
export type FormatAction = keyof typeof formatLabels

export function formatMarkdown(action: FormatAction, selection: string): string {
  const text = selection || '文字'
  const lines = (prefix: string) => text.split('\n').map((line) => `${prefix}${line}`).join('\n')
  switch (action) {
    case 'bold': return `**${text}**`
    case 'italic': return `*${text}*`
    case 'strike': return `~~${text}~~`
    case 'highlight': return `==${text}==`
    case 'superscript': return `^${text.replace(/\s/g, (space) => `\\${space}`)}^`
    case 'subscript': return `~${text.replace(/\s/g, (space) => `\\${space}`)}~`
    case 'underline': return `<u>${text}</u>`
    case 'inlineCode': return `${text.includes('`') ? '`` ' : '`'}${text}${text.includes('`') ? ' ``' : '`'}`
    case 'heading1': return `# ${text}`
    case 'heading2': return `## ${text}`
    case 'heading3': return `### ${text}`
    case 'paragraph': return selection.replace(/^#{1,6}\s+/gm, '')
    case 'quote': return lines('> ')
    case 'bullet': return lines('- ')
    case 'ordered': return text.split('\n').map((line, index) => `${index + 1}. ${line}`).join('\n')
    case 'task': return lines('- [ ] ')
    case 'code': return `\n\n\`\`\`\n${selection}\n\`\`\`\n\n`
    case 'table': return '\n\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n\n'
    case 'link': return `[${text}](https://example.com)`
    case 'toc': return '\n\n[TOC]\n\n'
    case 'footnote': { const id = `note-${crypto.randomUUID().slice(0, 8)}`; return `[^${id}]\n\n[^${id}]: ${text}\n\n` }
    case 'frontMatter': return '---\ntitle: 标题\nauthor: 作者\n---\n\n'
    case 'alert': return `\n\n> [!NOTE]\n${lines('> ')}\n\n`
    case 'math': return `\n\n$$\n${selection || 'E = mc^2'}\n$$\n\n`
  }
}
