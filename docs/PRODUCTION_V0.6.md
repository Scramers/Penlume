# 0.6.0 编辑与输出验证记录

状态：Windows x64 0.6.0 已交付；源码验证、全部 14 套发布程序桌面验收和单文件便携版实际启动通过。本批不代表全面对齐或超过 Typora；0.5.0 已验证发布产物继续保留。

## 功能入口

- 在写作视图内选择表格单元格，文档工具栏下出现表格操作区。支持向上/下增行、向左/右增列、整行/列选择与删除、列左/中/右对齐、整表删除。表头之前插入时原表头降为正文；删除表头时下一行提升。支持只有表头的合法 GFM 表格，末格 Tab 新增一行，Shift+Tab 返回上一格。
- 表格快捷输入先校验正整数尺寸：最多 100 行、50 列、2000 个单元格，非法输入保留为原文；一行可创建单表头。矩形选区可直接跨写作/源码视图恢复，源码中的新选择或编辑清除旧矩形信息。
- 普通 `latex`、`math` 代码围栏与美元符号公式分离；代码语言、尾部附加信息及真实公式 metadata 保留。普通代码附加信息可独立编辑；有附加信息但没有语言的代码使用 `text` 围栏，避免丢失附加信息；实体、反引号、反斜杠与 Unicode 保留原语义。公式提供可编辑源码、KaTeX 预览与错误诊断，错误源码不会丢失。原生浮动工具栏与斜杠菜单分别提供行内/块公式入口。
- 清空已有行内公式以一次输入事务删除节点，可撤销恢复；新建空公式维持可编辑草稿，保存时不生成会吞掉后文的空美元标记。块公式附加信息保留实体字面量和边界空白。
- 偏好设置中的“输入辅助”控制智能标点、括号/引号配对及网址建链。智能标点默认关闭，只影响新键入正文；代码、公式、YAML、HTML、网址和组合输入保持原样。普通粘贴与已打开文件不会批量转换。网址建链关闭后停止新输入转换，已有 Markdown 链接与 GFM URL 的解析语义保留。
- “代码块”偏好即时控制换行、行号和新代码块默认语言，缩进宽度与源码视图一致。已有无语言代码保持原样。新默认语言用于主工具栏、斜杠菜单和新键入围栏。
- 实时预览与带样式 HTML/PDF/PNG 共用代码高亮输出，使用本地语法模块，不执行代码；复制代码文本不加入行号。输出使用偏好中的换行、行号、缩进，并在打印时折行。单块超过 200,000 字符、全篇高亮超过 1,000,000 字符或行号超过 10,000 行时跳过相应装饰，完整代码继续输出。

## 验证状态

已完成：真实 Milkdown schema、ParserState/SerializerState、输入规则、CommandManager、CodeMirror 状态与历史测试；最近一次全套单测为 40 个文件中的 411 项通过，完整类型检查与构建通过。源码的 14 套桌面验收全部通过后，最后补行内公式组合输入保护，并在最新冻结构建上重跑受影响的 code-math 流程通过。写作辅助的 7 组真实键盘/剪贴板流程、表格的 22 项桌面用例，以及公式跨行/CRLF/实体/选区/历史/导出均有实际验收记录。

Windows 安装包与便携版已经生成；包内 220 个构建文件与最新冻结构建逐项 SHA-256 一致，内置 Pandoc 与五份许可文件检查通过。发布程序全部 14 套桌面验收通过，便携版包装器解压、Electron 启动、编辑器就绪及正常退出通过。三个应用可执行文件均为 NotSigned，未验收实际安装升级和系统文件关联。输入法桌面测试使用模拟 composition 事件及真实替换按键，不能替代所有 Windows 输入法的人工验收。

证据：`artifacts/desktop-v0.6-source.json` 和 `desktop-v0.6-source-build.json` 记录最后一次行内组合输入修复之前的全套源码构建；`desktop-v0.6-final-source.json` 和 `desktop-v0.6-final-source-build.json` 记录最新冻结构建的受影响复测。单测与构建日志为 `unit-v0.6-development.log`、`build-v0.6-development.log`；发布包一致性为 `release-v0.6-verification.json`，签名检查为 `signatures-v0.6.json`。

| 最终发布验证 | 记录 |
| --- | --- |
| 全量构建与 411 项单元测试 | [构建日志](../artifacts/build-v0.6-development.log)、[测试日志](../artifacts/unit-v0.6-development.log) |
| 14 套实际发布程序桌面验收 | [汇总](../artifacts/desktop-v0.6-packaged.json) |
| 表格 22 项鼠标/键盘/历史/选区用例 | [表格记录](../artifacts/table-tools-v0.6-packaged-verification.json) |
| 代码与公式、组合输入、原文字节、历史和导出 | [实际流程日志](../artifacts/code-math-v0.6-packaged.log)、[导出 PNG](../artifacts/code-math-v0.6-packaged.png)、[PDF 渲染检查](../artifacts/pdf-qa-v0.6-packaged-1.png) |
| 7 组写作辅助真实键盘/剪贴板流程 | [输入辅助日志](../artifacts/writing-aids-v0.6-packaged.log) |
| 便携版正常启动和退出 | [启动日志](../artifacts/portable-v0.6.log) |
| 220 个构建文件、Pandoc 与许可文件一致性 | [完整性记录](../artifacts/release-v0.6-verification.json) |

## Windows 产物

- [安装包](../release-v0.6.0/TTypora%20Setup%200.6.0.exe)
- [单文件便携版](../release-v0.6.0/TTypora%20Portable%200.6.0.exe)
- `release-v0.6.0/win-unpacked/TTypora.exe`：直接运行时保留同目录依赖文件。

[SHA256SUMS.txt](../release-v0.6.0/SHA256SUMS.txt) 对应两个单文件产物：

```text
1580c6d2eca9705a161917e023d7bb7dded416475a96217522bda811f91b1296  TTypora Setup 0.6.0.exe
b012682ff2045389c17b979b342acdba7c6a178bdd094162baeb121cbce81672  TTypora Portable 0.6.0.exe
```

## 保留的差距

百万字符混合文档的独立真实键盘基线已完成，两视图保存与完整内容校验通过；详见 [性能记录](PERFORMANCE_V0.7.md)。基线是后续优化的依据，不能证明大文件已足够流畅或整体性能优于 Typora。

代码和公式修复不证明所有 Markdown 节点、嵌套、粘贴组合与滚动同步完整兼容。表格 HTML/TSV 与矩形选区粘贴、引用式链接形式、完整数学兼容/编号、更多图表、拼写词典、Typora 资源根路径策略与批量迁移、高级 Pandoc 模板/过滤器、完整分页与长图输出、文件夹与入站链接操作、大文件性能、跨平台、安装升级/文件关联和签名仍需实现或独立验证。页面及性能全面优于 Typora 尚未有覆盖整个产品的比较证据。

对照依据：[Typora 代码块](https://support.typora.io/Code-Fences/)、[智能标点](https://support.typora.io/SmartyPants/)、[Markdown 参考](https://support.typora.io/Markdown-Reference/)。实现与品牌、专有资源独立。
