# Penlume

**A quiet place to write.**

[简体中文](README.md) · **English** · [Releases](https://github.com/scramers/Penlume/releases) · [Development](docs/DEVELOPMENT.md) · [Contributing](CONTRIBUTING.md)

Penlume is a local-first Markdown desktop editor for notes, technical documentation, and long-form writing. Write directly in a formatted document, edit Markdown source, or use source and preview together. Your documents stay in the folders you choose. No account is required for everyday writing.

![Penlume 0.12.1 writing view](docs/images/writing.png)

## Features

- A quiet writing view, focus and typewriter modes, word counts, and writing goals.
- Multiple documents, a file tree, searchable outline, quick open, and workspace search.
- Formatting shortcuts, a command palette, find and replace, document-level undo and redo across views.
- Copy selections as Markdown, HTML, or plain text; dedicated rectangular table clipboard operations.
- GFM tables, task lists, footnotes, LaTeX math, Mermaid diagrams, syntax highlighting, and YAML front matter.
- Local image resources, paste and drag/drop, image sizing, reference checks, and local audio/video.
- Light and dark appearance, eight built-in themes, custom CSS, Chinese and English UI.
- HTML, PDF, and PNG export; Pandoc-based Word, EPUB, ODT, RTF, and LaTeX conversions.
- Recovery drafts, unsaved-change prompts, external-change checks, and atomic file replacement when saving.

## Getting started

The verified platform is **Windows x64**. Download **Core Setup** for installation or **Core Portable** for a single-file executable from [Releases](https://github.com/scramers/Penlume/releases).

Core includes the editor and HTML/PDF/PNG exports. It does not bundle Pandoc. For Word/EPUB and other conversions, [install official Pandoc](https://pandoc.org/installing.html), then configure its executable path in preferences or let Penlume find it on PATH. Windows builds are unsigned.

Use `Ctrl+N` to create a document, `Ctrl+O` to open one, and `Ctrl+S` to save. Switch between **Write**, **Source**, and **Split** in the header. Use `Ctrl+K` to search commands for formatting, copying, exporting, and layout.

| Layout setting | What it changes |
| --- | --- |
| Text size | Document text only, from 12 to 32 px |
| Maximum text width | The document region including horizontal padding; adapts to smaller windows |
| Interface zoom | Text and application controls together, from 75 to 150%; does not change exports or native menus |

Drag dividers to resize the sidebar or source/preview panes. In narrow windows, the sidebar overlays the document and split view stacks vertically. Settings persist and can be reset.

![Separate text size, text width, and interface zoom settings](docs/images/settings.png)

## Windows shortcuts

| Action | Shortcut |
| --- | --- |
| Command palette | `Ctrl+K` |
| Bold / italic / inline code | `Ctrl+B` / `Ctrl+I` / `Ctrl+E` |
| Find / replace | `Ctrl+F` / `Ctrl+H` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Toggle source / split view | `Ctrl+/` / `Ctrl+Shift+V` |
| Copy selection as Markdown / plain text | `Ctrl+Shift+C` / `Ctrl+Alt+C` |
| Toggle sidebar / focus / typewriter | `Ctrl+Shift+L` / `F8` / `F9` |
| Text size up / down / reset | `Ctrl+Alt+=` / `Ctrl+Alt+-` / `Ctrl+Alt+0` |
| Interface zoom in / out / reset | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |

HTML copying is available through the Edit menu or command palette. Use ordinary `Ctrl+C` for a rectangular table selection. Some complex selections cannot yet be copied in an explicit format.

## Local data

Documents remain ordinary local Markdown files. Settings, sessions, and recovery drafts live in the local application data directory. Recovery drafts are not a substitute for backups.

By default, Penlume requires no sign-in, uploads no documents, and sends no telemetry. Editing, saving, and prepared Pandoc conversions work offline. Remote images, external links, and explicitly configured image upload tools may access the network.

The project was formerly named **TTypora**. Some internal identifiers and the `ttypora` data directory remain for compatibility with existing settings, sessions, and drafts.

## Development

Install Git, **Node.js 22.12+**, and npm:

```bash
git clone https://github.com/scramers/Penlume.git
cd Penlume
npm ci
npm run dev
```

```bash
npm run typecheck
npm test
npm run build
```

For Windows conversions and packaging, prepare the pinned official Pandoc download, verified with SHA-256:

```powershell
npm run setup:pandoc:win
npm run package:win
npm run package:portable:win
# Public distribution without bundled Pandoc
npm run package:core:win
```

The repository excludes dependencies, downloaded tools, user data, builds, and local test artifacts. See the [development guide](docs/DEVELOPMENT.md) for architecture, desktop tests, and packaging.

## Status

Version **0.12.1** passed local type checking, build, **1,138 unit tests**, and eight checks against the final Windows program covering typography, layout, exports, localization, basic desktop behavior, selection copying, editor history, and portable launch.

macOS/Linux, every native input method, and system installation/upgrade flows have not been validated. Complex selections, very large documents, and advanced conversions have limitations. Windows builds are currently unsigned. Penlume does not claim complete feature or performance parity with Typora.

See the [0.12.1 notes](docs/PRODUCTION_V0.12.1.md), [implementation status](docs/IMPLEMENTATION_STATUS.md), and [Markdown compatibility policy](docs/MARKDOWN_COMPATIBILITY.md). Historical `artifacts/` references are local verification outputs, not downloadable repository files.

## Contributing and license

Bug reports, documentation improvements, and pull requests are welcome. Include reproducible steps and a minimal Markdown example, and remove private information. See [CONTRIBUTING.md](CONTRIBUTING.md).

Original Penlume code and documentation use the [MIT license](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Thanks to Electron, Milkdown, ProseMirror, CodeMirror, React, Mermaid, KaTeX, Pandoc, and their communities.
