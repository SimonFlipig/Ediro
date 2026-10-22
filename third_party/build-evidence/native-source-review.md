# Windows 图像库源码与可替换性审查

审查日期：2026-10-22。范围：Windows x64 的 sharp 0.35.4、libvips 8.18.6 及其实际静态组成库。机器可重复的结果见 `native-runtime-audit.json`；对应执行脚本为应用源码中的 `scripts/audit-native-sources.mjs`。

## 结论与边界

本次完成了精确二进制对应、图像库源码与构建配方闭包、许可选择、接口兼容修改库替换验证。`native-image-sources` 和 `native-relinking` 可据本记录及 JSON 证据按实际审查范围通过。

本次没有从零编译整套 LLVM/MXE/Rust/libvips，也没有声明可重复构建得到相同二进制。原记录把“完整源码重编译”与“可修改、重新组合并运行的权利和材料”混为同一放行条件；本次使用后者作为审查标准，并保留前者未执行的事实。实际运行证明仅限所列接口兼容修改及图像操作，不证明任何任意修改均可运行。

## 二进制、源码和静态组成范围

- 安装的 `@img/sharp-win32-x64/versions.json` 与审定的 `sharp-windows-native-versions.json` 全部 28 项一致。
- `libvips-42.dll` 的 SHA256 为 `e6cc51bbc763e7deda536c6f56ce96b4c51ea769690ce4f4ed07607527b81dae`，匹配上游 `vips-dev-x64-web-8.18.6-static.zip` 内 DLL。SDK 自身的固定下载地址、SHA256 保留在 `sources.json`。
- 28 项逐项对应 `sources.json` 的精确源码归档、SHA256、大小、构建配方；78 份提取的许可原文与 `license-index.json` 哈希一致。逐项结果及文件名在 `native-runtime-audit.json`。
- `sharp-0.35.4.tar.gz`、`sharp-libvips-1.3.3.tar.gz`、`build-win64-mxe-v8.18.6.tar.gz`、MXE 提交 `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3` 的归档均逐字节核验。前两项保留 Node/C++ 包装层、Windows SDK 取用和打包流程；后两项保留所有组件配方、版本覆盖、补丁、构建参数和工具链引导脚本。
- 对 `librsvg-2.62.91/Cargo.lock` 逐项解析：350 个 registry 包全部有本地 `.crate`，其 checksum 与清单、实际归档 SHA256 和大小一致。这包括条件平台和测试依赖的保守超集；不把这 350 项全部声称为实际链接对象。

这里的 `static` 指组成依赖被组合到 libvips DLL。`build/vips.mk` 明确以 `--default-library=shared` 生成外部 `libvips-42.dll`。因此不能只按“DLL 外置”忽略其内部源码，本次同时审阅了以下配方约束：

| 范围 | 精确构建材料中的控制点 |
| --- | --- |
| 目标组件 | `build/plugins/web-deps/vips-web.mk` 与 `overrides.mk`：默认 `vips-web`，不是 `vips-all`；关闭 PDF、RAW、Magick、FFTW、OpenEXR、OpenSlide、JPEG-XL 等未分发组件。 |
| 图片编码 | `build/vips.mk`、`build/libheif.mk`：WebP、TIFF、lcms、exif、heif/aom、imagequant、highway、cgif、ultrahdr 等均在 28 项归档内；默认禁用 x265/libde265 的 HEVC 支持。 |
| JPEG、压缩、翻译 | `build.sh` 默认启用 mozjpeg、zlib-ng、proxy-libintl 插件；插件替换 libjpeg-turbo、zlib、gettext 依赖。实际版本表与该选择相符，不使用另一个平台的依赖表。 |
| GLib | `build/overrides.mk` 把依赖缩为 libffi、zlib 和后续被 proxy-libintl 替换的 gettext；`build/patches/glib-2-without-gregex.patch` 删除 GRegex/PCRE2 构建引用。dbus、libiconv、PCRE2 没有被保留为此构建的必需对象。 |
| GVDB | GLib 2.89.4 发布归档已包含 `subprojects/gvdb` 的源文件、Meson 构建和 LGPL-2.1-or-later 文本；不依赖单独的 GVDB 下载链接来提供这部分源码。 |
| SVG/文字 | librsvg 的原生依赖为 Cairo、GLib、Pango、libxml2；Rust 依赖由上述 Cargo.lock 归档覆盖。Pango/fontconfig/freetype/harfbuzz/fribidi/pixman 均在 28 项内。`overrides.mk` 去掉旧 MXE 的 gdk-pixbuf/libcroco/libgsf、Cairo 的 lzo、FreeType 的 brotli/bzip2。 |
| archive/xml | `overrides.mk` 将 libarchive 缩为 zlib、将 libxml2 缩为编译工具和 Meson；不用旧 MXE 默认引入的 bzip2/libiconv/nettle/OpenSSL/xz 范围冒充实际组成。 |
| 系统/编译运行库 | PE 导入表记录在 JSON；libvips DLL 的外部导入为 Windows/UCRT 系统接口；C++ DLL 另导入 libvips，sharp.node 另导入两个 libvips DLL。标准工具链按已锁定 MXE 配方定位 LLVM 22.1.7、MinGW b536c4f 和 2026-06-05 Rust nightly，附加原文见 `native-additional-notices.json`。 |

原始归档也包含项目自身内嵌的第三方文件和许可证，未从归档中删减。工具链、构建用程序及系统库与实际图像库本身分别记录，不用源文件列表推测每个可选代码分支都进入了二进制。

## Cairo 和 libimagequant 的明确许可选择

### Cairo 1.18.4

归档的 `COPYING` 与 `src/cairo.c` 保留 LGPL 2.1 / MPL 1.1 双许可原文；`src/cairo.c` 明确允许未改变该声明的接收者选择任一许可。上游 Windows 构建 README 明确按 MPL 2.0 使用 Cairo。

本分发沿用 MPL 路径。MPL 1.1 §6.2 允许采用后续版本，Cairo 原文同时提供 LGPL，因此不属于 MPL 2.0 §1.5(b) 所述“只有 MPL 1.1 而无 Secondary License”的情况。应用不修改这些上游声明，保留原始双许可源码，同时附 MPL 2.0 正文和完整来源。测试/性能目录的其他许可继续保留在归档内；MXE Cairo 配方禁用 tests，不把测试目录的 GPL 文本当成运行时 Cairo 的唯一许可。

官方依据：[MPL 1.1 §6.2](https://www.mozilla.org/en-US/MPL/1.1/)、[MPL 2.0 §1.5、§3、§10](https://www.mozilla.org/en-US/MPL/2.0/)、[Mozilla FAQ Q14](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)。MPL 2.0 官方页面原文及 SHA256 见 `native-mpl-2.0.html`、`native-additional-notices.json`。

### libimagequant 2.4.1

`build/libimagequant.mk` 锁定 `lovell/libimagequant` 的 v2.4.1 fork，SHA256 为 `47d2a84b7b1052975c9d50a3d4e3cacbf57b43d84a4c3131210848ead9964dfb`。其 `COPYRIGHT` 是两条款 BSD，并保留内嵌代码声明。实际许可证已收录于 `licenses/imagequant-2.4.1/0-COPYRIGHT.txt`。不套用较新版 libimagequant 的 GPL 许可，也不套用其他平台的构建清单。

## 修改库替换的真实验证

验证使用新的 `.local/native-relink-*` 副本，不修改已安装程序、开发运行库、用户工程或最终包。

1. 复制当前 sharp 和 Windows 原生包到隔离目录，启动新 Node 进程执行基线测试。
2. 只修改副本 `libvips-42.dll` 中等长、以 NUL 结尾的版本字符串 `8.18.6` → `8.18.7`。导出函数 `vips_version_string()` 确认返回新值；`vips_version(0..2)` 的数值 ABI 仍为 8.18.6，接口和 sharp.node 不变。
3. 再起新进程，检查 Node 的实际加载 DLL 路径确实位于隔离目录。执行 SVG 栅格化、缩放、PNG/JPEG/WebP/TIFF/GIF/AVIF 编解码和调色板 PNG；图像尺寸和所有输出字节的 SHA256 与基线一致。
4. 原开发 DLL 哈希保持不变。补丁偏移、修改后 DLL 哈希、各格式结果和运行时版本都写入 `native-runtime-audit.json`。测试副本不用于发布。

这验证了程序能够装载并使用接口兼容的修改库，未把“将原 DLL 复制回去”冒充修改库测试。它不是源码完整重编译测试，也没有声称二进制补丁是用户修改源码的唯一途径。

## 重新构建、重新组合与安装信息

以 LGPLv3 §4(d)(1) 的共享库机制评估应用与 libvips 的组合；对 DLL 内静态组成部分同时提供完整图像库源码、锁定依赖、补丁和重新构建脚本。源码与构建材料的交付要求仍然适用，不能被替换测试取代。GNU GPL §1 区分对应源码与一般用途工具、System Libraries；未将“本机已经从头编译全部通用工具”作为额外许可条件。

官方依据：[GNU LGPLv3 §4](https://www.gnu.org/licenses/lgpl-3.0.html)、[GNU GPLv3 §1、§6](https://www.gnu.org/licenses/gpl-3.0.html)。对应完整条文已随包保存在 `LGPL-3.0.txt` 和 `GPL-3.0.txt`。

建议的用户重构建路径（本轮未执行完整编译）：

1. 从本源码集合取得上述四份构建归档及 28 项库源码、350 个 Rust registry 归档。使用可运行 Docker/Podman 的 Linux 构建主机；一般编译器、容器引擎和系统构建依赖按上游说明准备。
2. 使用 `build-win64-mxe` v8.18.6 配方。为固定 MXE，将 `container/base.Dockerfile` 的 MXE 检出固定到本集合中的完整提交 `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3`，或将提供的该提交目录用于相同位置；不要改用当前 master。
3. 使用归档中的原始 `.mk`、`overrides.mk` 和 patches，目标为 `./build.sh --without-prebuilt -t x86_64-w64-mingw32.static vips-web`。`--without-prebuilt` 避免把可变 `latest` 容器当成唯一构建材料。各配方保留源码 URL 和校验和；已有归档可填入 MXE 下载缓存，Rust `.crate` 可供 Cargo 缓存/供应目录使用。
4. 修改所需库源码后重新构建整个 libvips DLL，以便内部静态组成部分重新组合。保留 ABI 所需的导出接口和调用约定。若改变 ABI，使用提供的 sharp 源码和 `src/binding.gyp` 重建包装层，不要求原应用二进制支持不兼容 ABI。
5. 完全退出 Ediro，备份后将接口兼容 DLL 放到 `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll`。其旁的 `libvips-cpp-8.18.6.dll` 和 `sharp-win32-x64-0.35.4.node` 如需重新链接亦可由所附源码重建和替换。重新启动后运行自己的样例验证。

Ediro 不在用户运行时校验这些 DLL 的固定哈希或签名，不限制为调试库修改所需的逆向工程。发布脚本里的哈希检查仅对维护者生成的分发候选负责。升级会更新程序文件，用户应保存自己的修改；恢复原 DLL 或重装程序即可恢复程序文件，工程和设置独立保存。
