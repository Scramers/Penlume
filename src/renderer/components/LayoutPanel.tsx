import type { Preferences } from '../../shared/preferences'
import { defaultPreferences } from '../../shared/preferences'
import { useLocalization } from '../localization'
import { Modal } from './Modal'
import { NumberSetting } from './NumberSetting'

export function LayoutPanel({ value, onChange, onResetLayout, onClose }: {
  value: Preferences; onChange: (value: Preferences) => void; onResetLayout: () => void; onClose: () => void
}) {
  const { t } = useLocalization()
  const number = (key: 'fontSize' | 'contentWidth' | 'interfaceZoom', label: string, min: number, max: number, unit: string, description: string, step = 1) =>
    <NumberSetting label={label} value={value[key]} min={min} max={max} step={step} unit={unit} description={description} onChange={(next) => onChange({ ...value, [key]: next })} />
  return <Modal title={t('布局与尺寸')} onClose={onClose} footer={<><button onClick={() => { onResetLayout(); onChange({ ...value, fontSize: defaultPreferences.fontSize, contentWidth: defaultPreferences.contentWidth, interfaceZoom: 100 }) }}>{t('重置布局与尺寸')}</button><button className="button--primary" onClick={onClose}>{t('完成')}</button></>}>
    <div className="preferences layout-settings">
      <p className="settings-note">{t('设置自动保存；数字输入按 Enter 或点击其他位置生效。')}</p>
      <fieldset><legend>{t('正文')}</legend>
        {number('fontSize', t('字号'), 12, 32, 'px', t('只调整正文文字，不改变按钮和设置面板。'))}
        {number('contentWidth', t('正文宽度'), 480, 1400, 'px', t('正文区域的最大宽度，包含左右留白。窗口较窄时自动缩小。'), 20)}
        <div className="layout-presets">{([600, 860, 1120] as const).map((width, index) => <button key={width} aria-label={t(['紧凑', '舒适', '宽屏'][index])} aria-pressed={value.contentWidth === width} onClick={() => onChange({ ...value, contentWidth: width })}>{t(['紧凑', '舒适', '宽屏'][index])}<small aria-hidden="true">{width} px</small></button>)}</div>
      </fieldset>
      <fieldset><legend>{t('界面')}</legend>
        {number('interfaceZoom', t('界面缩放（%）'), 75, 150, '%', t('一起缩放正文、按钮和设置面板。不改变导出内容和系统菜单。'), 10)}
        <label className="setting-check"><input type="checkbox" checked={value.showFormattingToolbar} onChange={(event) => onChange({ ...value, showFormattingToolbar: event.target.checked })} />{t('显示格式工具栏')}</label>
        <p>{t('在正文上方显示加粗、标题、列表等常用按钮。')}</p>
      </fieldset>
      <fieldset><legend>{t('侧栏与预览')}</legend>
        <p>{t('拖动面板之间的分隔线调整大小，双击恢复默认比例。')}</p>
        <p>{t('窗口变窄时，侧栏会覆盖正文，点击正文即可关闭；源码与预览会自动上下排列。')}</p>
        <details className="settings-help"><summary>{t('尺寸快捷键')}</summary><p>{t('正文：Ctrl+Alt+加号 / 减号，Ctrl+Alt+0 恢复。界面：Ctrl+加号 / 减号，Ctrl+0 恢复。')}</p><p>{t('分隔线可用方向键调整，按住 Shift 加大步幅，Enter 恢复。')}</p></details>
      </fieldset>
    </div>
  </Modal>
}
