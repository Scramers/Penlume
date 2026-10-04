import { useLocalization } from '../localization'
import { interfaceLanguages, type InterfaceLanguage } from '../../shared/localization'
import type { Preferences } from '../../shared/preferences'
import { defaultPreferences } from '../../shared/preferences'
import { Modal } from './Modal'
import { NumberSetting } from './NumberSetting'

interface Props { value: Preferences; onChange: (value: Preferences) => void; onClose: () => void }

export function PreferencesPanel({ value, onChange, onClose }: Props) {
  const { t, locale, setLocale } = useLocalization()
  const set = <K extends keyof Preferences>(key: K, next: Preferences[K]) => onChange({ ...value, [key]: next })
  const number = (key: 'fontSize' | 'lineHeight' | 'contentWidth' | 'tabSize' | 'autoSaveSeconds' | 'interfaceZoom', label: string, min: number, max: number, unit: string, description: string, step = 1) => (
    <NumberSetting label={label} value={value[key]} min={min} max={max} step={step} unit={unit} description={description} integer={key === 'tabSize' || key === 'autoSaveSeconds'} onChange={(next) => set(key, next)} />
  )
  const check = (key: 'sourceWrap' | 'sourceLineNumbers' | 'smartPunctuation' | 'autoPair' | 'autoLink' | 'codeWrap' | 'codeLineNumbers' | 'spellcheck' | 'autoSave' | 'restoreSession' | 'exportToc' | 'exportMetadata', label: string) => (
    <label className="setting-check"><input type="checkbox" checked={value[key]} onChange={(event) => set(key, event.target.checked)} />{label}</label>
  )
  return <Modal title={t("偏好设置")} onClose={onClose} footer={<><button onClick={() => onChange(defaultPreferences)}>{t("恢复默认设置")}</button><button className="button--primary" onClick={onClose}>{t("完成")}</button></>}>
    <div className="preferences">
      <p className="settings-note">{t('设置自动保存；数字输入按 Enter 或点击其他位置生效。')}</p>
      <fieldset><legend>{t('界面')}</legend><label>{t('界面语言')}<select aria-label={t('界面语言')} value={locale} onChange={(event) => setLocale(event.target.value as InterfaceLanguage)}>{interfaceLanguages.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}</select></label><p>{t('实时切换界面语言，不修改文档内容和文件名。')}</p>
        {number('interfaceZoom', t('界面缩放（%）'), 75, 150, '%', t('一起缩放正文、按钮和设置面板。不改变导出内容和系统菜单。'), 10)}
        <label className="setting-check"><input type="checkbox" checked={value.showFormattingToolbar} onChange={(event) => set('showFormattingToolbar', event.target.checked)} />{t('显示格式工具栏')}</label>
        <p>{t('在正文上方显示加粗、标题、列表等常用按钮。')}</p>
      </fieldset>
      <fieldset><legend>{t('正文排版')}</legend>
        {number('fontSize', t('字号'), 12, 32, 'px', t('只调整正文文字，不改变按钮和设置面板。'))}
        {number('lineHeight', t('行高'), 1.2, 2.5, t('倍'), t('相邻两行的间距。1.8 表示字号的 1.8 倍。'), 0.1)}
        {number('contentWidth', t('正文宽度'), 480, 1400, 'px', t('正文区域的最大宽度，包含左右留白。窗口较窄时自动缩小。'), 20)}
        <label>{t('字体')}<select value={value.fontFamily} onChange={(event) => set('fontFamily', event.target.value as Preferences['fontFamily'])}><option value="serif">{t('阅读字体（宋体风格）')}</option><option value="sans-serif">{t('简洁字体（黑体风格）')}</option><option value="monospace">{t('等宽字体（适合代码）')}</option></select></label>
        {check('spellcheck', t('拼写检查'))}
      </fieldset>
      <fieldset><legend>{t('源码编辑')}</legend>
        <p>{t('源码显示 Markdown 标记，适合直接修改格式。')}</p>
        {check('sourceWrap', t('源码自动换行'))}{check('sourceLineNumbers', t('源码行号'))}
        {number('tabSize', t('缩进宽度'), 2, 8, t('空格'), t('按 Tab 键时的缩进大小，也用于代码块。'))}
      </fieldset>
      <fieldset><legend>{t('输入辅助')}</legend>
        {check('smartPunctuation', t('智能引号、破折号与省略号'))}{check('autoPair', t('自动配对括号与引号'))}{check('autoLink', t('输入和粘贴网址时创建链接'))}
        <p>{t('智能标点只作用于新输入的正文，不会批量改写已有内容。代码、公式和文档信息保持原样。')}</p>
      </fieldset>
      <fieldset><legend>{t('代码块')}</legend>
        {check('codeWrap', t('代码自动换行'))}{check('codeLineNumbers', t('代码行号'))}
        <label>{t('新代码块默认语言')}<input aria-label={t('新代码块默认语言')} maxLength={40} value={value.defaultCodeLanguage} placeholder="javascript" onChange={(event) => { const next = event.target.value; if (/^[\w+#.-]*$/.test(next)) set('defaultCodeLanguage', next) }} /></label>
        <p>{t('留空表示纯文本。仅应用于新插入的代码块；已有代码语言保持不变，缩进宽度与源码编辑器一致。')}</p>
      </fieldset>
      <fieldset><legend>{t('Markdown 扩展')}</legend><p>{t('按需开启额外格式；关闭后仍保留文档中的原始文字。')}</p>
        {(['highlight', 'superscript', 'subscript', 'underline', 'emoji', 'emojiCompletion'] as const).map((key, index) => <label className="setting-check" key={key}><input type="checkbox" checked={value.markdownExtensions[key]} onChange={(event) => set('markdownExtensions', { ...value.markdownExtensions, [key]: event.target.checked })} />{[t("高亮"), t("上标"), t("下标"), t("下划线"), t("Emoji 短名称（如 :smile:）"), t("Emoji 自动补全")][index]}</label>)}
        <details className="settings-help"><summary>{t('查看格式写法')}</summary><p>{t('高亮使用 ==文字==；上标使用 ^文字^；下标使用 ~文字~；下划线使用 <u>文字</u>。上标、下标中的空格以反斜杠转义。')}</p></details>
      </fieldset>
      <fieldset><legend>{t('文件')}</legend>{check('autoSave', t('自动保存已命名文档'))}{number('autoSaveSeconds', t('自动保存间隔（秒）'), 5, 300, t('秒'), t('只自动保存已有文件名的文档。未保存的内容会保留恢复副本。'))}{check('restoreSession', t('启动时恢复上次文档和文件夹'))}<p>{t('文件被其他程序修改时，自动保存会暂停，并提醒你处理。')}</p></fieldset>
      <fieldset><legend>{t('导出')}</legend>{check('exportToc', t('导出时添加目录'))}{check('exportMetadata', t('使用文档信息中的标题和作者'))}<p>{t('文档信息写在文件开头的两条 --- 之间，也称 Front Matter。')}</p>
        <label>{t("PDF 纸张")}<select value={value.pdf.pageSize} onChange={(event) => set('pdf', { ...value.pdf, pageSize: event.target.value as Preferences['pdf']['pageSize'] })}>{['A4', 'A3', 'A5', 'Letter', 'Legal'].map((size) => <option key={size}>{size}</option>)}</select></label>
        <NumberSetting label={t('页边距（毫米）')} value={value.pdf.marginMm} min={0} max={50} unit="mm" description={t('PDF 内容与纸张边缘之间的留白。')} onChange={(next) => set('pdf', { ...value.pdf, marginMm: next })} />
        <label className="setting-check"><input type="checkbox" checked={value.pdf.landscape} onChange={(event) => set('pdf', { ...value.pdf, landscape: event.target.checked })} />{t("横向")}</label>
        <label className="setting-check"><input type="checkbox" checked={value.pdf.pageNumbers} onChange={(event) => set('pdf', { ...value.pdf, pageNumbers: event.target.checked })} />{t("页码")}</label>
        <label>{t("页眉")}<input maxLength={200} value={value.pdf.header} onChange={(event) => set('pdf', { ...value.pdf, header: event.target.value })} /></label>
        <label>{t("页脚")}<input maxLength={200} value={value.pdf.footer} onChange={(event) => set('pdf', { ...value.pdf, footer: event.target.value })} /></label>
      </fieldset>
      <fieldset><legend>{t('自定义主题 CSS')}</legend><p>{t('高级选项：用 CSS 修改正文样式，并用于带样式的导出。不熟悉 CSS 时可以留空。')}</p>
        <input aria-label={t("导入 CSS 主题")} type="file" accept=".css" onChange={(event) => { const file = event.target.files?.[0]; if (file && file.size <= 100000) void file.text().then((css) => set('customCss', css)) }} />
        <textarea aria-label={t("自定义 CSS")} rows={8} value={value.customCss} maxLength={100000} placeholder=".milkdown { font-family: sans-serif; }" onChange={(event) => set('customCss', event.target.value)} />
      </fieldset>
    </div>
  </Modal>
}
