# 0.11.0 发布记录：长文序列化与大纲控制

状态：2026-10-04 本批 Windows 发布验收完成。[最终冻结记录](../artifacts/source-v0.11-build.json)核对完整构建、54 个文件的 1,108 项单测、一次顺序运行的全部 21 套发布程序桌面回归、最终源码和发布程序各四组独立图片文件控件、便携版正常启动／退出、222 个包内编译文件及实际 PNG/PDF 检查。0.10.0 继续保留；本批完成不代表完整 Typora 对齐或整体超越。

## 已合并的改进

可视化编辑器按不可变 ProseMirror 文档对象缓存一份规范 Markdown。同一文档的选区和 stored marks 变化可复用；正文、格式或节点属性产生新的文档对象时立即失效。挂载、显式正文替换和销毁清空缓存，序列化错误不会发布缓存值。原始 Markdown 回退仍由适配器逐次判断，不存入规范缓存。

同步文档变更通知、共享历史记录和会话引用更新保留。移除适配器额外的延迟 `markdownUpdated` 订阅，避免已同步通知的文档再触发全文序列化；底层 listener 插件及其其他公共能力保留。书签源码映射、历史差异扫描、统计、资源授权和大纲 Worker 未因该改动被延后或关闭。

合并方法与之前的完整适配器副本见[局部补丁记录](../artifacts/source-v0.11-serialization-cache-application.json)。0.10 发布产物和冻结记录继续保留。

## 实际验证

- [完整类型检查及构建](../artifacts/build-v0.11-serialization-cache.log)与[53 个文件、1,083 项单元测试](../artifacts/unit-v0.11-serialization-cache.log)通过。
- [六套源码桌面回归](../artifacts/desktop-v0.11-source-serialization-cache.json)通过：普通功能与即时保存、文档历史、扩展标记、代码公式、大纲和图片输入预览。该轮在大纲控制合并前运行，最终发布程序验证另列如下。
- [另五套源码回归](../artifacts/desktop-v0.11-source-cache-table-history.json)通过：工作区、表格剪贴板、连续换行、图片绑定和资源上下文。两轮为六套加五套选定回归，未冒称全套一次运行；[缓存基础指纹](../artifacts/source-v0.11-cache-foundation.json)在大纲控制合并前记录。
- [同一百万字符文档的无 CPU 采样复测](../artifacts/performance-v0.11-source-serialization-cache.json)完成。每种模式十次真实输入，全文保存、未打开原件及跨模式完整 PM 模型核对通过，无 renderer 错误。

| 输入到观察到模型变化 | 0.10.0 | 0.11.0 序列化改进 |
|---|---:|---:|
| 可视化中位数 | 336 ms | 304.95 ms |
| 可视化范围 | 304.6–413.7 ms | 287.9–400.8 ms |
| 源码中位数 | 5.1 ms | 4.75 ms |

两轮使用相同 SHA-256 为 `9e6d0bad20ee04f69e2bf52c89660025dcaa1135f1af205e9f2011a182a12874` 的夹具和同一机器，时间范围重叠。该单次观察结果不代表绘制完成、内部事务耗时、统计显著性、全部长文性能或 Typora 对比。可视化长文输入仍有明显延迟。

## CPU 诊断与后续工作

[0.10 冻结版本的实际 CPU profile](../artifacts/performance-profile-v0.10-source-frozen-cpu-diagnostic.json)保存了当前 renderer 主 JavaScript 线程的两段真实十键区间。采样可见同步通知与书签读取中的重复规范序列化路径；原始 profile 保留，不替代无采样性能记录。轮询、等待和延迟任务也包含在区间，Worker 及其他进程不属于该采样归属。

[采样分析](../artifacts/v0.11-staging/performance-profile/ANALYSIS.md)按真实样本和时间间隔核对，并保留对应冻结 bundle。书签映射中的完整 Markdown 解析仍出现在实际栈里；本次规范缓存未消除它。区间权重不是函数调用次数、逐键精确 CPU 时间或可以直接相加的各项耗时。

## 大纲控制已合并，源码专项通过

大纲树按真实父子关系折叠整个后代分支，保留其他分支。平铺使用原始标题顺序和导航索引，暂不应用折叠。标题文字筛选为不区分大小写的普通子串搜索，显示所有层级的匹配及真实祖先；搜索时暂忽略级别与折叠，清空后恢复。折叠按钮提供展开状态与左右方向键操作。

折叠、筛选和平铺状态归属于稳定文档 ID，两个未保存文档彼此独立，隐藏再打开侧栏和另存为保留状态；关闭标签清理状态。正文导致的行号变化保留折叠，标题文字或级别序列可观察的变化清空折叠。相同文字、相同级别的不可辨位置重排没有永久标题 ID 保证。隐藏的活动标题只投影到真实可见祖先。

待解析或失败时不显示旧索引行，控件暂禁用，文档、标题数组引用与当前视图检查阻止过期操作。控制动作不改正文，不添加文档历史。此处折叠是侧栏大纲折叠，不是编辑器正文折叠。

[合并记录](../artifacts/source-v0.11-outline-controls-application.json)保留局部补丁及原文件。第一轮构建在双语 Sidebar 测试夹具缺少新参数时停止，原[失败日志](../artifacts/build-v0.11-outline-controls.log)保留。补齐测试夹具后，[完整构建](../artifacts/build-v0.11-outline-controls-fixture-repair.log)与[54 个文件、1,108 项单测](../artifacts/unit-v0.11-outline-controls-fixture-repair.log)通过；未为此修改产品逻辑。

既有大纲脚本的标题定位改为仅选导航按钮；待解析断言改为零索引／零高亮及全部控件禁用，保留实际 Worker、原文、选区和历史覆盖。[当前源码四套回归](../artifacts/desktop-v0.11-source-outline-controls.json)通过：基础桌面、功能与导出、既有大纲十组及双语界面。

[新大纲六组源码专项](../artifacts/outline-controls-v0.11-source-outline-controls-native-newlines-verification.json)通过。真实键盘与控件覆盖树形／平铺／标题筛选、同名标题准确导航、两份同名未保存文档状态、普通正文行位移、标题重命名与共享撤销，以及持有真实 Worker Event 后切换文档的所有权检查。成功记录在 Worker、监听器恢复、应用退出和精确夹具清理之后写入。未冒称 Save As 系统对话框、IME、Worker 错误恢复或自然系统乱序的桌面覆盖。

两次新专项失败记录保留：[第一次](../artifacts/outline-controls-v0.11-source-outline-controls-native-failure.json)为完整模型预期遗漏重命名标题同步更新的锚点 ID；[第二次](../artifacts/outline-controls-v0.11-source-outline-controls-renamed-id-failure.json)为自动化多行插入的首个换行未按夹具预期进入源码。正式脚本分别补齐锚点预期、以真实 Enter 按键构造换行；产品代码未因这两处测试修订改变。

[合并大纲控制后的百万字符复测](../artifacts/performance-v0.11-source-outline-controls.json)使用相同夹具，视觉输入中位数 302.8 ms（279.7–406.5），源码 5.1 ms（3.7–16.4）。二十次输入、全文保存、完整 PM 模型及原件核对通过，无 renderer 错误。该记录保留之前独立缓存复测的范围及限制，仍不证明统计显著性、绘制耗时或 Typora 性能差异。

已将新专项加入默认桌面验证，合计 21 套。[发布程序全套记录](../artifacts/desktop-v0.11-packaged-native-ui.json)实际一次顺序运行全部通过，累计约 27 分钟；[新大纲六组的发布程序记录](../artifacts/outline-controls-v0.11-packaged-native-ui-verification.json)同样在恢复和清理后写入。未把多轮选定源码回归当作全套源码一次运行。

## 本批 Windows 发布验收

安装版和便携版位于 `release-v0.11.0/`。[包内核对](../artifacts/release-v0.11-verification.json)确认全部 222 个编译文件与本次构建一致，内置 Pandoc 及五份许可证一致。[候选指纹](../artifacts/source-v0.11-candidate.json)冻结 203 个源／测试／脚本／配置文件和三份程序，最终记录重新核对全部指纹及当前 app.asar。三份程序的实际 Authenticode 状态均为 `NotSigned`，见[签名检查](../artifacts/signatures-v0.11.json)。未实际测试安装、文件关联、升级及其他平台。

- [最终源码独立图片四组](../artifacts/image-input-extra-v0.11-source-final-image-extra-verification.json)与[发布程序独立四组](../artifacts/image-input-extra-v0.11-packaged-image-extra-verification.json)通过：真实文件选择复制、首次保存后插入、A/B 文件返回次序和原生图片脱离／重新连接后的缩放及共享撤销。处理器与对话框身份恢复、观察器清理、进程退出及精确夹具移除通过。首次保存的路径由测试控制，不等于系统对话框界面验收；两轮独立于默认 21 套。
- [便携版日志](../artifacts/portable-v0.11.log)记录真实解包、编辑器就绪和正常退出；不是安装或升级测试。
- [实际输出视觉检查](../artifacts/exports-v0.11-packaged-visual-review.json)记录本次 PNG、Poppler 渲染的一页 A4 PDF、大纲浅色界面和深色主题样本。标题、代码、公式和中文静态媒体引用可读；样本不代表所有主题、分页、DPI 或整体视觉超过 Typora。

| 发布文件 | SHA-256 |
| --- | --- |
| `TTypora Setup 0.11.0.exe` | `ac83ab4b4a66b2559fa6a18a6f623e0a84c0286997e3a96d64c5377c3bef5a14` |
| `TTypora Portable 0.11.0.exe` | `fd4c2e29be4811fed544fe97a6df9864048645e376c4ea58b9a83fb7d3809737` |

剩余范围包括更广泛长文输入、普通选区显式格式复制、PNG 宽度和超长分片、导出目标保护及其他平台。本轮检查还发现三类普通导出使用直接文件写入；原始文档保存的原子替换和转换导出的保护不等于所有导出目标均受保护。该路径的保护与原子新文件发布正在下一批隔离准备，尚未计入 0.11 程序。
