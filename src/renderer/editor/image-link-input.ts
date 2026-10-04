import DOMPurify from 'dompurify'

export interface ImageLinkInputOptions {
  document: Document
  inline: boolean
  source: string
  resolveUrl: (source: string) => Promise<string> | string
  uploadFile: (file: File) => Promise<string>
  confirm: (source: string) => void
  onDraftChange: () => void
  currentSource: () => string
  resourceGeneration: () => number
  isCurrent: () => boolean
  isReadonly: () => boolean
  t: (key: string) => string
}

export interface ImageLinkInput {
  dom: HTMLElement
  input: HTMLInputElement
  updateSource: (source: string) => void
  refreshLocale: () => void
  refreshResources: () => void
  setVisible: (visible: boolean) => void
  setSelected: (selected: boolean) => void
  stopEvent: (event: Event) => boolean
  destroy: () => void
}

let nextFileInput = 0

/** The editable string is never assigned to img.src. Only a resolver result is. */
export function createImageLinkInput(options: ImageLinkInputOptions): ImageLinkInput {
  const document = options.document, window = document.defaultView
  const dom = document.createElement(options.inline ? 'span' : 'div')
  const nativeClass = options.inline ? 'milkdown-image-inline' : 'milkdown-image-block'
  dom.className = `${nativeClass} ttypora-image-link-input${options.inline ? ' empty' : ''}`
  dom.contentEditable = 'false'
  const editor = document.createElement('div')
  editor.className = `image-edit${options.inline ? ' empty-image-inline' : ''}`
  const icon = document.createElement('span')
  icon.className = 'image-icon'; icon.textContent = '▧'; icon.setAttribute('aria-hidden', 'true')
  const importer = document.createElement('div')
  importer.className = 'link-importer'
  const input = document.createElement('input')
  input.type = 'text'; input.className = 'link-input-area'; input.value = options.source
  const placeholder = document.createElement('div')
  placeholder.className = 'placeholder'
  const file = document.createElement('input')
  file.type = 'file'; file.accept = 'image/*'; file.className = 'hidden'; file.id = `ttypora-image-file-${++nextFileInput}`
  const uploader = document.createElement('label')
  uploader.className = 'uploader'; uploader.htmlFor = file.id
  const hint = document.createElement('span')
  hint.className = 'text'
  placeholder.append(file, uploader, hint); importer.append(input, placeholder)
  const preview = document.createElement('div')
  preview.className = 'image-preview'
  const image = document.createElement('img')
  image.alt = ''; image.style.maxWidth = '160px'; image.style.maxHeight = '24px'; image.style.objectFit = 'contain'
  preview.append(image); preview.style.display = 'none'
  const confirm = document.createElement('button')
  confirm.type = 'button'; confirm.className = 'confirm'
  if (options.inline) { confirm.style.width = 'auto'; confirm.style.padding = '3px 8px' }
  const status = document.createElement('span')
  status.className = 'image-link-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  editor.append(icon, importer, preview, confirm, status); dom.append(editor)

  let disposed = false, visible = true, source = options.source
  let previewSequence = 0, operationSequence = 0
  let previewTimer: number | undefined
  let statusKey = ''
  const alive = () => !disposed && options.isCurrent()
  const cancelPreview = () => {
    previewSequence++
    if (previewTimer !== undefined) window?.clearTimeout(previewTimer)
    previewTimer = undefined
    image.removeAttribute('src'); preview.style.display = 'none'
  }
  const setStatus = (key: string) => { statusKey = key; status.textContent = key ? options.t(key) : '' }
  const refreshControls = () => {
    const readonly = options.isReadonly()
    input.disabled = readonly; file.disabled = readonly; confirm.disabled = readonly || !input.value
    // The file control remains usable during a pending upload operation.
    // Choosing another file replaces that operation through operationSequence.
    placeholder.style.display = input.value ? 'none' : ''
    confirm.style.display = input.value ? '' : 'none'
    uploader.setAttribute('aria-disabled', String(readonly))
  }
  const approved = (url: string) => /^(?:file:|https?:|blob:|data:image\/)/i.test(url)
  const schedulePreview = () => {
    cancelPreview()
    const raw = input.value, sequence = previewSequence
    refreshControls()
    if (!visible || !raw) { setStatus(''); return }
    setStatus('正在渲染…')
    previewTimer = window?.setTimeout(() => {
      previewTimer = undefined
      if (!alive() || !visible || sequence !== previewSequence || input.value !== raw) return
      const resources = options.resourceGeneration()
      void Promise.resolve().then(() => options.resolveUrl(raw)).then((url) => {
        // Keep this guard next to the only src setter; no later promise consumer
        // is allowed to assign an obsolete result after this check.
        if (!alive() || !visible || sequence !== previewSequence || input.value !== raw || resources !== options.resourceGeneration()) return
        if (!url || !approved(url)) { setStatus('图片路径没有得到授权。'); return }
        image.src = url; preview.style.display = ''; setStatus('')
      }, () => {
        if (alive() && visible && sequence === previewSequence && input.value === raw && resources === options.resourceGeneration()) setStatus('图片路径没有得到授权。')
      })
    }, 150)
  }
  const onInput = () => { operationSequence++; schedulePreview(); options.onDraftChange() }
  const onFocus = () => importer.classList.add('focus')
  const onBlur = () => importer.classList.remove('focus')
  const onHint = () => { if (!options.isReadonly()) input.focus() }
  const onConfirm = () => {
    if (!alive() || options.isReadonly()) return
    operationSequence++
    options.confirm(DOMPurify.sanitize(input.value))
    schedulePreview()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault(); onConfirm()
  }
  const onUploadClick = (event: MouseEvent) => { if (options.isReadonly()) event.preventDefault() }
  const onFileChange = () => {
    const chosen = file.files?.[0]
    if (!chosen || !alive() || options.isReadonly()) return
    file.value = ''
    const sequence = ++operationSequence, originalSource = options.currentSource()
    cancelPreview(); setStatus('正在渲染…')
    const current = () => alive() && sequence === operationSequence && !options.isReadonly() && options.currentSource() === originalSource
    // uploadFile already captures/checks the App snapshot AFTER an unsaved
    // document's legitimate first Save As. Do not reject it using the resource
    // generation from before that save, or a later passive resource refresh.
    // Resource generation guards displayed URLs; App owns the upload snapshot.
    void Promise.resolve().then(() => options.uploadFile(chosen)).then((raw) => {
      if (!raw || !current()) return
      const clean = DOMPurify.sanitize(raw)
      if (input.value !== clean) input.value = clean
      options.confirm(clean)
      schedulePreview()
    }).catch(() => { if (current()) setStatus('图片路径没有得到授权。') })
  }
  const onImageError = () => { if (alive() && visible && image.hasAttribute('src')) setStatus('无法预览此图片') }
  input.addEventListener('input', onInput); input.addEventListener('focus', onFocus); input.addEventListener('blur', onBlur); input.addEventListener('keydown', onKeydown)
  hint.addEventListener('click', onHint); uploader.addEventListener('click', onUploadClick); confirm.addEventListener('click', onConfirm)
  file.addEventListener('change', onFileChange); image.addEventListener('error', onImageError)
  const refreshLocale = () => {
    uploader.textContent = options.t('选择图片'); confirm.textContent = options.t('确认'); hint.textContent = options.t('或粘贴图片链接')
    input.setAttribute('aria-label', options.t('或粘贴图片链接'))
    status.textContent = statusKey ? options.t(statusKey) : ''
    refreshControls()
  }
  refreshLocale()
  if (input.value) schedulePreview()
  return {
    dom, input,
    updateSource: (next) => {
      refreshControls()
      if (next === source) return
      source = next; operationSequence++
      // A confirmation of this input already has the same value. Avoid writing
      // it back: that would invalidate Chromium's native input undo history.
      if (input.value !== next) { input.value = next; schedulePreview() }
    },
    refreshLocale,
    refreshResources: () => { if (alive()) schedulePreview() },
    setVisible: (next) => {
      if (visible === next) return
      visible = next; dom.style.display = next ? '' : 'none'
      dom.classList.toggle(nativeClass, next)
      if (!next) { cancelPreview(); setStatus('') }
      else schedulePreview()
    },
    setSelected: (selected) => dom.classList.toggle('selected', selected),
    stopEvent: (event) => event.target instanceof Node && dom.contains(event.target),
    destroy: () => {
      disposed = true; operationSequence++; cancelPreview()
      input.removeEventListener('input', onInput); input.removeEventListener('focus', onFocus); input.removeEventListener('blur', onBlur); input.removeEventListener('keydown', onKeydown)
      hint.removeEventListener('click', onHint); uploader.removeEventListener('click', onUploadClick); confirm.removeEventListener('click', onConfirm)
      file.removeEventListener('change', onFileChange); image.removeEventListener('error', onImageError)
      dom.remove()
    },
  }
}
