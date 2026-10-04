# 开发指南

Penlume 使用 Electron、React、TypeScript 和 Vite，所见即所得编辑器基于 Milkdown/ProseMirror，源码编辑器基于 CodeMirror 6。当前发布与桌面验收覆盖 Windows x64，其他平台尚未完成验证。

## 环境与启动

准备 Git、Node.js 22.12 或更高版本及 npm。克隆仓库后，在包含 `package.json` 的根目录运行：

```powershell
npm ci
npm run dev
```

`npm ci` 按锁文件安装依赖，首次安装需要下载 npm 依赖和 Electron。`npm run dev` 先编译主进程及 preload，再启动 `127.0.0.1:5173` 的 Vite 服务和 Electron 窗口。发布程序直接加载打包文件，不依赖这个开发服务。

渲染层修改由 Vite 更新。修改 `src/main/`、`src/preload/` 或主进程使用的共享代码后，停止并重新执行 `npm run dev`，使 Electron 加载新编译结果。

开发版默认沿用旧名称的数据目录 `%APPDATA%\ttypora`，以保留已有设置与恢复草稿。需要独立开发数据时，可在同一个 PowerShell 会话中设置：

```powershell
$env:TTYPORA_USER_DATA_PATH = Join-Path $env:TEMP 'penlume-dev-data'
npm run dev
```

使用后通过 `Remove-Item Env:TTYPORA_USER_DATA_PATH` 取消该会话的覆盖。不要直接删除日常使用的数据目录来排查问题。

## 准备 Pandoc

Git 仓库不包含 `.tools/` 下的 Pandoc 二进制。首次克隆后，需要转换功能、转换相关测试或 Windows 打包时，执行：

```powershell
npm run setup:pandoc:win
```

该准备步骤为 Windows 构建提供 Pandoc 3.12、随附许可与来源记录，放入 `.tools/pandoc/`。首次准备需要网络；准备完成后的本地文档转换可离线运行。普通 Markdown 编辑和 TypeScript/Vite 构建不要求 Pandoc。

运行时，手动配置的 Pandoc 路径优先；未配置时先查找随应用提供的程序，再查系统 `PATH`。开发模式的内置路径为 `.tools/pandoc/pandoc-3.12/pandoc.exe`，发布模式为应用资源目录的 `tools/pandoc/pandoc.exe`。仅在系统安装 Pandoc 不能替代打包所需的 `.tools/` 资源。

## 项目结构

| 目录或文件 | 职责 |
| --- | --- |
| `src/main/` | Electron 窗口与菜单、经过校验的 IPC、文件保存与冲突、工作区、草稿、资源和导出服务 |
| `src/preload/index.ts` | 通过 `contextBridge` 向渲染层暴露有限的应用接口 |
| `src/shared/` | IPC 名称与契约、数据校验、偏好、文档状态、历史、Markdown 扩展、主题、排版和本地化 |
| `src/renderer/App.tsx` | 工作区界面及文档操作协调 |
| `src/renderer/components/` | 侧栏、设置、命令搜索、预览和其他界面面板 |
| `src/renderer/editor/` | Milkdown/CodeMirror 适配、选区映射、表格、代码、公式及编辑兼容逻辑 |
| `src/renderer/export-document.ts` | 独立 HTML 的 Markdown 渲染、样式和公式资源 |
| `tests/` | Vitest 单元测试和小型夹具 |
| `scripts/` | Electron 桌面验收、构建辅助和发布包校验 |
| `docs/` | 需求、架构决策、兼容边界与版本验证记录 |

主进程负责本地文件和系统能力；渲染层通过 preload 契约调用。新增 IPC 时同步更新共享定义、参数校验、preload 和调用方，保持 Electron 的上下文隔离与沙箱设置。编辑操作应经项目适配层维护历史和选区；不要依赖界面组件直接修改第三方编辑器状态。

## 构建与检查

```powershell
npm run typecheck
npm test
npm run build
npm run test:smoke
```

`npm test` 在 Node 环境运行 Vitest；`npm run test:watch` 用于持续开发。`npm run build` 清理 `dist/`、`coverage/` 后执行类型检查并构建主进程、preload 和渲染层。`test:smoke` 自带构建，再启动 Electron 检查基本桌面流程。

按修改范围选择桌面回归：

| 修改范围 | 命令 |
| --- | --- |
| 窗口布局、尺寸设置 | `npm run test:layout` |
| 正文排版、设置可读性 | `npm run test:typography` |
| 编辑历史与视图切换 | `npm run test:editor` |
| 普通选区复制 | `npm run test:selection-copy` |
| 表格剪贴板 | `npm run test:table-clipboard` |
| 中英文界面 | `npm run test:localization`、`npm run test:editor-locale` |
| 转换、设置与生产工具 | `npm run test:production` |

这些 npm 命令各自包含构建。已有新构建时，可用统一入口一次构建后串行执行指定套件：

```powershell
npm run build
node scripts/desktop-verification.mjs layout typography selection-copy
```

完整桌面检查使用 `npm run test:desktop`。套件会使用临时文档和独立数据目录，日志与报告写入 `artifacts/`；默认在失败后停止。桌面测试共享系统剪贴板和图形会话，不要同时运行多个 Electron 套件。单元测试通过不能代替实际键盘、剪贴板或窗口流程的验收。

## Windows 打包

完成 Pandoc 准备后，按需要构建：

```powershell
npm run setup:pandoc:win
npm run package:dir
npm run package:win
npm run package:portable:win
# 不捆绑 Pandoc 的公开 Core 发行版，不要求上面的 Pandoc 下载步骤
npm run package:core:win
```

三个打包命令均包含构建，分别生成目录程序、NSIS 安装版和单文件便携版。输出目录由 `package.json` 的 `build.directories.output` 决定，当前为 `release-v0.12.1/`。首次打包还可能下载 electron-builder 的工具。

`package:core:win` 单独生成安装版和便携版到 `release-core-v0.12.1/`，保留发行所需许可，不包含 Pandoc。本次公开的 GitHub Release 使用 Core 包；转换工具由用户另行安装。完整本地包的 Pandoc 来源与对外分发前需处理的对应源码材料见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

需要完整发布校验时，安装版、便携版及 `win-unpacked/` 必须来自当前源码版本，然后执行：

```powershell
npm run test:packaged:win
npm run test:portable:win
npm run verify:release:win
```

发布校验对比当前 `dist/` 和包内编译文件，检查 Pandoc、许可资源及两种可执行文件，并生成 SHA-256 清单和 `artifacts/` 报告。同版本重复验收时先另存旧报告；脚本不会覆盖已有报告。便携版启动检查不等于安装程序或所有桌面套件已通过。

要让统一桌面入口验收发布程序，设置 `TTYPORA_PACKAGED_EXE` 为 `win-unpacked/Penlume.exe` 的路径，再执行 `node scripts/desktop-verification.mjs`；取消变量后回到源码构建模式。可通过 `TTYPORA_VERIFICATION_PREFIX` 指定报告前缀，使用不含路径的字母、数字、点、下划线或连字符。

当前 Windows 发布包尚未数字签名。实际测试范围和剩余限制以对应的 `docs/PRODUCTION_*.md` 记录为准。参与提交的流程见 [贡献说明](../CONTRIBUTING.md)。
