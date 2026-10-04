import DOMPurify from 'dompurify'
import { canonicalMediaMime, isSupportedMediaMime, mediaReferenceLabel, normalizeMediaHtml, remoteMediaUrl } from '../../shared/media'
import { translate, localized, type LocalizedText, type TranslationParams } from '../../shared/localization'
import { readInterfaceLanguage } from '../localization'

export type ResourceResolver = (source: string) => Promise<string> | string

/** Only sanitized, inert HTML is attached. Resource URLs are supplied separately
 * by the document's authorized resolvers and guarded against asynchronous teardown. */
export function renderHtmlMediaPreview(preview: HTMLElement, html: string, resolveImageUrl: ResourceResolver, resolveMediaUrl: ResourceResolver, isCurrent: () => boolean): () => void {
  let disposed = false
  const t = (key: string, params?: TranslationParams) => translate(readInterfaceLanguage(), key, params)
  const updates = new Set<() => void>()
  const refreshLabels = () => updates.forEach((update) => update())
  window.addEventListener('ttypora:interface-language', refreshLabels)
  const alive = (element: Element) => !disposed && isCurrent() && preview.contains(element)
  const template = document.createElement('template')
  template.innerHTML = normalizeMediaHtml(html)
  template.content.querySelectorAll('img').forEach((image) => { image.dataset.ttyporaImageSource = image.getAttribute('src') ?? ''; image.removeAttribute('src'); image.removeAttribute('srcset') })
  template.content.querySelectorAll<HTMLMediaElement>('audio,video,source').forEach((media) => {
    media.dataset.ttyporaMediaSource = media.getAttribute('src') ?? ''; media.removeAttribute('src'); media.removeAttribute('srcset'); media.removeAttribute('autoplay')
    if (media instanceof HTMLVideoElement) { media.dataset.ttyporaPosterSource = media.getAttribute('poster') ?? ''; media.removeAttribute('poster') }
    if (media.tagName !== 'SOURCE') { media.setAttribute('controls', ''); media.setAttribute('preload', 'none') }
  })
  const fragment = DOMPurify.sanitize(template.content, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['audio', 'video', 'source'], ADD_ATTR: ['controls', 'preload', 'playsinline', 'type'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'applet', 'track', 'script', 'link', 'meta', 'base'],
    FORBID_ATTR: ['srcset', 'autoplay', 'srcdoc', 'style'], RETURN_DOM_FRAGMENT: true,
  })
  preview.replaceChildren(fragment)
  preview.querySelectorAll('img').forEach((image) => {
    const source = image.dataset.ttyporaImageSource ?? ''; delete image.dataset.ttyporaImageSource
    if (!source) return
    void Promise.resolve().then(() => resolveImageUrl(source)).then((url) => {
      if (!alive(image)) return
      if (!/^(?:https?:|file:|blob:|data:image\/)/i.test(url)) throw new Error(t('图片路径没有得到授权。'))
      image.src = url
    }).catch((reason: unknown) => { if (alive(image)) { image.dataset.imageError = 'true'; const update = () => { image.title = t('图片无法打开：{reason}', { reason: String(reason) }) }; updates.add(update); update() } })
  })
  const players = [...preview.querySelectorAll<HTMLMediaElement>('audio,video')]
  players.forEach((player) => {
    player.autoplay = false; player.controls = true; player.preload = 'none'
    const refs = [player, ...player.querySelectorAll<HTMLSourceElement>('source')].map((element) => {
      const source = element.dataset.ttyporaMediaSource ?? ''; delete element.dataset.ttyporaMediaSource
      const type = element.getAttribute('type')
      if (type) { if (isSupportedMediaMime(type)) element.setAttribute('type', canonicalMediaMime(type)); else element.removeAttribute('type') }
      return { element, source }
    }).filter((reference) => reference.source)
    const poster = player.dataset.ttyporaPosterSource ?? ''; delete player.dataset.ttyporaPosterSource
    const card = document.createElement('figure'); card.className = 'media-card'
    const caption = document.createElement('figcaption'); caption.className = 'media-card__caption'
    const status = document.createElement('p'); status.className = 'media-card__status'; status.setAttribute('role', 'status')
    let statusText: LocalizedText | null = null
    const update = () => {
      caption.textContent = `${t(player.tagName === 'AUDIO' ? '音频' : '视频')} · ${player.getAttribute('title') || refs.map((ref) => /^data:/i.test(ref.source) ? t('嵌入的媒体数据') : mediaReferenceLabel(ref.source)).join(' · ') || t('未指定源文件')}`
      status.textContent = statusText ? t(statusText.key, statusText.params) : ''
    }
    const setStatus = (key: string, params?: TranslationParams) => { statusText = localized(key, params); update() }
    updates.add(update); update()
    player.replaceWith(card); card.append(caption, player, status)
    player.addEventListener('error', () => { if (alive(player)) setStatus('无法播放此媒体。源文件与 HTML 源码已保留，可检查路径或浏览器支持的编码。') })
    const load = async (references: typeof refs, includeRemotePoster: boolean) => {
      const results = await Promise.allSettled(references.map(async ({ element, source }) => {
        const url = await resolveMediaUrl(source)
        if (!alive(player) || !player.contains(element) && element !== player) return
        if (!/^(?:file:|data:(?:audio|video)\/|https?:)/i.test(url)) throw new Error(t('媒体路径没有得到授权。'))
        element.setAttribute('src', url)
      }))
      if (!alive(player)) return
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') setStatus('媒体无法打开：{reason}', { reason: String(failure.reason) })
      if (poster && (!remoteMediaUrl(poster) || includeRemotePoster) && player instanceof HTMLVideoElement) {
        try {
          const url = await resolveImageUrl(poster)
          if (alive(player) && /^(?:file:|data:image\/|https?:|blob:)/i.test(url)) player.poster = url
        } catch (reason) { if (alive(player)) setStatus('视频封面无法打开：{reason}', { reason: String(reason) }) }
      }
      if (alive(player) && references.length && player.querySelector('source[src]')) player.load()
    }
    const local = refs.filter(({ source }) => !remoteMediaUrl(source)), remote = refs.filter(({ source }) => remoteMediaUrl(source))
    void load(local, false)
    if (remote.length || remoteMediaUrl(poster)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'media-card__load'
      const localizeButton = () => { button.textContent = t('加载远程媒体') }; updates.add(localizeButton); localizeButton()
      setStatus('远程媒体未加载。点击后可使用播放器控件播放。')
      button.addEventListener('click', () => { if (!alive(player)) return; button.disabled = true; setStatus('正在解析远程媒体…'); void load(remote, true).then(() => { if (alive(player)) { button.remove(); if (statusText?.key === '正在解析远程媒体…') setStatus('媒体已加载，可使用播放器控件播放。') } }) })
      card.append(button)
    }
  })
  // Orphan <source> elements have no player and must not resolve resources.
  preview.querySelectorAll('source').forEach((element) => { delete element.dataset.ttyporaMediaSource })
  return () => {
    disposed = true
    window.removeEventListener('ttypora:interface-language', refreshLabels)
    updates.clear()
    players.forEach((player) => { player.pause(); player.removeAttribute('src'); player.removeAttribute('poster'); player.querySelectorAll('source').forEach((source) => source.removeAttribute('src')); player.load() })
  }
}
