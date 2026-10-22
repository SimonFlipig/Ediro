# 第三方许可说明

Ediro 的项目许可为 GPL-3.0-only。第三方组件保留原有版权及许可条款，不因随 Ediro 发布而被统一重新授权。

本说明依据当前 `package-lock.json`、已安装依赖的许可证及 Windows 二进制包说明整理。许可原文和源码获取材料随发布包提供，本摘要不替代各组件的完整条款。

## 主要组件

| 组件 | 当前锁定版本 | 许可 |
| --- | --- | --- |
| Electron | 44.4.1 | MIT；内含 Chromium 等组件各自的许可 |
| React / React DOM | 19.3.0 | MIT |
| sharp | 0.35.4 | Apache-2.0 |
| sharp Windows x64 二进制包 | 0.35.4 | Apache-2.0 AND LGPL-3.0-or-later；另含其他依赖许可 |
| Zod | 4.6.5 | MIT |
| electron-updater | 6.8.9 | MIT |
| ONNX Runtime Node / common | 1.30.0 | MIT；原生分发附带组件保留各自条款，见包内 ThirdPartyNotices.txt |
| DirectML | 1.15.4 | Microsoft DirectML 独立再分发许可及其第三方通知；不是 MIT 或公开实现源码 |

运行依赖还包括 scheduler（MIT）、@img/colour（MIT）、detect-libc（Apache-2.0）和 semver（ISC）。可选依赖及其他平台包以锁文件和最终实际包含的文件为准。

## 发布包必须保留的材料

- Ediro 的 `LICENSE`、本说明以及对应版本源码的获取说明。
- Electron 分发目录中的 `LICENSE` 和 `LICENSES.chromium.html`，保留原文及版权声明，不能与 Ediro 根目录 LICENSE 混淆或互相覆盖。
- 前端打包使用的 React、React DOM、scheduler 等组件的许可文本，以及保留在运行依赖目录中的第三方版权和许可证。
- sharp 与所选平台二进制包的 `LICENSE`、`README.md` 中的第三方许可清单及 `versions.json` 版本记录。
- ONNX Runtime 的 `LICENSE`、`ThirdPartyNotices.txt`，以及可选本地图像模型的上游和转换来源声明。模型固定版本与文件校验值记录在 `src/adapters/local-image-models.ts`，模型资源独立下载，不包含在应用安装包中。
- ONNX 原生分发中 DirectML、DirectX Shader Compiler 等组件各自的许可和第三方通知，不能统一写成 ONNX 的 MIT 许可。
- NSIS、实际使用的插件及 elevate 的原始许可和构建材料；当前安装器以 Windows COM Shell 实现替换 WinShell，不分发该旧基线 DLL。
- 随最终二进制发布的 LGPL 等组件所要求的对应源码及相关材料；须按实际组件和版本落实获取方式，不能仅用本表或上游首页代替。

## 随版本提供的材料

安装版与便携版的 `resources/licenses` 包含依赖许可文本、Electron/Chromium 声明、sharp 平台包说明和版本清单，`inventory.json` 记录收集结果。其 `third_party` 子目录保留源码索引、GPL/LGPL 全文、提取的原始版权与许可声明及构建说明。

每个 [GitHub Release](https://github.com/SimonFlipig/Ediro/releases) 提供该应用版本的源码 ZIP。Release 正文和 `source-reference.json` 引用固定的第三方源码附件，多个应用版本可共享同一份；包内 `resources/licenses/SOURCE_CODE.md` 提供对应指引。大附件分卷时须取得全部分卷，逐卷及合并后的完整大小、SHA256 均有记录。旧 Release 的既有源码附件保持可用。

第三方材料包含 Windows 图像库源码、配方、补丁及 Rust 锁定依赖，完整 Electron 与 Node 源码、FFmpeg 和必要补充组件，JavaScript 的精确首选源码和构建文件，ONNX/DXC 源码，以及实际安装器组件的源码与通知。Chromium 的 `chromium-152.0.7977.78-source-only.tar` 是从固定官方包生成的派生源码树，排除下载的 Linux 系统根和预编译工具链等载荷，保留产品源码、配方、许可与普通资源；来源、原包哈希、转换策略、派生包哈希和 23 个必要锚点检查均有独立记录。它不冒充上游原始归档，也不声称普通及嵌套测试资源中不存在二进制数据。

每份归档的精确来源与校验值见 `third_party/sources.json`，实际核对结果及验证范围见 [证据总览](third_party/build-evidence/README.md) 和 [源码与构建说明](third_party/README.md)。lazy-val 的 MIT 指定保留其原始声明依据，不伪造缺失的独立许可证；DirectML 保留其专有再分发条款，不宣称其实现源码公开。旧安装器 WinShell 的历史缺口由替代实现及两个阶段的无 WinShell 载荷检查闭合，相关证据单独保存。

本次未从零重编译全部上游项目，不保证逐字节复现原生发布文件或无需另行准备 SDK/通用工具即可完全离线构建。正式批准由 `config/source-review.json` 绑定实际 sourceSetId；最终发布还须验证固定公开源码附件的匿名下载与哈希，以及最终安装器实际载荷。本说明不替代这些检查。

对 LGPL 组件的修改和调试权利不受 Ediro 限制；接口兼容的图像处理 DLL 可由用户替换，路径和注意事项见上述说明。不同组件的许可不能仅从 npm 元数据推断，实际条款以随附原文及原始源码为准。
