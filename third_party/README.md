# 第三方源码与许可材料

对应 Ediro v0.1.0 Windows x64。第三方代码保留原许可，本目录没有重新授权这些组件。

## 获取源码

在 [v0.1.0 发布页](https://github.com/SimonFlipig/Ediro/releases/tag/v0.1.0) 获取 `Ediro-0.1.0-source.zip`（应用源码、默认提示词和构建脚本）与 `Ediro-0.1.0-third-party-sources.zip`（第三方源码、原生构建配方和许可）。

`sources.json` 记录精确版本、原始下载地址、SHA-256、大小。源码附件保留原始归档；`license-index.json` 将提取的许可原文对应到归档路径。包含 librsvg Cargo.lock 中的注册表源码，也可能包含仅用于构建、测试或其他平台的依赖，这不代表它们都进入了二进制。

在应用源码根目录运行 `npm ci`，然后运行 `node scripts/package-third-party-sources.mjs`，可重新下载、校验并打包。默认缓存在 `.local/third-party-source-cache`；可将已有归档目录作为唯一位置参数传入。脚本不执行第三方源码，也不上传文件。

## Windows 图像处理库

实际版本和上游许可表见 `sharp-windows-native-versions.json`、`sharp-windows-native-README.md`。Windows 版本不能套用其他平台的清单。

包内 `libvips-42.dll` 与 build-win64-mxe v8.18.6 的 `vips-dev-x64-web-8.18.6-static.zip` 中 DLL 逐字节一致，SDK 和 DLL 校验值见 `sources.json`。原生组件源码校验值来自该版本的构建配方。Ediro 未修改这些原生组件。

对应构建材料：

- `build-win64-mxe-v8.18.6.tar.gz`：容器脚本、版本覆盖、Windows 配置与补丁。
- `mxe-d973945.tar.gz`：MXE 构建配方和工具链，完整提交 `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3`。
- `sharp-libvips-1.3.3.tar.gz`：`build/win.sh` 记录 Windows SDK 获取与打包。
- `sharp-0.35.4.tar.gz`：Node 接口、原生包装层和构建说明。

请在支持容器构建的 Linux 环境按 build-win64-mxe 归档中的 README、Dockerfile、build.sh 准备工具链；目标为 `x86_64-w64-mingw32.static`，组件集为 `vips-web`。版本和补丁以配方为准，librsvg 的 Rust 源码按 Cargo.lock 校验；附件包含这些 crate。构建可能仍需下载编译工具链和系统构建依赖。Ediro 未执行完整的原生库源码重编译，不承诺跨环境构建产物逐字节相同。

LGPL 库以外部 DLL 加载，位置为程序目录下 `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll`。关闭 Ediro 后可替换为接口兼容的自行修改版本，或从公开源码重新构建应用。应用不对该 DLL 强制校验固定哈希或发布者签名；升级会替换程序文件，请保留自己的修改。Ediro 不限制为调试这些库的修改而进行的逆向工程。许可全文见 `LGPL-3.0.txt`、`GPL-3.0.txt` 和各组件原始声明。

## Electron 和 JavaScript

Electron 44.4.1 源码归档包含 `DEPS`、构建脚本和补丁。Chromium、Node.js 等大型源码树没有完整复制到附件，其精确依赖由该版本 DEPS 和上游检出流程锁定。按 [官方源码构建说明](https://github.com/electron/electron/blob/v44.4.1/docs/development/build-instructions-gn.md) 检出 v44.4.1 并同步依赖。逐组件版权和许可完整保留于程序随附的 `LICENSES.chromium.html`，也复制到 `resources/licenses`。

JavaScript 依赖由 `package-lock.json` 锁定版本、下载地址和完整性值，可通过 `npm ci` 获取。程序包 `resources/licenses/inventory.json` 列出本次收集的依赖许可，同目录保留原文。
