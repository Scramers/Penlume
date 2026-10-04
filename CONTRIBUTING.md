# 参与 Penlume

欢迎提交缺陷报告、功能建议、文档改进和代码变更。Penlume 当前以 Windows x64 为已验证平台；macOS、Linux 的构建与桌面行为尚未完成验证。

## 开始开发

安装 Git 和 Node.js 22.12 或更高版本，克隆仓库后进入包含 `package.json` 的项目根目录：

```powershell
npm ci
npm run dev
```

需要测试文档转换或制作 Windows 包时，先运行 `npm run setup:pandoc:win`。Pandoc 下载与开发环境的完整说明见 [开发指南](docs/DEVELOPMENT.md)。

## 提交问题

请先检索已有 Issue，然后说明：

- Penlume 版本、Windows 版本，以及使用安装版、便携版还是源码开发版。
- 可重复的操作步骤、预期结果和实际结果。
- 涉及编辑时的视图模式、选区位置和最小 Markdown 示例；涉及显示时的窗口尺寸、界面缩放和主题。
- 有帮助的截图或错误日志。提交前移除个人文档、凭据和私有路径。

功能建议请描述实际写作场景，以及目前哪些操作难以完成。与 Typora 比较时，说明具体行为和复现示例，便于核对。

## 提交 Pull Request

1. 从仓库默认分支创建自己的开发分支，一次解决一个明确问题。
2. 遵循现有 TypeScript、React 和编辑器适配层结构；不要在界面组件中绕过经过校验的 IPC 访问本地文件。
3. 为编辑、序列化、文件保存或资源权限的行为变更补充适当回归测试。界面调整检查常用窗口、小窗口、明暗主题及中英文显示。
4. PR 描述写清触发条件、修改后的行为和实际验证结果。界面变更附截图；没有执行的检查请注明。

代码变更通常先完成：

```powershell
npm run typecheck
npm test
npm run build
```

再执行与变更相关的桌面套件，例如布局用 `npm run test:layout`，正文排版用 `npm run test:typography`，编辑历史用 `npm run test:editor`。桌面测试需要可用的 Windows 图形会话，应串行运行。纯文档改动核对链接、命令和事实即可。

修改依赖时同步提交 `package.json` 与 `package-lock.json`。不要提交 `node_modules/`、`.tools/`、`dist/`、`release-*/`、`artifacts/` 或个人文档；测试夹具应小而可复现。

现有功能与边界以 [实现状态](docs/IMPLEMENTATION_STATUS.md)、[Markdown 兼容策略](docs/MARKDOWN_COMPATIBILITY.md) 和各版本发布记录为依据。新增功能请同步相关使用说明；发布版本号和二进制附件由维护者统一处理。
