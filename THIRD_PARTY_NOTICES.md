# 第三方组件与来源

根目录的 [MIT 许可证](LICENSE) 适用于 Penlume 原创代码和文档。第三方软件、字体、数据和工具保留各自版权与许可；不能将整个安装包统一称为 MIT。

## npm 依赖

依赖版本、完整性校验值和来源记录在 [package-lock.json](package-lock.json)。Electron、React、Milkdown、ProseMirror、CodeMirror、Mermaid、KaTeX、DOMPurify 等组件由其原作者维护。

`npm run licenses:collect` 从按锁文件安装的运行依赖收集许可原文，生成 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)，供发布包随附。升级依赖后应重新生成并审查变化。这份清单用于保留归属和许可，不代替对实际发行内容的审查。

Electron 发行文件还附带 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`，分别记录 Electron 与 Chromium 等组件的许可。

## 仓库中的第三方副本

| 文件 | 来源与版本 | 许可记录 |
| --- | --- | --- |
| `public/mermaid.min.js` | npm `mermaid@11.17.2` 的 `dist/mermaid.min.js`，未经修改 | [Mermaid MIT](public/MERMAID-LICENSE)，以及文件末尾保留的内嵌组件版权注释 |
| Mermaid 内嵌 DOMPurify | 上述 npm 预构建文件内的 3.4.12；与根依赖版本不同 | [原始双许可文本](licenses/DOMPurify-3.4.12-LICENSE)，此副本采用 Apache-2.0 分支 |
| `src/shared/emoji-data.ts` | GitHub gemoji 数据 | [MIT](src/shared/emoji-data.LICENSE) |
| `src/shared/markdown-character-entities.ts` | character-entities 数据 | [MIT](src/shared/markdown-character-entities.LICENSE) |

Mermaid 文件 SHA-256：`581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8`。`npm run prepare:vendor` 从锁定的 npm 安装位置复制它并检查版本和哈希；开发、构建与许可收集命令自动执行这一步。生成的文件不入 Git，内嵌许可注释保留。

## Pandoc：可选转换工具

Pandoc 采用 **GPL-2.0-or-later**，不是 Penlume 的 MIT 许可部分。Penlume 通过独立进程调用它。

公开的 Windows **Core** 发行版不捆绑 Pandoc。需要 Word / EPUB / ODT / RTF / LaTeX 转换时，用户可从 [Pandoc 官方安装页面](https://pandoc.org/installing.html) 安装，再在 Penlume 中指定可执行文件路径，或让程序从系统 PATH 检测。HTML / PDF / PNG 的基础导出无需 Pandoc。

开发用 `npm run setup:pandoc:win` 下载官方 Pandoc 3.12 Windows x64 归档，核对 SHA-256 并保存许可和来源记录：

- [官方版本发布](https://github.com/jgm/pandoc/releases/tag/3.12)
- [官方 Windows ZIP](https://github.com/jgm/pandoc/releases/download/3.12/pandoc-3.12-windows-x86_64.zip)
- ZIP SHA-256：`2a77ebc2517d13e95056e76b1cd5b574cfe958ac61aa6058117d80c22ca19b79`
- [3.12 版权与第三方声明](https://github.com/jgm/pandoc/blob/3.12/COPYRIGHT)
- [3.12 源码](https://github.com/jgm/pandoc/tree/3.12)与[构建流程](https://github.com/jgm/pandoc/blob/3.12/.github/workflows/release-candidate.yml)

默认的完整本地打包命令会将 `.tools/` 中的 Pandoc 加入安装包，适合本机开发验收。对外分发这类包前，需要处理 Pandoc 实际二进制的完整对应源码、所含依赖源码和构建材料。本次 GitHub 发行选择不捆绑 Pandoc 的 Core 包；已有本地完整安装包未作为公开附件上传。
