type MermaidModule = typeof import('mermaid')['default']

const mermaid = (globalThis as typeof globalThis & {
  mermaid: MermaidModule
}).mermaid

const renderCache = new Map<string, Promise<string>>()
let renderQueue: Promise<void> = Promise.resolve()

function currentTheme(): 'default' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default'
}

type MermaidRenderStage = 'loading' | 'rendering'

async function renderMermaidSvg(
  source: string,
  onStage?: (stage: MermaidRenderStage) => void,
): Promise<string> {
  const theme = currentTheme()
  const cacheKey = `${theme}\u0000${source}`
  const cached = renderCache.get(cacheKey)
  if (cached) {
    renderCache.delete(cacheKey)
    renderCache.set(cacheKey, cached)
    onStage?.('rendering')
    return cached
  }

  onStage?.('loading')
  const render = async () => {
    onStage?.('rendering')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 100_000,
      theme,
    })
    const id = `ttypora-mermaid-${crypto.randomUUID().replaceAll('-', '')}`
    return (await mermaid.mermaidAPI.render(id, source)).svg
  }
  const result = renderQueue.then(render, render)
  renderQueue = result.then(() => undefined, () => undefined)

  if (renderCache.size >= 32) {
    const oldestKey = renderCache.keys().next().value
    if (oldestKey !== undefined) renderCache.delete(oldestKey)
  }
  renderCache.set(cacheKey, result)
  void result.catch(() => {
    if (renderCache.get(cacheKey) === result) renderCache.delete(cacheKey)
  })
  return result
}

type ApplyMermaidPreview = (value: null | string | HTMLElement) => void

export function renderMermaidPreview(
  source: string,
  applyPreview: ApplyMermaidPreview,
): void {
  const container = document.createElement('div')
  container.className = 'mermaid-preview'
  container.setAttribute('aria-label', 'Mermaid 图表预览')

  void renderMermaidSvg(source, (stage) => {
    container.dataset.renderStage = stage
  }).then((svg) => {
    container.dataset.renderStage = 'complete'
    const template = document.createElement('template')
    template.innerHTML = svg
    container.append(template.content.cloneNode(true))
    applyPreview(container)
  }).catch((reason) => {
    container.classList.add('mermaid-preview--error')
    container.textContent = `Mermaid 渲染失败：${reason instanceof Error ? reason.message : String(reason)}`
    applyPreview(container)
  })
}

export async function renderMermaidForExport(html: string): Promise<string> {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const blocks = Array.from(parsed.querySelectorAll('pre > code.language-mermaid'))
  await Promise.all(blocks.map(async (code) => {
    const source = code.textContent ?? ''
    const figure = parsed.createElement('figure')
    figure.className = 'mermaid-export'
    try {
      const svg = await renderMermaidSvg(source)
      const fragment = parsed.createRange().createContextualFragment(svg)
      figure.append(fragment)
    } catch (reason) {
      const error = parsed.createElement('pre')
      error.className = 'mermaid-export__error'
      error.textContent = `Mermaid 渲染失败\n${reason instanceof Error ? reason.message : String(reason)}\n\n${source}`
      figure.append(error)
    }
    code.parentElement?.replaceWith(figure)
  }))
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`
}
