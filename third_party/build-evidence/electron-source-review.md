# Electron 44.4.1 Windows x64 对应源码核对

本记录针对本次 Ediro 使用的 Electron 44.4.1 Windows x64 运行时。它核对来源、源码、许可、修改与构建入口，不声称已经从零重编译 Chromium/Electron，也不声称已生成逐字节相同的原生二进制。最终公开附件的校验与审批仍须绑定实际 sourceSetId。

## 实际运行时与版本

`electron-runtime-origin.json` 记录官方 Electron ZIP 的 SHA256、大小与 16 个根级运行时、资源和许可文件的逐字节比对。官方 ZIP 的 SHA256 为 `34bc07977d6c43b6514b956a5f2e3292255daa3838a49e6110f3fe19ffafb83f`，与官方 `SHASUMS256.txt` 一致；被核对的本地文件全部一致。这是来源与文件身份验证，不是本地重编译结果。

完整 Electron 源码归档 `electron-44.4.1.tar.gz` 中的 DEPS 锁定 Chromium `152.0.7977.78`、Node `v24.21.0`、NAN `675cefebca42410733da8a454c8d9391fcebfbc2`。Chromium DEPS 锁定 FFmpeg `2b68d2babae73714846961fb0ee47e3b3d2e39a9`。这些 DEPS、构建参数、补丁配置及上游构建说明的原文副本在 `electron-upstream/`；副本的来源和哈希在该目录 `index.json`。

Node 官方源码 `node-v24.21.0.tar.xz` 为 57,357,488 字节，SHA256 为 `a6f54defb6fd7c84f41dba13d61e78e9b4e0961712cf61f29715c05f5ced94fc`，已与 Node 官方版本目录的 `SHASUMS256.txt` 比对。

## Chromium 原包与公开派生包的边界

本地审计输入是 [Chromium 官方 152.0.7977.78 源码包](https://commondatastorage.googleapis.com/chromium-browser-official/chromium-152.0.7977.78.tar.xz)，完整下载大小 5,916,191,748 字节，SHA256 为 `16bb4164faa455d1e6a43320b3c0e4c895a93138e892a1bbf7e801863dc4bc74`，MD5 为 `05ca2357a502e917ea82b9db18b65f36`，与官方存储响应的长度及 MD5 一致。原包经过 Python `tarfile`/`lzma` 流式遍历并读取到 XZ 尾部，共 1,306,305 个成员，没有空文件名。Windows 自带 tar 的文件名解码失败没有被当成校验通过。

原包还夹带其他平台的预编译系统根与构建工具，因此公开材料使用明确标识的派生包 `chromium-152.0.7977.78-source-only.tar`。它不冒充官方原始归档。转换脚本为 `scripts/prepare-chromium-source.py`，过滤依据与输出完整性分别记录于 `chromium-source-filter.json` 和 `chromium-source-filter-report.json`。最终发布必须同时验证派生包的哈希、过滤记录和下面的必要源码锚点；原包审计通过不能自动代替派生包验证。

`electron-source-coverage.json` 对原包的 20 个必要源码/构建锚点及 270 个顶层 Git 依赖目录作实际成员核对。V8、Skia、ANGLE、WebRTC、BoringSSL、Dawn、FFmpeg、ICU、SwiftShader、Eigen、Hunspell、NSPR、Mozilla 代码、ISimpleDOM 和 Blink 均包含实际源码，不仅是 DEPS 链接。所有 20 个原包锚点存在。原包缺少的 122 个 Git 路径逐项记录于 `missingPathReview`：85 项为 Google Chrome 私有组件/品牌/测试资料，28 项受其他平台条件控制，4 项为非发布测试语料，1 项 OpenXR 被 Electron DEPS 关闭，1 项是通用 Perl 构建解释器，3 项已补充精确源码归档。不能将这些排除结果外推到其他平台或 Chrome 产品。

需要补充的 Windows/数据路径包括：

- `src/third_party/microsoft_dxheaders/src`：`62c23d5ec700659453c6fe89d296554b2a5e7edc`。
- `src/third_party/microsoft_webauthn/src`：`ef82c157125a0490e05f6ea82a7adb1b8e1bad08`。
- `src/third_party/hunspell_dictionaries`：`cccf64a8acc951afe3f47fee023908e55699bc58`。

这些补充包保留源码、许可和构建材料。NAN、Node、完整 Electron 以及 Electron 补丁也必须与 Chromium 派生包一起提供。额外的 Blink、Mozilla、Symphonia、gRPC、Dawn、DXC、Eigen 等子树包方便核对并保留首选修改形式；不能把这些子树单独当成整个静态组合的全部源码。

## 许可逐项映射

实际随附 `LICENSES.chromium.html` 有 780 个产品通知。它包含跨平台内容，不能直接称为 Windows 二进制 SBOM。`electron-license-coverage.json` 按每个通知块的 SHA256 固定审查对象：56 项 LGPL/MPL 文字命中，加上 6 项其他 copyleft 文字命中，共 62 项，每项都有源码归档、许可选择或明确的平台/未分发排除理由，没有未分类项。

其中 24 项保守提供对应源码，1 项 JSZip 选择其上游明确允许的 MIT 分支并保留双许可原文，1 项 liblouis 作为其他平台的额外源码保留，35 项为不进入 Windows 目标的平台组件，1 项为未随 Electron 分发的 ScreenAI。额外纳入的源码并不表示这些组件都参与 Windows 链接。

MPL 覆盖文件保留实际 vendored 修改形式、版权与许可，包含 Eigen、AXE-CORE、Mozilla/NSPR、Symphonia 等。AXE-CORE 另外归档 Chromium README 指定的上游提交 `281653df3794f429b71327fe3afa37ca0fadb1c7`，补足压缩 JavaScript 所不能替代的首选修改形式。字典和连字模式保留源数据、转换脚本及逐项许可，不将混合许可集合统一改写成宽松许可。

ICU、Node 和 DXC 的通知中包含 Autoconf 或其他 GPL 例外文字；这些文字命中不被解释为整个运行时改用 GPL。原始许可与例外仍完整保留。ScreenAI 的精确 Chromium README 说明它是 Chrome Component Updater 下载的组件，BUILD.gn 为 `testonly`；官方 Electron Windows 运行时没有该库或模型，因而没有把其私有源码地址冒充已经归档的材料。

依据包括 [LGPL 2.1 第 6 节](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) 和 [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) 关于执行形式、Covered Software 源码及首选修改形式的说明。许可全文优先以对应源文件声明和随附原文为准。

## 静态 Blink 与动态 FFmpeg

Electron 的 `build/args/release.gn` 设置 `is_component_build = false`。因此 Blink/WebKit LGPL 代码进入 Electron 的静态组合，仅提供 Blink 子树或一个上游下载链接不足以覆盖这个组合。此次选择 LGPL 2.1 第 6(a) 节的源码/重新链接材料路径：保留完整的 Windows/通用 Chromium 产品源码和外部运行时源码，配套 Electron、Node、NAN、所需头文件、源数据、构建脚本与 Electron 的全部补丁。

同一文件设置 `is_component_ffmpeg = true`。FFmpeg 是外部 `ffmpeg.dll`；锁定归档保留 `chromium/config/Chrome/win/x64/` 配置及脚本，Electron 的 `patches/ffmpeg/.patches` 指定 `link_with_loader_path.patch`。该配置的 `CONFIG_GPL`、`CONFIG_NONFREE`、`CONFIG_VERSION3`、`CONFIG_GPLV3` 均为 0；这只是所选源码配置的核对，不声称重新测定了每个编译器输入。

Ediro 未修改官方 Electron/FFmpeg 二进制，不增加对用户自行重建 Electron 或替换接口兼容 FFmpeg DLL 的发布者签名/固定哈希运行时限制。修改库后应在独立副本验证兼容性，并保留修改，升级会覆盖程序文件。Ediro 不限制为了调试这些库的修改而进行的逆向工程。

## 组装与重建入口

1. 将 Chromium 派生包的根目录作为工作区 `src/`；原始目录结构、Windows/通用源码、许可与构建规则应保持不变。
2. 将完整 Electron 源码放到 `src/electron/`，Node 放到 `src/third_party/electron_node/`，NAN 放到 `src/third_party/nan/`。按每份补充归档记录的 `destination` 补齐缺失路径。GitHub/Node 归档有最外层目录，Gitiles 子树归档通常没有；不能盲目统一剥掉一层。
3. 使用 Electron `patches/config.json` 和各目录 `.patches` 的顺序应用补丁。包括 Chromium、BoringSSL、V8、Node、FFmpeg、Skia、ANGLE、WebRTC、SQLite、PDFium、libyuv 等实际配置条目。上游 `script/apply_all_patches.py` / `git-import-patches` 需要可工作的 Git 仓库；从源码归档组装时应先为各被补丁目标初始化本地基线，或按同一序列应用补丁，不能跳过补丁直接拿通用 Chromium/FFmpeg 发行版替代。
4. 依照随附 `docs/development/build-instructions-windows.md` 和 `build-instructions-gn.md` 准备 Visual Studio/Windows SDK、Python、Node、Git、GN、Ninja/Siso 与必要的通用构建工具。Windows 设置 `DEPOT_TOOLS_WIN_TOOLCHAIN=0` 使用本机合法安装的工具链。公开源码附件不承诺包含所有操作系统或编译工具的安装程序。
5. 按上游 GN 流程生成 Windows x64 的 Electron target，导入 `//electron/build/args/release.gn`，再构建 `electron` 或 `electron:electron_dist_zip`。本地重新链接可以关闭远程执行，并使用无 PGO 的重建配置（例如 `chrome_pgo_phase=0`、清空 `v8_builtins_profiling_log_file`）；这改变优化配置而不是源码覆盖，不等同于复现官方发布字节。若要匹配官方 PGO 配置，须运行归档内的 profile 下载脚本按其状态文件获取数据。

以上是源码组装与上游构建入口说明，不是已经执行成功的原生重构建日志。本次实际完成的是官方来源/哈希验证、原包完整 TAR/XZ 遍历、源码存在性与锁定版本核对、许可逐项映射和补档。派生包过滤完整性由其单独报告证明。最终附件上传后还必须完成匿名公开下载及哈希验证，才可作为可取得的对应源码登记。
