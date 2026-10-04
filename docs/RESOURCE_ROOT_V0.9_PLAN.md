# 0.9 `typora-root-url` 原接入计划

本文件保留原开发方案，不代表 0.8 已交付此功能。2026-10-03 已将隔离副本接入 0.9 开发源码，后续修复后的类型检查、构建和 968 项单测通过；桌面及发布验收状态以 [PRODUCTION_V0.9.md](PRODUCTION_V0.9.md) 为准。原方案中的验收清单不代表全部已经执行。

## 冻结的纯路径 API

`src/main/document-resources.ts`：

```ts
createDocumentResourceContext(
  documentPath: string | null,
  markdown: string,
  pathFlavor?: 'win32' | 'posix',
): DocumentResourceContext

resolveDocumentResourceCandidate(
  context: DocumentResourceContext,
  originalReference: string,
): DocumentResourceResolution
```

`src/main/document-resource-references.ts`：

```ts
createDocumentResourceReference(
  context: DocumentResourceContext,
  absoluteTargetPath: string,
  originalReference?: string,
): DocumentResourceReferenceResult
```

Context 只包含文档路径、文档目录、路径平台与 Front Matter root 状态。它不包含授权根，也不证明文件存在、真实路径、符号链接身份或读取权限。辅助模块不执行文件 I/O。生成引用的每个成功结果都重新交给同一个 context 的候选解析器，验证 lexical target 相同；这项验证不能代替调用者的授权和 `realpath` 检查。

有效前置 YAML mapping 中的 string `typora-root-url` 才能提供本地基目录。缺失、畸形、非 string、无效编码等 invalid root 使用文档目录回退；明确 unsupported 的 remote、template、带 query/hash 等 root 拒绝依赖该 root 的相对或单斜线引用，不能悄悄套用文档目录。显式 file URL、drive、UNC 等引用仍按自身路径定位并接受既有授权检查。新生成引用遇到 unsupported root 时可回退为显式 file URL。

[Typora 图片文档](https://support.typora.io/Images/) 明确给出本地 root 与 `/blog/img/test.png` 前缀示例；[YAML 文档](https://support.typora.io/YAML/) 将 root 描述为图片 base path。普通 relative 也使用有效本地 root，是对后一描述的实现解释。已冻结模块不实现 remote root 或 `${filename}` 等 template，不能把这个限制说成 Typora 不支持这些能力。

## 原始快照与主进程边界

Renderer 发送原始 Markdown 快照，而非解析后的 root 或 context：

```ts
interface ResourceDocumentSnapshot {
  documentPath: string | null
  markdown: string
}
```

保存、选择与解析本地资源的请求仍要求已保存且已经授权的文档路径。导出和预览可以携带未命名文档快照，但不能解析其本地资源。`markdown` 采用现有 20 MiB 上限。主进程先验证 schema、文档授权和请求归属，再使用原始路径与同一 Markdown 快照生成一次 context。Context 不接受 renderer 自报，不从磁盘重新读取 Markdown，也不从去除 Front Matter、隐藏 metadata 或规范化后的文本生成。

`src/shared/contracts.ts`、`src/shared/schemas.ts`、`src/preload/index.ts` 与 `src/main/index.ts` 需要统一传递此快照；现有 IPC channel 名称可保留。`ExportDocumentRequest` 增加原始 `markdown`；image/media 的 choose、save、resolve 参数增加快照。资源库、上传器与 Pandoc 请求已包含原始 Markdown，应复用现有字段。

候选解析器可描述异平台路径。服务在任何 native 文件 API 前，必须确认文档与 local candidate 的 `pathFlavor` 都等于当前进程平台；Windows drive/UNC 不能被 POSIX `path.resolve` 当作相对文件，POSIX 路径不能被 Windows 随意补当前盘符。跨平台拒绝属于服务边界，不改变纯辅助模块。

## 首批服务签名

服务接受主进程已生成的 context，不再同时接收一个可能不一致的 `documentPath`：

```ts
saveImageAsset(resources: DocumentResourceContext, request: ImageAssetRequest): Promise<ImageAssetResult>
resolveDocumentImageUrl(resources: DocumentResourceContext, source: string, authorizedRoot?: string): Promise<string>

saveMediaAsset(resources: DocumentResourceContext, request: MediaAssetRequest): Promise<MediaAssetResult>
copyMediaAsset(resources: DocumentResourceContext, selectedPath: string): Promise<MediaAssetResult>
resolveDocumentMediaUrl(resources: DocumentResourceContext, source: string, authorizedRoot?: string): Promise<string>
embedDocumentMediaHtml(html: string, resources: DocumentResourceContext, authorizedRoot?: string, options?: MediaExportOptions): Promise<MediaExportResult>

embedLocalImages(html: string, resources: DocumentResourceContext, authorizedRoot?: string): Promise<string>
prepareDocumentAssets(html: string, resources: DocumentResourceContext, authorizedRoot?: string, mode?: 'embed' | 'preview' | 'print', locale?: InterfaceLanguage): Promise<MediaExportResult>
```

`src/main/image-service.ts` 与 `src/main/media-service.ts` 只替换候选定位与保存后引用生成。`authorizedRoot` 仍只来自已登记工作区或原文档目录；metadata root 永不成为授权根。保留 `realpath`、containment、格式、普通文件、大小限制、图片版本 query、exclusive allocation、媒体 no-follow/bounded-read 和失败清理。

新插入资源仍写入文档旁的 `<文档名>.assets`。Metadata 只改变返回的 Markdown 引用，不能改变保存目录。使用同一个 context 调用逆向辅助模块，并在创建目标文件之前验证生成引用；无法表达时不能留下新资源。媒体需区分真实目标 `target` 与文档别名下的逻辑 `urlPath`，引用使用后者，文件 I/O 使用前者。原始文件保留规则不变。

`src/main/export-service.ts` 的私有 `prepareDocumentImages`、媒体/source 与 poster 共用一次 context。HAST 已完成 HTML entity 解析，候选解析器只 URI decode 一次，不能再做 entity/Markdown unescape。`renderPdf`、`renderPng` 消费已准备好的 HTML，不需要增加 context 参数。保持各模式的静态占位、remote 激活策略和输出预算。

## Renderer 即时刷新与异步一致性

Root 统一维护文档资源快照和 revision，建议内部接口：

```ts
readResourceSnapshot(id: string): Readonly<{
  documentId: string
  documentPath: string | null
  markdown: string
  resourceRevision: number
}> | null

EditorAdapter.refreshResources(): void
MarkdownEditorHandle.refreshResources(): void
```

每个 document ID 的 resolve/upload callback 保持稳定，调用时读取该文档当前快照。不要把 Markdown 每次键入或 root 值加入 editor mount effect 的 callback dependencies；不能每键重建 PM/CM editor。`readMarkdownFor` 可读取真实模型，不能用带 history boundary 和 session mutation 的 `captureCurrent` 代替只读资源查询。

Metadata 更新应使已有图片、HTML media preview 和 split preview 即时刷新。可复用 Crepe 的图片刷新 registry，给 HTML node view 增加显式资源刷新及 generation 检查；不能只依赖节点 source 文本是否变化。刷新不得改 Markdown、dirty、选区、history 或 editor DOM 身份。

异步 resolve 结果必须绑定文档 ID、路径和 resource revision，旧结果不能覆盖更新后的 root 或另一个标签。插入/上传捕获自己的原始快照、bookmark 和 revision；完成时验证仍对应该文档和引用上下文。`insertResources` 已有完整 Markdown 一致性检查，应保留；`handleInsertImage` 和 upload callback 也需要同类归属检查。导出使用点击时冻结快照，HTML 与 context 不能分别来自不同版本。未命名文档应提供保存提示或明确占位，本地路径不能交给浏览器自行解析。

## 后续服务改动

- **Image library — `src/main/image-library.ts`：**保留现有 physical security context，另从原文档路径与原始 Markdown 创建 resource context。`resolveSource` 使用统一候选定位，删除重复 Markdown/URI 解码；rename/copy 的 `rewrite` 对每个原引用调用逆向辅助，保留可表达 style 与原 query/hash，不再次手工拼 suffix。原逻辑路径用于引用，真实路径用于权限与版本校验。工作区扫描中每个磁盘文档和 live buffer 都建立自己的 context；任一 unsupported root 使扫描不完整并禁止 quarantine，包括删除前的第二次 fresh inspection。Invalid root 的确定性回退不应被误判为完整性失败。不要用 Windows 小写 queue/key path 替代原文档路径生成 context。
- **Image uploader — `src/main/image-uploader.ts`：**`documentSources` 从请求原路径/raw Markdown 建 context，再做既有 root containment、no-symlink、文件版本与冻结字节检查。list/upload/apply 已有快照字段，不另读磁盘 Markdown；apply 使用新请求的 context 重新确认原 image ID 对应目标，metadata 改变时拒绝错误应用。Receipt root、owner、队列、确认、预算与本地原文件保留规则不变。
- **Pandoc — `src/main/pandoc-service.ts`：**`exportDocument` 在 normalize/sanitize 前从请求原始 Markdown 建 context，传入 `embedImages`。语义解析器已返回解码后的引用，删除额外的 `replaceAll('&amp;', '&')`；后续使用统一 locator 和原授权链。不要把 metadata root 加到 Pandoc `--resource-path`、sandbox、cwd 或授权范围；保留临时 staging、输出 hash 和原文档保护。

## 必要单测

首批服务需调整 `tests/image-service.test.ts`、`tests/media-service.test.ts`、`tests/export-assets.test.ts`、`tests/export-service.test.ts` 的 context 调用，并保留全部旧授权与预算测试。新增：

- Local root 的 relative/单斜线定位、invalid/non-string root 回退、unsupported root 拒绝相对引用但允许经过授权的显式 file URL。
- Encoded 空格、中文、literal percent、query/hash 与 HTML entity 只解析一次；file/drive/UNC 与异平台候选在 I/O 前拒绝。
- Root 指向文档/工作区外或 junction 外不能读取；未命名文档即使有本地 root 也不能访问本地文件。
- Save/copy 仍落固定 `.assets`，新引用在同一 context roundtrip 正确，root 外 `../` 引用不自动授权；不能重写既有 Markdown 或移动原始文件。
- 图片、audio/video/source、poster 在 preview/embed/print 共用原始快照；磁盘 Markdown 与请求快照不同时，以请求快照定位。维持图片 cache version、媒体大小/总预算、重复引用计费、静态输出和 remote 策略。

Library/uploader/Pandoc 后续单测需覆盖：root 下 rename/copy 的 style/suffix 与逆向定位；多文档 live/disk union；unsupported root 禁止 quarantine；别名/symlink 权限与版本；metadata 改变后 upload receipt 应用拒绝；Pandoc 使用原始 Front Matter、保留 sandbox、不给未授权文件或 entity 二次解码绕过机会。

## 真实 UI 验收与交付门槛

接线后才运行真实 Electron GUI；纯辅助测试或隔离副本不能作为用户可见功能验收。范围至少包括：

1. 已保存文档的写作/源码视图、split preview、HTML/PDF/PNG 与 Pandoc 对同一 root 的图片及媒体/source/poster 定位一致；文档外 root 受原工作区授权边界限制。
2. 实际键盘编辑 Front Matter 后已有资源即时更新，PM/CM 身份、选区、dirty 与 undo/redo 正确；关闭/切换标签或修改 root 后旧 promise 不渲染到新状态。
3. 图片/媒体选择、粘贴、拖入和上传仍落固定 `.assets`，生成引用能保存、重开与导出；未命名文档保存流程、metadata 改变时插入归属正确。
4. Library copy/rename 保留原文件和引用 suffix/style，跨文档扫描与 live buffer 防止误隔离；unsupported root 的 incomplete 状态确实阻止 quarantine。Uploader 使用实际确认与 frozen receipt，取消/失败不改原文档。
5. 特殊字符、URL、query/hash、relative/file/drive/UNC（实际平台可用者）、workspace/junction 拒绝路径，以及现有完整桌面回归继续通过。

冻结辅助模块不改；contracts/IPC/App/renderer 刷新由 root 统一接线，服务与相邻单测可独立分工。完成接线后先 typecheck/全量 unit，再同一构建串行 GUI 和发布包验收。当前计划文件与 staging 副本不宣称这些检查已通过。
