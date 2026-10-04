# 0.9.0 文档资源根目录接入与发布验收

状态：2026-10-03 已完成本批 Windows x64 发布验收。50 个文件的 968 项单元测试、完整类型检查与构建通过；发布程序全部 18 套桌面验收一次顺序运行通过，便携版实际解压、启动、编辑器就绪和正常退出通过。222 个包内编译文件、Pandoc 和 5 项许可证资源核对通过；三个 Windows 程序均未签名。[0.8.0](PRODUCTION_V0.8.md) 及更早产物继续保留。本批不代表完整 Typora 对齐，确认前的原生图片链接缩略预览仍有下述差距。

## 发布产物与证据

| 产物 | 字节数 | SHA-256 |
|---|---:|---|
| `release-v0.9.0/TTypora Setup 0.9.0.exe` | 175775220 | `9c86e513d94409e7191aee94c3fe11666ebc046ac2909820b71bb1bb01103a4f` |
| `release-v0.9.0/TTypora Portable 0.9.0.exe` | 175562191 | `ea055bf66ec4fd1f6fe49718813b617ed550c6ecc2f4ca583b21927dda3bf90d` |

目录程序为 `release-v0.9.0/win-unpacked/TTypora.exe`，直接运行需保留同目录依赖文件。实际安装、系统文件关联、旧版本升级和其他平台未做本批验收。

- [Windows 包内一致性](../artifacts/release-v0.9-verification.json)与[产物校验值](../release-v0.9.0/SHA256SUMS.txt)。
- [18 套发布程序顺序桌面汇总](../artifacts/desktop-v0.9-packaged.json)：累计 1648371ms，全部一次顺序运行通过。
- [便携版实际启动/退出](../artifacts/portable-v0.9.log)与[真实签名检查](../artifacts/signatures-v0.9.json)。
- [发布程序资源根 12 组交互](../artifacts/resource-root-v0.9-packaged-verification.json)、[图片绑定 3 组交互](../artifacts/image-binding-v0.9-packaged-verification.json)与[实际 PNG/PDF 视觉检查](../artifacts/exports-v0.9-packaged-visual-review.json)。视觉检查仅覆盖记录中的单页样本。

## 实现

有效前置 YAML mapping 中的字符串 `typora-root-url` 用作本地资源基目录。图片、音视频及封面、实时预览、HTML/PDF/PNG、图片库、上传工具与 Pandoc 使用同一定位规则。IPC 只接受文档路径和原始 Markdown 快照，主进程先验证文档权限，再建立上下文；YAML 不新增文件访问授权，也不改变 `.assets` 保存位置。

新资源和图片库复制/重命名的引用由同一上下文逆向生成，再解析验证指向正确目标。引用的编码只解析一次，query/hash 保留。图片库为每份磁盘文档及 live buffer 独立建立上下文；不支持的根或无法确定的本地引用使扫描不完整，禁止把可能仍被引用的文件移入恢复区。上传结果在应用前检查资源上下文和原实际文档位置，允许修改无关正文或标题；非字符串根同属文档目录 fallback，签名按该相同上下文处理。

编辑器的资源解析回调按文档保持稳定，读取当前原始 Markdown；资源根或保存路径变化使旧异步结果失效。资源刷新在现有图片视图重新绑定 URL，并只刷新 HTML 预览，原有编辑器保持挂载。每个图片视图分别检查请求次序、资源版本和生命周期，晚返回的旧图片不能覆盖新选择；当前请求失败清除旧显示。正在输入的图片说明先由原控件自然提交或失焦提交，再显示返回的图片 URL；语言切换也先等待说明提交再重建内部控件，并恢复已展开的空说明框。销毁后的原生控件不能再定位到当前文档。图片库及上传应用回调还核对路径、资源版本和正文，防止另存为期间使用旧路径生成的结果。

## 当前证据

- [最新修复构建及内含类型检查](../artifacts/build-v0.9-image-draft-fix.log)、[968 项单测](../artifacts/unit-v0.9-image-draft-fix.log)。一次命令误用了不存在的 `test:unit` 脚本，原[命令错误日志](../artifacts/unit-v0.9-image-draft-command-error.log)保留；随后使用项目 `npm test` 完整通过。
- [Pandoc 修复应用记录](../artifacts/source-v0.9-pandoc-fix-application.json)：规范化后先授权嵌入图片，再清理完整输入；file/drive 图片保留，越界或缺失图片和普通 file 下载链接仍在真实转换输入中清除。
- [Pandoc 修复后实际转换桌面复测](../artifacts/desktop-v0.9-source-pandoc-fix.json)。
- [资源根 11 组交互](../artifacts/desktop-v0.9-source-resource-root-document-history.json)：修复图片说明 URL 延迟前的构建，文档撤销走实际正文失焦后的共享历史；不将聚焦输入框的原生撤销失败算作通过。
- 图片说明独立诊断保留[修复前值写入及原生撤销失败](../artifacts/resource-root-v0.9-source-caption-held-diagnostic-caption-held-native-undo.json)与[修复后同场景值写入及恢复](../artifacts/resource-root-v0.9-source-caption-held-fixed-caption-held-native-undo.json)。诊断不能代替最终正式专项。
- [原生说明撤销与重做在内的资源根 12 组正式交互](../artifacts/resource-root-v0.9-source-ordered-images-verification.json)，及[同轮资源根、编辑器语言、媒体三套汇总](../artifacts/desktop-v0.9-source-ordered-images.json)。这轮早于最新语言草稿保护修改。
- [最新图片绑定 3 组桌面专项](../artifacts/image-binding-v0.9-source-image-binding-verification.json)：缺失和越界根清除旧图、同一原生上传控件 A/B 真结果乱序、实际偏好设置切换语言后 Second 说明按时提交并保持。First 在偏好设置打开时真实失焦，原生计时器会取消；此结果不证明未取消的旧控件计时器实际触发。记录中的预期失效取消日志及控件临时相对路径加载错误不等于页面异常。
- [最新冻结构建的三套桌面复测](../artifacts/desktop-v0.9-source-image-drafts.json)：资源根 12 组交互、编辑器语言及媒体；未重新运行源码全部 18 套。
- [最新源码 PNG 与 PDF 页面的实际视觉检查](../artifacts/exports-v0.9-source-visual-review.json)：正文、代码行号、公式和中文媒体静态提示可读，未见裁切或重叠；图片和封面样本仅 2×2 像素，不能据此评价正常图片缩放或复杂分页。
- [源码构建指纹](../artifacts/source-v0.9-build.json)及[隔离副本应用记录](../artifacts/source-v0.9-staging-application.json)。
- [9 套受影响源码桌面回归](../artifacts/desktop-v0.9-source-integration.json)：媒体、图片库、上传工具、转换导出、工作区、编辑器语言、功能回归、界面本地化和文档历史；不等同于当前全部 18 套。
- [原接入计划](RESOURCE_ROOT_V0.9_PLAN.md)：保留设计与验收范围。

## 当前边界

图片链接输入框确认前的原生缩略图尚未经过文档资源解析器，按浏览器页面地址解析。发布程序的[真实诊断](../artifacts/image-input-preview-v0.9-packaged-native-preview-diagnostic.json)显示：主动输入新建外部 PNG 的 file URL 可解码，未调用主解析器；输入实际存在于资源根的相对文件名时缩略图失败，按 Enter 确认后主解析器正确定位并显示。确认前 PM 和实际源码均保持原文，测试[处理器恢复及清理](../artifacts/image-input-preview-v0.9-packaged-native-preview-cleanup.json)通过。这是用户主动输入场景，不能据此声称文档自动读取或任意文件内容读取；此入口的统一预览解析列入下一批修复。

无效或非字符串根使用文档目录 fallback；远程根、`${filename}` 模板或根的 query/hash 暂不支持，依赖这种根的引用不会猜测成本地路径。显式 file URL、drive、UNC 等仍须通过原授权检查。服务拒绝其他平台的本地路径；媒体保留现有 `//host` HTTP 处理规则，本地 UNC 使用反斜线或 file URL。不扩展文件权限、不改变 Pandoc sandbox/staging 工作目录，也不向 Pandoc 注入任意 resource-path。

模板兼容、用户可配置资源存储策略、外部应用互操作、全部原生输入法、更多操作系统及正式安装升级仍未完成。单测通过不能代替实际桌面或发布程序验收。
