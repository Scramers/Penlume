# 0.5.0 媒体、图片上传与双语界面

日期：2026-10-03。此版本继续对齐 Typora 的日常写作能力；完整对齐与视觉、性能超越目标仍以 [功能矩阵](TYPORA_PARITY.md) 为准。

## 音视频写作与导出

通过编辑菜单“插入音视频…”或命令面板插入本地文件，也可以粘贴、拖放包含媒体的文件组。未命名文档先保存；文件复制到 `文档名.assets`，使用相对路径插入当前位置。源码与写作视图共用文档历史，撤销只恢复文本引用，已复制文件和原件保留。异步选择或复制期间文档已经改变时，停止插入并提示，避免覆盖新输入。

保存的是标准 HTML，其他支持相同 HTML 的 Markdown 编辑器可以继续使用：

```html
<audio controls preload="none" src="笔记.assets/tone.wav"></audio>

<video controls preload="none" playsinline poster="cover.png">
  <source src="笔记.assets/clip.webm" type="video/webm">
</video>
```

写作视图提供原生播放控件、封面、源文件说明和可展开的 HTML 源码。媒体开始前不自动播放；远程音视频与远程封面须点击“加载远程媒体”。节点重新渲染、销毁或切换文档时停止旧播放器；仅移动光标不会停止播放。异步解析结果不能写入已经退出的视图。本地资源限制在当前文档目录或已打开的授权工作区，拒绝越界路径；HTML 脚本、事件、嵌入框架、自动播放及原文内联 CSS 不进入预览，原始源码仍保留。

支持文件扩展名 MP3、M4A、OGG、WAV、FLAC、MP4、WebM、OGV 和 MOV。单文件上限 100 MB；具体编码能否播放取决于 Electron/Chromium 的解码能力，文件扩展名不保证全部编码可播放。缺失或不支持的源显示提示，保持原始引用。

| 输出 | 媒体行为 |
|---|---|
| 实时并排预览 | 已授权的本地文件 URL，远程媒体只保留可打开链接 |
| 原生 HTML | 小型本地媒体嵌入 data URL；单项 8 MB、整篇媒体及封面合计 24 MB，重复引用按每次输出计数 |
| PDF / PNG | 静态封面和音视频引用说明，在原文档中播放 |

超过 HTML 嵌入预算、缺失或越界媒体输出可识别的静态占位，并返回导出提示。远程媒体不自动下载，也不通过独立 HTML 自动发起播放请求。Pandoc 转换继续受目标格式能力约束，不等同于原生 HTML 媒体导出。

视频 `poster` 也进入图片引用管理：上传、重写或移除封面引用不改变视频源，不删除本地封面文件。

图片描述（Markdown `alt`）与标题分别保存，数字描述不会被误认作缩放比例。用户拖动图片后保存实际像素宽度为标准 HTML `width`，重新打开、源码/写作切换及 HTML 输出保留这个宽度；原件的固有尺寸改变也不重写已保存的宽度。本地预览地址带授权文件的版本标记，替换同路径原图后重新打开可加载新图片；这个标记不写入 Markdown。旧版生成的百分比宽度继续可读，复杂或非本应用生成的 HTML 保留为原文。

## 图片上传工具

在编辑菜单选择“上传文档图片…”或命令面板选择“上传文档图片”，打开“图片上传”对话框。图片管理面板也可将全部或当前选中图片送到上传工具。

1. 用“选择上传程序…”选择本机可执行文件。
2. 选择 PicGo CLI、PicList CLI 或自定义参数模式。参数使用 JSON 数组，每项一个参数，用 `{file}` 表示待上传图片的临时副本；Node CLI 可选择 `node.exe`，第一项填写 CLI 脚本完整路径。
3. 点击“保存上传器设置”，选择当前文档实际引用的本地图片。
4. 点击“上传所选图片”。程序依次处理冻结的图片副本，显示进度、成功 URL 与失败详情。
5. 审阅成功结果，选择要应用的项目，点击“应用所选 URL（数量）”。对应图片引用替换为远程 URL，本地原件保留；失败项目保持原引用。

打开面板、保存设置或选择程序不会执行上传。网络账号、图床及访问凭据由用户选择的外部程序配置，本应用不内置图床账号。Windows 只支持直接启动 `.exe` / `.com`，不直接启动 `.cmd` / `.bat`。每批最多 100 张、单张 25 MB、合计 256 MB；超时可设 5–300 秒，默认 90 秒，可手动取消。关闭面板后任务继续，重新打开可查看当前任务；完成结果仅在本次应用运行中保留，上传器配置保存在本地。

返回值只接受明确、唯一的 HTTP(S) 图片 URL。混合日志、非零退出、无 URL 或多个候选 URL不会自动改写文档。结果应用前检查当前文档引用及原件版本；上传后原件改变时，须勾选该项明确确认。普通下载链接即使与图片共用引用定义也保留原路径。应用结果进入文档级历史，可撤销、重做和正常保存。

## 中文与 English

通过“偏好设置 → 界面 → 界面语言 → English”切换语言，即时更新工作区、对话框、菜单、命令面板、内置主题说明和编辑器控件，记住本机选择。切换保留主编辑器、正文、选区与文档历史；用户文件名、路径、正文、自定义 CSS 和自定义主题名称按原值显示。

目前提供中文和 English 两种语言。系统原生对话框中由 Windows 提供的控件，以及第三方命令输出的诊断文字，由相应软件自身决定语言。

## 验证与发布

最终构建与类型检查通过，25 个文件中的 194 项单元测试全部通过。Windows 发布程序串行运行全部 11 套桌面验收，全部退出 `code 0`；单文件便携版实际解压、启动并进入编辑器就绪状态。

| 验证 | 结果与记录 |
|---|---|
| 全量构建与单元测试 | [构建日志](../artifacts/build-v0.5.log)、[194 项测试](../artifacts/unit-v0.5.log) |
| 源码桌面流程 | 11 个流程均已通过；图片缓存和加载时序修复后，工作区、内联图片、媒体和编辑器语言/尺寸四套受影响流程重新运行。[汇总](../artifacts/desktop-v0.5-source.json) 保留原失败运行与修复后证据的引用 |
| 最终发布程序 | 核心、Markdown 对齐、工作区、编辑历史、扩展、图片管理、生产工具、媒体、上传、界面语言和编辑器语言/尺寸共 11 套，全部通过：[发布版记录](../artifacts/desktop-v0.5-packaged.json) |
| 图片真实尺寸 | 鼠标拖动后写作视图和 HTML 导出均为 500px；原图替换为 800×320 后重开仍为 500px，文档字节不变：[源码记录](../artifacts/editor-locale-v0.5-source-verification.json)、[发布版记录](../artifacts/editor-locale-verification.json) |
| 便携版 | 包装器解压、Electron 启动、编辑器就绪：[启动日志](../artifacts/portable-v0.5.log) |
| 包内容一致性 | 219 个构建文件与源码产物逐字节哈希一致，内置 Pandoc 与原程序一致，5 个许可证/说明文件齐全：[完整性记录](../artifacts/release-v0.5-verification.json) |

当前产物位于 `release-v0.5.0`：`TTypora Setup 0.5.0.exe`、`TTypora Portable 0.5.0.exe` 和 `win-unpacked/TTypora.exe`。安装包、便携版与目录程序的签名状态均为 `NotSigned`，见 [签名记录](../artifacts/signatures-v0.5.json)；安装升级和文件关联仍未独立验收。

[SHA256SUMS.txt](../release-v0.5.0/SHA256SUMS.txt) 对应最终两个单文件产物：

```text
e62cf48ac552ee7368e0009c1b5baa70eec0cff4745d729b98a7d545157053c3  TTypora Setup 0.5.0.exe
5352ab5ac2d7eabdd4aafdf324b282614ca8937fb2520a9cc32dd85a64f943e1  TTypora Portable 0.5.0.exe
```

验证命令：`npm run build`、`npm test`；新桌面入口为 `node scripts/media-smoke.mjs`、`node scripts/image-uploader-smoke.mjs`、`node scripts/localization-smoke.mjs` 和 `node scripts/editor-locale-smoke.mjs`。`node scripts/desktop-verification.mjs` 串行运行全部 11 套桌面验收，避免 Windows 共用桌面截图抢占焦点；通过 `TTYPORA_PACKAGED_EXE` 指定发布程序可验证相同流程。

测试使用临时文档和本地受控上传器，不调用用户图床，不证明所有第三方上传器版本和服务都兼容。上传验收实际应用受控 HTTP 图片结果并在写作视图加载，普通共享链接与本地原件保留。真实媒体样本验证 WAV 和 WebM，其他编解码组合仍需逐项验证。

## 继续推进的差距

复杂 Markdown 组合、所有表格和键盘边界、智能标点设置、精确同步滚动、拼写语言与词典、批量资源迁移和 `typora-root-url`、文件夹操作及入站链接更新、高级打印和自定义转换模板仍待完善。macOS/Linux/ARM、Windows 正式签名、安装升级和文件关联验收尚未完成；本轮新增能力不能据此宣称已经整体超过 Typora。

参考：[Typora 音视频](https://support.typora.io/Media/)、[图片上传](https://support.typora.io/Upload-Image/)、[PicGo CLI](https://picgo.github.io/PicGo-Core-Doc/guide/commands.html)、[PicList](https://piclist.cn/advanced)。外部工具配置须以所选工具的实际版本为准。
