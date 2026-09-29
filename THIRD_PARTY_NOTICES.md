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

运行依赖还包括 scheduler（MIT）、@img/colour（MIT）、detect-libc（Apache-2.0）和 semver（ISC）。可选依赖及其他平台包以锁文件和最终实际包含的文件为准。

## 发布包必须保留的材料

- Ediro 的 `LICENSE`、本说明以及对应版本源码的获取说明。
- Electron 分发目录中的 `LICENSE` 和 `LICENSES.chromium.html`，保留原文及版权声明，不能与 Ediro 根目录 LICENSE 混淆或互相覆盖。
- 前端打包使用的 React、React DOM、scheduler 等组件的许可文本，以及保留在运行依赖目录中的第三方版权和许可证。
- sharp 与所选平台二进制包的 `LICENSE`、`README.md` 中的第三方许可清单及 `versions.json` 版本记录。
- 随最终二进制发布的 LGPL 等组件所要求的对应源码及相关材料；须按实际组件和版本落实获取方式，不能仅用本表或上游首页代替。

## 随版本提供的材料

安装版与便携版的 `resources/licenses` 包含依赖许可文本、Electron/Chromium 声明、sharp 平台包说明和版本清单，`inventory.json` 记录收集结果。其 `third_party` 子目录保留源码索引、GPL/LGPL 全文、提取的原始版权与许可声明及构建说明。

同一 [GitHub Release](https://github.com/SimonFlipig/Ediro/releases/tag/v0.1.0) 提供 Ediro 源码 ZIP 和独立的第三方源码 ZIP。后者包含 Windows 图像库的原始源码、构建配方、补丁和 Rust 锁文件依赖；每份归档的来源和 SHA-256 见 `third_party/sources.json`。Electron 的大型依赖源码通过固定版本 DEPS 与上游检出流程获取，详见 [源码与构建说明](third_party/README.md)。

对 LGPL 组件的修改和调试权利不受 Ediro 限制；接口兼容的图像处理 DLL 可由用户替换，路径和注意事项见上述说明。不同组件的许可不能仅从 npm 元数据推断，实际条款以随附原文及原始源码为准。
