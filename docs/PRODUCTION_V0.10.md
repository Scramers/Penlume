# 0.10.0 大纲定位与图片输入预览

状态：本批 Windows 发布验收完成。完整构建、52 个文件的 1,076 项单元测试、二十套发布程序桌面流程一次顺序运行、源码与发布程序各自独立的四组图片文件控件专项、便携版实际启动和正常退出通过。最新下载为 `release-v0.10.0/`；[冻结记录](../artifacts/source-v0.10-build.json)保留源码与程序指纹、成功及失败记录。完整 Typora 对齐与超越目标仍未完成。

## 发布产物

| 程序 | 字节数 | SHA-256 |
|---|---:|---|
| `release-v0.10.0/TTypora Setup 0.10.0.exe` | 175878938 | `c902e3e2f5dddb151b7e036fadfb5e94951239e5374a8ba3f542b5af30e39cd4` |
| `release-v0.10.0/TTypora Portable 0.10.0.exe` | 175665962 | `2e555872353d96d0ea0512a21b134f09de9df53aa2b421a95483c67ceacd2602` |

[包内核对](../artifacts/release-v0.10-verification.json)确认 222 个编译文件与冻结构建逐文件一致，Pandoc 及五项许可证资源正确。三个 Windows 程序的[真实签名检查](../artifacts/signatures-v0.10.json)均为 `NotSigned`。便携版实际完成解压、编辑器就绪和正常退出；未验证系统安装、文件关联或升级。

## 当前实现

大纲采用与可视化编辑器一致的 Markdown 解析规则，支持重复标题、空标题、引用和列表中的标题、多行 Setext 标题及富文本标签；代码、公式和原始 HTML 内的标题文本不会误入大纲。当前标题高亮跟随可视化、源码、分屏和内嵌编辑控件的位置。限制显示级别时，隐藏标题只投影到它的真实祖先标题。

解析在独立 Worker 中执行，输入后合并更新。等待新结果时，旧列表暂时禁用并清除高亮；文档、原文、设置和请求版本都必须匹配才能启用跳转。标签切换取消旧 Worker，返回相同标签使用新的请求版本。导航、语言切换和模式切换不添加文档撤销步骤。原生列表控件的延迟挂载选区恢复改为保留当前选区，避免覆盖刚恢复的文档位置。

未确认的图片路径输入使用现有文档资源解析器。块图片和行内图片的缩略图只接收解析结果，支持文档目录及已支持的 `typora-root-url`；被拒绝或缺失的本地引用不会直接写入浏览器图片地址。确认才写入原始 Markdown 引用。输入控制器保留原生输入撤销和选区，语言变化只更新标签；确认后的原生图片说明、缩放和文档事务继续使用原控件。

自有文件选择控件实际复制图片到文档资源目录，未保存文档先执行另存为。连续选择图片时只有当前结果写入文档。已在脱离 DOM 时解码的图片重新显示时，原控件重新初始化尺寸，保留实际缩放与共享撤销。

## 已有证据

- [最新构建及类型检查](../artifacts/build-v0.10-image-input-status.log)、[1,076 项单元测试](../artifacts/unit-v0.10-image-input-status.log)。
- [五套源码桌面回归](../artifacts/desktop-v0.10-source-image-input-integration.json)。
- [二十套发布程序桌面回归](../artifacts/desktop-v0.10-packaged-native-ui.json)：一次连续顺序执行全部通过，累计约 27 分钟；包括大纲十组和图片输入八组。之前的失败尝试保留在下述记录中。
- [大纲十组真实桌面交互](../artifacts/outline-v0.10-source-outline-native-history-verification.json)：包括实际 Worker、源码位置、重复及空标题、内嵌控件、筛选、语言及模式切换、待解析状态、真实旧结果的受控延迟交付和共享撤销。没有注入编辑器事务或选区。
- [图片输入八组交互](../artifacts/image-input-preview-v0.10-source-image-input-native-history-verification.json)：确认前授权预览、越界和缺失路径拒绝、原生输入历史、语言选区保持、真实 Enter、连续确认、资源根变化和销毁。原 IPC 处理器与观察器恢复、进程退出和精确临时目录清理在成功报告之前核验。
- 前两次图片专项失败记录保留：[行内占位提示遮挡直接输入框点击](../artifacts/image-input-preview-v0.10-source-image-input-preview-failure.json)、[逐字输入的实际撤销边界](../artifacts/image-input-preview-v0.10-source-image-input-hint-failure.json)。后续操作点击实际可见提示来聚焦；历史测试用两次有真实输入事件的原生整值插入，不声称逐字输入按整值撤销。
- [源码 PNG/PDF 的实际视觉检查](../artifacts/exports-v0.10-source-visual-review.json)仅覆盖记录中的单页样本，图片及封面为两像素夹具。
- 图片文件控件独立四组：[源码](../artifacts/image-input-extra-v0.10-source-image-input-extra-verification.json)、[发布程序](../artifacts/image-input-extra-v0.10-packaged-image-input-extra-verification.json)。真实文件复制、首次保存及完整 PM/源码/文件撤销重做、复制后迟到 A 不改变 B、真实图片脱离 DOM 解码及重挂载后的尺寸/缩放均通过。报告在恢复处理器和对话框函数身份、移除观察器、进程退出及精确临时目录清理后写入。这两轮作为补充专项，未计入默认二十套或声称二十一套连续运行。首次保存用受控目标路径，未验证系统选择对话框界面。
- [便携版实际启动日志](../artifacts/portable-v0.10.log)与[发布程序 PNG/PDF 实际视觉检查](../artifacts/exports-v0.10-packaged-visual-review.json)。单页样本的中文引用、标题、加粗、代码和公式可读，未发现重叠或裁切；两像素图片夹具不能代表普通图片布局或所有分页。
- [首轮发布程序桌面记录](../artifacts/desktop-v0.10-packaged.json)：基础流程通过，功能回归在完成编辑和模式往返后截图超时，导出与其后步骤未计为通过。原[失败日志](../artifacts/parity-v0.10-packaged.log)保留；后续测试明确显示并聚焦窗口、禁用后台节流并禁用截图动画，未据此修改产品代码或断言已经确定超时原因。
- [聚焦窗口后的功能复测](../artifacts/desktop-v0.10-packaged-foreground-parity.json)完成截图及 HTML/PDF/PNG 导出，随后启动恢复超时。旧测试直接改写设置存储，但编辑器就绪时应用会再次保存当前设置；改用偏好设置中的实际“启动时恢复”开关后，[独立完整功能回归](../artifacts/desktop-v0.10-packaged-native-preferences-parity.json)通过。此处修订测试操作，未修改发布程序；随后启动全二十套顺序验收。

## 百万字符文档复测

[0.9.0 源码记录](../artifacts/performance-v0.9-source-outline-baseline.json)与[0.10.0 源码记录](../artifacts/performance-v0.10-source-outline-image-input.json)使用同一 SHA-256 为 `9e6d0bad20ee04f69e2bf52c89660025dcaa1135f1af205e9f2011a182a12874` 的百万 UTF-16 字符文档：130 个标题、129 张表格和 129 个代码块。每种模式各十次真实 ASCII 键盘输入，完整保存并核对切换后的全文模型。

| 输入到观察到模型变化 | 0.9.0 中位数 | 0.10.0 中位数 |
|---|---:|---:|
| 可视化 | 369.25 ms | 336 ms |
| 源码 | 5.6 ms | 5.1 ms |

两轮范围有重叠；该记录不是绘制完成、内部事务耗时或统计显著性结论，也没有测量 Typora。打开和转换仍约需数秒，不能据此声称整体性能超越。

[冻结版本 CPU 诊断](../artifacts/performance-profile-v0.10-source-frozen-cpu-diagnostic.json)实际保存了两种模式各十次输入区间的 Chromium CPU profile，并核对全文保存及模型切换。采样只归属当前 renderer 主 JavaScript 线程，包含轮询和等待；Worker 不在该采样归属。Profiler 会影响时延，该诊断不能直接与上述无采样记录比较或代替后续优化后的干净复测。

## 待完成及边界

本批所列发布验收已完成。大纲折叠、平铺和标题文字筛选、模板资源根、可配置图片存储、完整数学选项、更多原生输入法、外部应用互操作、其他操作系统及正式安装升级仍在对齐矩阵中保留。百万字符可视化输入仍有延迟，后续性能改进需保留同步保存、共享历史和原文回退语义。

图片异步测试控制的是实际成功结果的交付时间；不等于操作系统自然乱序。原生图片内部的 Promise/Vue 调度仍不能据此证明任何已经授权但后来过期的请求均被取消。确认前自有缩略图在直接地址赋值处验证当前请求及生命周期。本批未改变网络策略或文件授权。
