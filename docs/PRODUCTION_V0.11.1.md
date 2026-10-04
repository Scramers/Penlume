# Penlume 0.11.1 品牌发布记录

**Penlume — A quiet place to write.**

本批品牌发布验收已完成，冻结源码、包内文件、实际 GUI、旧数据继承和旧版保留的最终复核见 [验收记录](../artifacts/penlume-branding/ACCEPTANCE_V0.11.1.json)。

2026-10-04：软件正式名称改为 Penlume，版本为 0.11.1。当前窗口标题、顶栏、原生「帮助 → 关于 Penlume」、程序产品信息与发布文件名已使用新名称。原来的 T· 标识改为 P·，SVG、PNG 和七种尺寸的 Windows ICO 同步更新。760 像素宽的窗口仍完整显示品牌副标题。

保留原有数据目录和内部兼容标识：默认 `appData/ttypora`，设置、语言、主题、最近项目与草稿无需因为改名切换存储位置。主进程在启动前创建数据目录，统一设置 userData/sessionData；原有受控测试目录覆盖仍可用。文档正文和用户 Front Matter 标题保留原样。

## 当前验证

- 完整类型检查与构建通过；54 个测试文件、1,108 项单元测试通过。首次单测发现新增关于窗口缺少「确定」的英文词条，已补齐，失败日志保留。
- 受影响的 electron、localization、parity 三套源码回归通过；最终发布程序中的这三套串行回归全部通过。这次没有重新运行完整 21 套；该完整回归属于 [0.11.0 的实际验收](PRODUCTION_V0.11.md)。
- 品牌专项在最终源码和最终发布程序均通过：实际 app 名称/版本、包元数据、中文/英文标题与关于菜单、全新隔离数据目录创建、1180/760 像素宽的明暗布局、工作区名称及原始正文保留。关于窗口校验真实原生菜单回调和实际 options，受控关闭；不等于原生操作系统消息框像素验收。
- 最终 Windows 安装包、单文件便携版和目录程序已生成。包内 223 个编译文件与冻结构建一致，Pandoc 3.12 和五项许可证资源完整。便携版实际解包、启动、编辑器就绪和正常退出通过。
- 三份程序的实际 Windows 产品名称为 Penlume，安装包和便携版的程序介绍为精确品牌句。实际 Authenticode 状态均为 NotSigned。

旧版数据继承专项在源码和发布程序分别通过：先由真实 0.11.0 界面建立 English、深色、21px 字号、启动恢复及未保存草稿，再由 Penlume 实际恢复、保存并重启恢复会话。两轮各三个应用进程均正常退出，旧 EXE/asar 哈希不变，原生函数与观察器恢复，精确临时目录清理完成。真实用户的默认数据目录没有作为测试夹具打开。系统安装、升级、快捷方式点击、系统文件关联与其他操作系统未在本次实际验收。

## 发布文件

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `release-v0.11.1/Penlume Setup 0.11.1.exe` | 175882816 | `d9e8554e2bea58aa45d735186793793cd0462e494de0a49ac3f98a1446131298` |
| `release-v0.11.1/Penlume Portable 0.11.1.exe` | 175668145 | `43d2e1ed79bd042baa3d409fd30b028ef93426e89a21f90920f01be113e23d0c` |
| `release-v0.11.1/win-unpacked/Penlume.exe` | 245289984 | `12d8e085561b67f080ab622995d2b80bcdc3012e5ff45787b3685f7216e4e22b` |

目录程序需保留同目录依赖。0.11.0 及更早版本的实际文件名、哈希和验收记录保留；发布校验报告改用完整版本号，避免 0.11.1 覆盖 0.11.0 记录。未发布的初始品牌候选保留在 `release-v0.11.1-initial-branding/`，不作为当前下载。

## 证据与范围

- [最终冻结源码与构建](../artifacts/penlume-branding/FROZEN_BRAND_FINAL_BUILD.json)：208 个源码、脚本、配置与品牌资源指纹，223 个编译文件，旧版安装包/便携版及两份关键旧记录未改变。
- [最终包内一致性](../artifacts/release-v0.11.1-verification.json)、[程序产品信息及签名状态](../artifacts/penlume-branding/programs-v0.11.1.json)、[发布程序三套回归](../artifacts/desktop-penlume-v0.11.1-packaged-final.json)。
- [源码品牌专项](../artifacts/penlume-branding/results/brand-penlume-v0.11.1-source-complete-motto-20261003180359250-25506cb3/verification.json)、[发布程序品牌专项](../artifacts/penlume-branding/results/brand-penlume-v0.11.1-packaged-final-20261003180756951-d73bf2a6/verification.json)。成功报告均在原生函数恢复、实际主进程与启动进程正常退出、精确临时目录清理后写入。
- [源码继承旧数据专项](../artifacts/data-compatibility-penlume-v0.11.1-source-data-verification.json)、[发布程序继承旧数据专项](../artifacts/data-compatibility-penlume-v0.11.1-packaged-data-verification.json)。原生退出确认与保存目的路径仅提供受控结果，原始主进程草稿/保存处理实际执行；不向 localStorage 或编辑器注入会话数据。
- 根代理实际查看了发布程序的 1180px 明亮、760px 深色截图及生成的 256px P· 图标；标识与副标题可读，未观察到顶栏重叠或副标题省略。此视觉检查只覆盖这些样本，其他宽度/主题由专项中列明的自动布局检查承担。
- 原品牌脚本首次运行因 Playwright evaluate 不支持动态 import 失败。保留失败与清理证据；后续宿主根据真实 appPath 读取实际包元数据，未修改产品来适配测试。窄窗口初次截图存在正常省略号，已调整品牌栏宽度，最终完整副标题与布局断言通过。
- 首次最终包校验在打包进程尚未结束时读取到缺失安装文件，日志保留；打包正常结束后，独立校验通过，没有以缺失文件结果当作成功。

这次发布实现品牌更新，既有功能与未完成的 Typora 对齐项目按原状态保留。0.12 的书签映射、普通选区格式复制与普通导出保护候选仍位于隔离目录，未包含在本版本。
