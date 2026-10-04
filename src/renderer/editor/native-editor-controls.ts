import type { Ctx } from '@milkdown/kit/ctx'
import type { ToolbarFeatureConfig } from '@milkdown/crepe/feature/toolbar'
import type { BlockEditFeatureConfig } from '@milkdown/crepe/feature/block-edit'
import { tableBlockConfig, type RenderType } from '@milkdown/kit/component/table-block'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import { addBlockTypeCommand, clearTextInCurrentBlockCommand, codeBlockSchema, setBlockTypeCommand } from '@milkdown/kit/preset/commonmark'
import { NodeSelection } from '@milkdown/kit/prose/state'
import { shallowReactive } from 'vue'
import type { Preferences } from '../../shared/preferences'
import { displayMathNode, inlineMathNode } from './code-math-compatibility'

const formulaIcon = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 4H6l7 8-7 8h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
const tableLabels: Record<RenderType, string> = { add_row: '插入行', add_col: '插入列', delete_row: '删除所选行', delete_col: '删除所选列', align_col_left: '列左对齐', align_col_center: '列居中对齐', align_col_right: '列右对齐', col_drag_handle: '列操作', row_drag_handle: '行操作' }
function escape(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }

/** Localize through public component configuration while preserving native editor views. */
export function createNativeEditorControls(t: (key: string) => string, preferences: () => Preferences) {
  const toolbar: ToolbarFeatureConfig = shallowReactive({
    buildToolbar: (builder) => builder.getGroup('function').addItem('ttypora-inline-math', {
      icon: formulaIcon, label: t('行内公式'),
      active: (ctx) => { const selection = ctx.get(editorViewCtx).state.selection; return selection instanceof NodeSelection && selection.node.type === inlineMathNode.type(ctx) },
      onRun: (ctx) => ctx.get(commandsCtx).call('ToggleLatex'),
    }),
  })
  const blockEdit: BlockEditFeatureConfig = shallowReactive({
    buildMenu: (builder) => {
      const group = builder.getGroup('advanced')
      const code = group.group.items.find((item) => item.key === 'code')
      if (code) code.onRun = (ctx) => {
        const commands = ctx.get(commandsCtx)
        commands.call(clearTextInCurrentBlockCommand.key)
        commands.call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx), attrs: { language: preferences().defaultCodeLanguage } })
      }
      group.addItem('ttypora-math', { icon: formulaIcon, label: t('公式'), onRun: (ctx) => {
        const commands = ctx.get(commandsCtx)
        commands.call(clearTextInCurrentBlockCommand.key)
        commands.call(addBlockTypeCommand.key, { nodeType: displayMathNode.type(ctx) })
      } })
    },
  })
  let tableIcon: ((type: RenderType) => string) | null = null
  const renderTable = (type: RenderType) => `${tableIcon?.(type) ?? ''}<span class="editor-control-name">${escape(t(tableLabels[type]))}</span>`
  const refresh = (ctx?: Ctx) => {
    Object.assign(toolbar, { boldLabel: t('粗体'), italicLabel: t('斜体'), strikethroughLabel: t('删除线'), codeLabel: t('行内代码'), linkLabel: t('链接') })
    Object.assign(blockEdit, {
      textGroup: { label: t('正文'), text: { label: t('正文') }, h1: { label: t('一级标题') }, h2: { label: t('二级标题') }, h3: { label: t('三级标题') }, h4: { label: t('四级标题') }, h5: { label: t('五级标题') }, h6: { label: t('六级标题') }, quote: { label: t('引用') }, divider: { label: t('分隔线') } },
      listGroup: { label: t('列表'), bulletList: { label: t('无序列表') }, orderedList: { label: t('有序列表') }, taskList: { label: t('任务列表') } },
      advancedGroup: { label: t('高级'), image: { label: t('图片') }, codeBlock: { label: t('代码块') }, table: { label: t('表格') } },
    })
    // Replace the function identity so mounted Vue table controls recompute their labels.
    if (ctx && tableIcon) ctx.update(tableBlockConfig.key, (config) => { config.renderButton = (type) => renderTable(type); return config })
  }
  refresh()
  return { toolbar, blockEdit, refresh, configure: (ctx: Ctx) => {
    ctx.update(tableBlockConfig.key, (config) => { tableIcon = config.renderButton; return shallowReactive({ ...config, renderButton: renderTable }) })
  } }
}
