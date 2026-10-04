# 0.8.0 表格剪贴板、单元格换行与发布验收

状态：2026-10-03 已完成本批 Windows x64 发布验收。48 个文件的 854 项单测、完整类型检查与构建、16 套发布程序桌面验收、便携版实际解压/启动/编辑器就绪/正常退出均通过。包内 222 个编译文件、Pandoc 和 5 项许可证资源已核对；安装版、便携版及主程序均未签名。[0.7.0](PRODUCTION_V0.7.md) 及更早产物继续保留。此验收不代表整个 Typora 功能矩阵已完成。

## 发布产物与证据

| 产物 | 字节数 | SHA-256 |
|---|---:|---|
| `release-v0.8.0/TTypora Setup 0.8.0.exe` | 175773210 | `08faed9ab900aff63ef32a09a683cfb7689638cac1e7ad6ded4fdfa4637acf0f` |
| `release-v0.8.0/TTypora Portable 0.8.0.exe` | 175560187 | `9f79c3b83069f749cc6f006ff668bd838ad29d8e365f8ed533ba4bd616f952a3` |

目录程序为 `release-v0.8.0/win-unpacked/TTypora.exe`，直接运行需保留同目录依赖文件。安装、系统文件关联、旧版本升级和其他平台未做本批实际验收。

- [源码构建指纹](../artifacts/source-v0.8-build.json)：渲染入口 `index-BDmkWFIz.js`，SHA-256 `7b43ec52fe141175a4840f9b014e4c93967b263e10acd19844917342b3899bae`。
- [Windows 包内一致性](../artifacts/release-v0.8-verification.json)与[产物校验值](../release-v0.8.0/SHA256SUMS.txt)。
- [16 套发布程序桌面汇总](../artifacts/desktop-v0.8-packaged.json)：一次顺序运行全部通过，累计 1570780ms；源码阶段只重跑受影响的四套与独立换行套件，不称为源码全 16 套。
- [便携版实际启动记录](../artifacts/portable-v0.8.log)与[真实签名检查](../artifacts/signatures-v0.8.json)。

## 实现与实际覆盖

已接入表格单元格复制、剪切、富文本 HTML 与 TSV 粘贴，支持光标处扩容、矩形选区裁剪和重复填充。解析有行、列、格数及字符上限；不支持的结构被拒绝且保持原文。写作与源码的普通粘贴/剪切使用文档统一历史的前后边界，表格事务还隔离 ProseMirror 历史。

表格局部的 Markdown 修正已接入：单元格边缘空白使用字符引用保存，表格文本不经过普通段落的软换行转换。进一步接入表格专用 Shift+Enter、末尾/连续换行序列化、原生 HTML 的受限单元格内容标记，以及剪贴板事件和原生字段 input 结束后的同步历史边界。最新完整构建及 48 个文件的 854 项单测通过，见 [构建日志](../artifacts/build-v0.8-empty-cells.log)及[单测日志](../artifacts/unit-v0.8-empty-cells.log)。

最新构建的真实系统 ClipboardItem 完整套件已通过 16 个场景，见 [完整记录](../artifacts/table-clipboard-v0.8-source-final-editor-verification.json)：无表头富文本 HTML、带边缘空白/制表符/CRLF/空末行及末列的 TSV、原生 HTML 复制回粘、扩容/裁剪/重复填充、Ctrl+Shift+V、剪切、TSV 结构与尺寸拒绝以及段落/表格/代码附加信息/源码的快速独立历史。每组历史均低于 650ms，验证三个独立撤销及重做步骤；原文、保存与源码往返检查通过。首次脚本误用了旧 Electron 剪贴板接口，后已修正；原失败与诊断均保留。

同步事件边界的一轮真实桌面测试通过前 12 项，包括低于 650ms 的段落“输入—粘贴—输入”三次独立撤销/重做；该轮在表格鼠标选区的严格计时场景超时，未通过整套验收。记录保留于 [失败汇总](../artifacts/desktop-v0.8-source-clipboard-synchronous-history.json)。表格计时场景随后改用原生 Shift+方向键收成单格、方向键回到文字，仍保留时间上限与原模型断言，最新冻结构建的完整 16 组已通过。

加入换行兼容后首次表格回归发现空表头被合成为真实换行，见 [失败日志](../artifacts/table-tools-v0.8-source-table-content-regression.log)；已修正单元格 paragraph 序列化并补空表头/正文及换行专用回归。最新构建的既有表格工具 22 个桌面场景全部通过，覆盖结构、矩形选区、持久化/源码、历史、即时语言和窄窗口，见 [完整记录](../artifacts/table-tools-v0.8-source-final-editor-verification.json)。代码公式和输入辅助桌面回归也通过，见 [四套汇总](../artifacts/desktop-v0.8-source-final-editor.json)。原生 HTML 内容模块有 52 项真实处理链单测，硬换行模块有 25 项；独立硬换行 Electron 验收的 9 组全部通过，包括首笔、连续三笔、替换选字、行内代码、原生复制回粘和表格操作，见 [换行记录](../artifacts/table-hardbreak-v0.8-source-hardbreak-verification.json)。

本次代码公式源码验收生成的 PNG 和一页 A4 PDF 已实际打开检查，中文、代码行号与公式未见裁切、重叠或缺字，见 [视觉检查记录](../artifacts/exports-v0.8-source-visual-review.json)。该检查只覆盖记录中的单篇样本，不代表所有主题、分页或表格输出均已验证。

发布程序独立生成的 PNG 与一页 A4 PDF 也已打开检查，见 [发布输出视觉记录](../artifacts/exports-v0.8-packaged-visual-review.json)，覆盖范围仍为同一代码公式样本。

无损 HTML 内容标记支持文本、换行、行内公式、常规五类标记及高亮/上下标/下划线。标记包含原模型，因此 JSON 大小也计入 2Mi 字符及 2000 格预算；不支持的节点（含 Emoji 和图片）或超限标记在矩形复制/剪切时明确拒绝，剪贴板和文档保持原值。这项原生内容序列化拒绝由模块及协议单测验证，尚无对应实际 GUI 场景。普通非矩形复制继续原生路径。

资源根目录的纯定位模块（124 项）及逆向引用模块（125 项）均已冻结，但尚未接入应用；它们只验证路径位置和同一上下文回读，不授予文件读取权限。

## 剩余范围

合并格、多个表格或混合结构暂不支持，矩形无损复制/剪切中的 Emoji 和图片明确拒绝。原生输入法、只读编辑器 UI、Excel/LibreOffice 等外部应用互操作、大表格与接近内容预算的性能、表格换行和空白在所有输出主题中的布局均未实际验证。0.8 没有新增百万字符性能测量；5.4ms 的源码模型观察中位数属于 [0.7 样本](PERFORMANCE_V0.7.md)。资源根目录接入仍在后续工作中。
