# 第三方源码与许可材料

对应 `sources.json` 锁定的 Windows x64 依赖集合，独立于 Ediro 应用版本。第三方代码保留原许可，本目录没有重新授权这些组件。

## 获取源码

应用的每个正式版本在其 GitHub Release 提供 `Ediro-<版本>-source.zip`。新的发布流程在 Release 正文及 `source-reference.json` 中给出共享第三方源码附件的固定 URL、完整 SHA256、大小及 sourceSetId。程序内“版本说明与源码”打开对应 Release；安装目录 `resources/licenses/SOURCE_CODE.md` 和 `source-reference.json` 保留同一指引。不要使用其他版本的应用源码替代当前版本。

同一依赖集可由多个应用版本引用，不要求重复下载第三方源码。共享 URL 不得指向 latest、私有页面或临时授权地址。大附件可以分卷提供；应下载 `source-reference.json` 列出的全部分卷至同一目录，用 7-Zip 打开第一卷。记录同时包含逐卷大小与 SHA256，以及按编号拼接后完整 ZIP 的大小与 SHA256。旧版本已发布的源码附件及其链接继续保留。

`sources.json` 记录精确版本、来源地址、SHA256 和大小。通常保留上游原始归档；有 `transform` 的条目明确标识派生处理及原始归档的大小、哈希，不能将派生包的校验值冒充上游原包校验值。`license-index.json` 将提取的许可原文对应到归档路径。附件包含 librsvg Cargo.lock 中的注册表源码，也保守收录部分构建、测试及其他平台的依赖，这不表示它们都进入了 Windows 二进制。

在应用源码根目录运行 `npm ci`，然后运行 `npm run sources:pack`，可下载、校验并打包；Chromium 派生步骤还需要 Python。默认归档缓存为 `.local/third-party-source-cache`；可用 `npm run sources:pack -- <已有归档目录>` 复用旧缓存。内容寻址 ZIP 及需要的分卷存在 `.local/source-sets/<sourceSetId>/`；命中时校验既有文件后复用。脚本不执行第三方源码，也不上传文件。源材料、锁定依赖、构建配置和实际原生输入参与标识，Ediro 自身版本号不参与。

各项已完成的核对及验证边界见 [证据总览](build-evidence/README.md)。正式发布仍要求应用源码 `config/source-review.json` 对实际 sourceSetId 的批准，以及固定公开附件的匿名下载/哈希验证；说明文档本身不授予或替代批准。未满足这些检查的本地候选包不得对外分发。

## Windows 图像处理库

实际版本和上游许可表见 `sharp-windows-native-versions.json`、`sharp-windows-native-README.md`。Windows 版本不能套用其他平台的清单。

包内 `libvips-42.dll` 与 build-win64-mxe v8.18.6 的 `vips-dev-x64-web-8.18.6-static.zip` 中 DLL 逐字节一致，SDK 和 DLL 校验值见 `sources.json`。原生组件源码校验值来自该版本的构建配方。Ediro 未修改这些原生组件。

对应构建材料：

- `build-win64-mxe-v8.18.6.tar.gz`：容器脚本、版本覆盖、Windows 配置与补丁。
- `mxe-d973945.tar.gz`：MXE 构建配方和工具链，完整提交 `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3`。
- `sharp-libvips-1.3.3.tar.gz`：`build/win.sh` 记录 Windows SDK 获取与打包。
- `sharp-0.35.4.tar.gz`：Node 接口、原生包装层和构建说明。

请在支持容器构建的 Linux 环境按 build-win64-mxe 归档中的 README、Dockerfile、build.sh 准备工具链；目标为 `x86_64-w64-mingw32.static`，组件集为 `vips-web`。版本和补丁以配方为准，librsvg 的 Rust 源码按 Cargo.lock 校验；附件包含这些 crate。构建可能仍需下载编译工具链和系统构建依赖。Ediro 未执行完整的原生库源码重编译，不承诺跨环境构建产物逐字节相同。

libvips 以外部 DLL 加载，位置为程序目录下 `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll`，其内部还有静态组成库。关闭 Ediro 后可替换接口兼容的自行修改版本，或按所附源码和配方重新组合这些库。本次已在隔离副本中实际加载接口兼容的修改 DLL，并比较多种图像操作；没有执行整套工具链和图像库的从零重编译。精确范围与结果见 `build-evidence/native-source-review.md` 和 `native-runtime-audit.json`。应用不对该 DLL 强制校验固定哈希或发布者签名；发布校验只针对维护者构建，不在用户运行时限制修改。升级会替换程序文件，请保留自己的修改。Ediro 不限制为调试这些库的修改而进行的逆向工程。许可全文见 `LGPL-3.0.txt`、`GPL-3.0.txt` 和各组件原始声明。

## Electron、Chromium 与 FFmpeg

Electron 44.4.1 对应 Chromium `152.0.7977.78`、Node `24.21.0` 及 FFmpeg 提交 `2b68d2babae73714846961fb0ee47e3b3d2e39a9`。材料包含完整 Electron 源码及补丁、Node 官方源码、NAN、精确 FFmpeg 源码，以及必要的 Windows 头文件和词典补充归档。官方 Electron Windows ZIP 与本地运行时文件、Node 官方源码校验值均已核对。

Chromium 使用 `chromium-152.0.7977.78-source-only.tar`。这是从已校验的官方完整归档派生的源码树：排除下载的 Linux 系统根、预编译工具链和按魔数确认的编译载荷，保留产品源码、构建配方、许可及普通资源。转换脚本 `scripts/prepare-chromium-source.py`、`build-evidence/chromium-source-filter.json` 和 `build-evidence/chromium-source-filter-report.json` 记录规则、原包来源/哈希、派生包哈希与 23 个必要源码/构建锚点检查。它不是官方原始归档的逐字节副本，也不宣称整个归档没有二进制数据；普通及嵌套测试资源可以保留，文件不会仅因 `.aar` 或 `.obj` 后缀被删除。

Electron release 配置把 Blink 静态组合到程序，同时把 FFmpeg 构建为独立 DLL。因此材料同时覆盖整个组合所需的 Windows/通用源码及补丁，不能只以一个 Blink 子树或可替换的 FFmpeg DLL 代表全部源码。实际随附的 780 项 Chromium 通知中，56 项 LGPL/MPL 命中和 6 项其他 copyleft 文字命中均有对应源码、许可选择或平台/未分发排除依据。通知是跨平台清单，不是 Windows 二进制组成的完整 SBOM。

精确范围、重建入口与限制见 [Electron 源码审查](build-evidence/electron-source-review.md) 和同目录的 `electron-license-coverage.json`、`electron-source-coverage.json`、`electron-runtime-origin.json`。逐组件版权及许可仍保留于随程序提供的 `LICENSES.chromium.html`。本次没有从零重编译整个 Electron/Chromium，也不保证无需另行取得系统 SDK、通用编译工具或可选优化数据即可完全离线构建。

## JavaScript 与 ONNX Runtime

`package-lock.json` 锁定版本、下载地址和完整性值；审查还核对了实际打包的 41 个 npm 安装实例及其原始发布包，并为编译后分发的 TypeScript/Flow 等代码补充精确上游源码和构建文件。两个 electron-builder 运行包的 46 份嵌入 source-map 源文本与归档源码一致。详细结果见 [JavaScript 源码审查](build-evidence/js-source-review.md)、`js-packaged-inventory.json`、`js-byte-verification.json` 和 `js-source-map-verification.json`。

lazy-val 1.0.5 的 MIT 依据是精确上游 package.json 和 npm 声明；它没有独立 LICENSE 文件。材料保留该事实、作者声明及单独标明来源的标准 MIT 参考文本，没有伪造上游版权年份或许可证文件。`@img/colour` 内嵌的四项颜色库源码和原始 MIT 通知也已补齐。

ONNX Runtime 1.30.0 的完整首选源码、JS/native bindings、构建配置，以及其 DirectX Shader Compiler 精确源码和通知均已归档。DirectML 1.15.4 是 Microsoft 的可再分发组件，保留其单独许可与 ThirdPartyNotices，不将其 DLL 误标为 MIT 或声称其实现源码公开。完整 NuGet 和原生二进制 npm 包只用于本地审计，不作为公开源码归档。实际版本、DLL 比较边界和许可依据见 [ONNX 材料审查](build-evidence/onnx-source-review.md) 及 `onnx-runtime-audit.json`。

程序内 `resources/licenses/inventory.json` 是许可收集清单，不替代源码审查或实际二进制组成分析；仅出现在锁文件中的可选包不自动算作已分发。

## 安装器

NSIS、StdUtils、nsis7z/LZMA SDK、UAC 与 elevate 的精确源码、构建文件和原始许可已整理，来源与二进制核对见 [安装器源码审查](build-evidence/installer-source-review.md) 及 `installer-byte-verification.json`。

该报告保留了旧基线 WinShell 的许可缺口；当前实现已用 Windows COM Shell 调用替换它，不把“Freeware”推断成开放源码或再分发许可。替代验证分别在 `installer-shell-runtime.json` 和 `installer-shell-payload.json`：前者检查隔离 AppUserModelID/临时快捷方式上的接口行为，后者解包检查安装器和内嵌卸载器均无 WinShell.dll。它们不声称已经对用户现有安装执行完整安装、升级、卸载或删除真实固定项。正式打包还会对最终生成的两个阶段强制执行无 WinShell 检查。
