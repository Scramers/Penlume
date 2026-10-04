# ADR-001：桌面框架与编辑器内核

> 状态：暂定接受，Phase 0 后复审  
> 日期：2026-09-01  
> 决策范围：M0 与 MVP

## 1. 背景

Penlume 需要同时解决：

- 混合式 WYSIWYG Markdown 编辑。
- 中文 IME 和复杂选区。
- Markdown 解析、编辑和序列化。
- 本地文件、窗口、菜单和跨平台打包。
- 后续源码模式和富文本模式切换。

编辑器内核会直接影响 Markdown 保真、性能和开发成本，因此不能让业务代码依赖某个第三方库的内部 API。

## 2. 暂定决策

M0/MVP 暂定使用：

- Electron：桌面运行时。
- React + TypeScript：渲染层。
- Vite：开发和构建。
- Milkdown/ProseMirror：混合式 WYSIWYG 编辑器。
- remark/unified 或 Milkdown 对应解析链：Markdown 处理。
- CodeMirror 6：Beta 源码模式。
- Vitest：纯逻辑和组件测试。
- Playwright：关键桌面 E2E。
- electron-builder：Windows MVP 打包。

该决定只有在 Phase 0 验证门槛全部通过后才转为“接受”。若失败，优先重新评估 Muya，而不是继续在不合适的内核上堆补丁。

## 3. 选择理由

### Electron

- Windows、macOS、Linux 桌面能力和打包路径成熟。
- 对本地文件、窗口、菜单、打印和 PDF 的支持能覆盖规划需求。
- 当前阶段更重要的是验证编辑体验和文件安全，而不是最小安装包。

代价：

- 内存和安装包通常大于使用系统 WebView 的方案。
- 必须严格处理 renderer 隔离、IPC 和导航安全。

### Milkdown/ProseMirror

- 文档状态和编辑事务结构化，适合撤销、选区和插件扩展。
- 可以在 React 项目中通过适配层集成。
- Markdown 导向比通用 HTML 富文本编辑器更符合项目目标。

主要风险：

- ProseMirror 文档树与原始 Markdown 不是一一对应。
- 完整源码保真需要保护节点、原始切片或局部补丁策略。
- 中文 IME、表格和大文档表现必须通过实测确认。

### CodeMirror 6

- 适合完整 Markdown 源码编辑。
- 可以与富文本模式保持明确的模式边界。
- Beta 采用独立撤销历史，避免强行统一两个编辑器的内部事务。

## 4. 适配器边界

渲染层不得直接在业务组件中调用 Milkdown 或 ProseMirror 内部对象。必须提供项目自有接口，至少覆盖：

```ts
export interface EditorAdapter {
  mount(container: HTMLElement): Promise<void>
  loadMarkdown(markdown: string): Promise<EditorLoadResult>
  getMarkdown(): Promise<string>
  isDirty(): boolean
  focus(): void
  undo(): boolean
  redo(): boolean
  execute(command: EditorCommand): boolean
  getLocation(): EditorLocation
  restoreLocation(location: EditorLocation): boolean
  onChange(listener: (change: EditorChange) => void): () => void
  destroy(): Promise<void>
}
```

业务层只依赖：

- 项目定义的 Markdown 字符串。
- 项目定义的命令。
- 项目定义的位置和变化事件。
- 项目定义的错误类型。

第三方文档节点、事务和插件对象不得跨越适配器边界写入文件服务或应用状态。

## 5. 主进程边界

Electron 采用：

```text
src/
├── main/       窗口、菜单、文件、草稿、监控、外部链接
├── preload/    最小白名单 IPC
├── renderer/   UI 和编辑器适配器
└── shared/     schema、消息协议、纯状态机和类型
```

强制配置：

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- 禁止 renderer 任意导航和创建窗口
- preload API 和 IPC 参数使用运行时 schema 验证
- 文件状态机和 Markdown 转换可以脱离 Electron 测试

## 6. Phase 0 验证门槛

### 6.1 必须通过

| 类别 | 门槛 |
|---|---|
| 基础语法 | 兼容规范中 MVP/编辑语法可创建、修改和重新打开 |
| 测试集 | 至少 30 个 round-trip 样例通过 F0、F1、F2 对应断言 |
| 中文 IME | 微软拼音输入、候选、回退、确认、跨行输入不丢字或重复 |
| 撤销重做 | 输入、粘贴、格式化、列表和保护节点相邻编辑可正确撤销 |
| 保护节点 | HTML、引用定义等未知或保护语法不被删除 |
| 性能 | 基准环境 DOC-M 打开 P95 ≤ 2 秒，输入延迟 P95 ≤ 50 ms |
| 生命周期 | 编辑器反复 mount/destroy 100 次无明显监听器累积或崩溃 |
| 安全 | renderer 无 Node.js 直接能力，危险链接和 HTML 不执行 |
| 许可证 | 核心依赖许可证与计划采用的 MIT 项目兼容 |

### 6.2 触发重新选型

出现任一情况，应暂停功能开发并重新评估 Muya 或其他内核：

- 中文 IME 存在无法通过适配层修复的稳定复现丢字问题。
- 保护节点无法可靠保留原文。
- 基础列表、代码块或链接无法满足语义 round-trip。
- 达不到 DOC-M 性能门槛且分析表明问题来自内核架构。
- 为实现 MVP 必须长期维护大范围第三方内核补丁。
- 许可证或依赖发布方式与项目目标不兼容。

## 7. 备选方案

### Muya

优势：

- 专门面向 Markdown 混合编辑。
- MarkText 的产品形态与本项目较接近。
- 架构中包含文档状态、渲染、选区和序列化思路。

暂不首选原因：

- 需要单独验证当前 API 稳定性、集成方式和维护成本。
- 不能因为产品相似就跳过 IME、保真和性能测试。

### Tauri

优势：

- 安装包和内存潜力更好。
- Rust 主进程权限边界更明确。

暂不首选原因：

- MVP 的主要风险位于编辑器和文件语义，不是桌面壳体积。
- 额外工具链会增加 Phase 0 变量。

可在 Beta 后通过桌面适配层重新评估。

### Electrobun

优势：

- 启动和包体积方向符合轻量产品。

暂不首选原因：

- 项目成熟度和生态需要进一步验证。
- 当前没有必要同时承担编辑器与桌面框架的双重技术风险。

### 直接 Fork MarkText/HorseMD

暂不采用：

- 会继承大量不在 MVP 范围内的功能和历史约束。
- 增加品牌、架构和许可证审计成本。
- 本项目希望先建立清晰、最小的文件安全和兼容合同。

允许阅读其公开源码、测试和架构文档，并在许可证允许范围内学习或复用明确模块。

## 8. 源码模式决策

Beta 的源码模式采用独立 CodeMirror 状态：

1. 富文本切换到源码时序列化一次 Markdown，并创建切换快照。
2. 用户在源码模式内使用 CodeMirror 历史。
3. 返回富文本时解析完整源码。
4. 解析成功后作为一次文档替换事务提交。
5. 解析失败则留在源码模式，不丢弃输入。

不在 Beta 承诺跨两个编辑器的逐字符统一撤销。若未来需要统一历史，必须建立新的 ADR。

## 9. 后果

正面后果：

- 可以快速验证真实编辑体验。
- 编辑器、源码模式和文件服务边界明确。
- 将来替换内核时，业务层改动受适配器限制。

负面后果：

- MVP 安装包和内存不会最小。
- 需要主动建设 Markdown 保护节点和 round-trip 测试。
- Electron 安全配置和依赖更新属于持续维护成本。

## 10. 复审记录

Phase 0 结束时必须补充：

- 实际依赖版本。
- 30 个测试样例结果。
- IME 测试结果。
- 性能数据。
- 已知内核补丁。
- 最终状态：接受、替代或废弃。

