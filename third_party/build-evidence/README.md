# 对应源码核对记录

本目录记录 Windows x64 分发的来源、实际文件、源码与许可材料核对，以及执行过的有限运行验证。正式批准以应用源码 `config/source-review.json` 对实际 sourceSetId 的绑定为准，不能从某个历史报告或其他集合沿用批准。公开附件还须通过匿名下载及完整性检查。

## 核对结果与证据入口

| 范围 | 核对内容与验证范围 | 精确报告 |
| --- | --- | --- |
| Windows 图像库 | 28 项版本/源码/配方、78 份许可、350 个锁定 Rust registry 归档、精确 SDK/DLL 来源和实际构建组件范围。 | `native-source-review.md`、`native-runtime-audit.json`、`native-additional-notices.json` |
| 图像库替换 | 在隔离副本中改变 DLL 版本字符串，由新进程确认加载修改库，比较多种图像操作的输出。未重编译整套原生工具链。 | `native-source-review.md` 的验证范围及 `native-runtime-audit.json` |
| Electron / Chromium / FFmpeg | 官方运行时文件身份、Node 官方源码校验、Chromium 原包完整遍历、20 个原包源码锚点、270 个 Git 依赖目录以及 62 项 copyleft 文字命中的源码/排除映射。已补 Windows 头文件、词典、NAN 和首选修改源码。 | `electron-source-review.md`、`electron-runtime-origin.json`、`electron-source-coverage.json`、`electron-license-coverage.json`、`electron-upstream/` |
| Chromium 公开派生包 | 固定策略排除下载的 Linux 系统根、预编译工具链及按魔数确认的编译载荷，保留产品源码、配方、许可与普通资源；记录原包和派生包哈希，并核对 23 个必要源码/构建锚点。 | `chromium-source-filter.json`、`chromium-source-filter-report.json`、应用源码 `scripts/prepare-chromium-source.py` |
| JavaScript | 实际包内 41 个 npm 安装实例与原始发布包的文件比对，精确首选源码和构建文件，46 份 source-map 源文本对应；补齐内嵌颜色库通知及 lazy-val 的真实许可声明依据。 | `js-source-review.md`、`js-packaged-inventory.json`、`js-byte-verification.json`、`js-source-map-verification.json` |
| ONNX / DirectML / DXC | 实际 Windows DLL 版本及哈希，完整 ONNX 与精确 DXC 源码，DirectML 的独立再分发许可及第三方通知。DirectML 的 NuGet 比较只证明 PE sections 一致，未误报整文件相同。 | `onnx-source-review.md`、`onnx-runtime-audit.json`、`onnx-*LICENSE*` 和 `onnx-*ThirdPartyNotices*` |
| NSIS 安装器组件 | 精确 NSIS/插件来源、源码、构建文件与许可；elevate 的源版本和声明。旧基线的 WinShell 缺口明确保留为历史证据。 | `installer-source-review.md`、`installer-byte-verification.json`、`installer-binary-origin.json` |
| WinShell 替代 | Windows COM Shell 替代实现的隔离接口验证；静态解包检查安装器及内嵌卸载器均不含 WinShell.dll。正式打包对最终两个阶段再次强制检查。 | `installer-shell-runtime.json`、`installer-shell-payload.json`；最终候选的 `installer-shell-audit.json` |

## 解释证据时的边界

Electron 44.4.1 的 DEPS 锁定 Chromium `152.0.7977.78` 和 Node `v24.21.0`；Chromium DEPS 锁定 FFmpeg `2b68d2babae73714846961fb0ee47e3b3d2e39a9`。Electron release 配置使用静态 Blink 和独立 FFmpeg DLL。相应材料包含 Windows/通用 Chromium 产品源码、外部运行时源码、Electron 补丁和构建入口；它们已经归档，不能再将其描述为只有 DEPS 下载链接。

公开的 `chromium-152.0.7977.78-source-only.tar` 是明确记录的派生源码包，不是官方原始 tar.xz 字节。`sources.json` 的 `transform` 保留原包大小、SHA256 和来源关系；过滤报告负责证明派生结果及 23 个锚点。原包完整性检查不能替代派生结果检查。过滤不依据后缀一概删文件，ICU 的 gzip 源码分片 `.aar`、Wavefront `.obj` 文本模型和普通/嵌套测试资源可以保留；不宣称整个派生包没有任何二进制数据。

Cairo 沿用上游 Windows 分发的 MPL 路径，保留原始 LGPL 2.1 / MPL 1.1 声明及升级依据；libimagequant 对应本构建的 2.4.1 fork 和原始 BSD 声明。不得套用其他平台或较新版本的许可，具体依据见原生审查报告。

lazy-val 的精确上游包和仓库没有独立 LICENSE 文件，MIT 指定由 package.json/npm 原始声明支持。`js-lazy-val-MIT-reference.txt` 是另标来源的标准参考文本，保留占位符，不冒充恢复出的上游许可证或版权年份。DirectML 的专有实现源码也没有被声称为已公开。

`installer-source-review.md` 中的 WinShell 段落描述旧基线，不代表替代后的当前安装器仍分发该 DLL。替代行为验证只使用临时快捷方式与隔离标识；payload 验证只解包两个阶段，不执行安装、升级或卸载。不能把这些结果扩大为对用户现有固定项、已有 Jump List 或完整安装生命周期的验证。

本次没有从零重编译全部 Electron、LLVM/MXE/Rust、图像库、ONNX 或安装器上游，也没有承诺逐字节重现所有发布二进制。来源哈希、源码/配方覆盖、源文本比对、接口兼容修改库加载和有限 Shell 验证分别记录，不互相冒充。通用编译工具、操作系统 SDK 和可选优化数据可能需要另行准备，不保证全工具链完全离线构建。

Chromium 通知、npm 锁文件和许可收集清单都不是最终 Windows 二进制组成的完整 SBOM。保守归档的测试/其他平台材料不等于实际链接组成；仅安装但未打包的可选依赖也不计为已分发。最终放行仍须核对当前配置中的集合绑定、最终候选实际载荷和公开源码可取得性。
