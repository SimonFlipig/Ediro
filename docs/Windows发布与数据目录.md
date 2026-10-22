# Windows 发布与数据目录

首版目标为 Windows x64，同时提供安装版和 ZIP 便携版。候选包通过后再发布到 GitHub Releases。安装版支持用户确认后更新；便携版提供新版下载提醒。

## 安装目录与权限

通常选择仅为当前用户安装，并保留默认目录，无需管理员权限。需要安装到 `C:\Program Files\Ediro` 时，请在安装范围页面选择为所有用户安装，并允许 Windows 的管理员权限请求；仅修改路径不会自动获得管理员权限。无论安装范围如何，工程与设置仍按下表分别保存在当前用户的数据目录。

安装向导会在目录页检查当前权限是否能写入目标目录；不可写时不能继续。权限检查不创建或删除文件。遇到写入失败时请中止，不要忽略文件后继续安装。

维护者可运行 `node scripts/verify-installer-directory.mjs` 检查可写目录、新建子目录、已有同名文件与受保护系统目录四种情况。该检查生成独立测试程序，不安装 Ediro；真实安装范围选择和 Windows 提权仍需手动验收。

## 用户数据

| 版本 | 默认工程与导出 | 设置、凭据与恢复缓存 |
| --- | --- | --- |
| 安装版 | Windows 文档目录下的 `Ediro/Project` 和 `Ediro/output` | 当前用户 `%APPDATA%/Ediro/runtime` |
| 便携版 | `Ediro.exe` 旁的 `data/Project` 和 `data/output` | `data/.local/runtime` |
| 源码开发版 | 源码根目录的 `Project` 和 `output` | 源码根目录的 `.local/runtime` |

“文档”目录通过系统 API 获取，遵循用户实际的重定向位置。打开或另存到其他目录的 `.ediro` 仍在选定路径保存。安装版与便携版的设置独立，互换时重新配置连接，已有工程可直接打开。

便携版须完整解压到可写目录。`ediro-portable.json` 是模式标记，须与 EXE 一同保留；不要把它复制到安装版目录。程序不会将用户数据写进 `resources/app.asar`。

升级安装版时保持数据目录不变；卸载程序不主动删除用户工程和设置。更新便携版前关闭程序，完整保留旧 `data`，放到新版本 EXE 旁。不要把新程序目录覆盖到整个旧数据目录，也不要在工程写入时复制它。

工程可以跨电脑携带。API Key 使用 Windows 用户加密存储，换电脑或 Windows 用户后需要重新填写。单独备份 `.ediro` 可以保存工程内容；只备份 EXE 不会备份工程和设置。

## 构建候选包

使用符合 `package.json` engines 要求的 Node，在 Windows x64 上安装完整 7-Zip（`7z.exe` 与 `7z.dll`），然后运行：

```powershell
npm ci
npm run check
$env:EDIRO_AUDIT_7ZIP_PATH = 'C:\Program Files\7-Zip\7z.exe'
npm run package:win
```

打包固定使用项目安装的 Electron 运行时；electron-builder 版本锁定在开发依赖中。`package:win` 自动完成构建，收集依赖许可材料，再生成安装程序与便携 ZIP，不上传远端。安装器使用经过哈希核对的模板镜像和自有 Windows COM 接口；打包后解包两个阶段，确认不含 WinShell.dll。这里需要完整 7-Zip 的 NSIS 处理器，精简的 `7za.exe` 不适用，具体说明见 `build/shell-integration.md`。

输出在 `.local/release-candidates/<版本>-<时间>/`，不同构建不互相覆盖。安装包为 `Ediro-<版本>-windows-x64-setup.exe`，便携包为 `Ediro-<版本>-windows-x64-portable.zip`。同目录提供安装包 `.blockmap`、`latest.yml`、`SHA256SUMS.txt` 和 `candidate.json`；最近成功构建的位置记录在 `.local/last-release-candidate.json`。脚本会核对 `latest.yml` 中版本、安装包大小及 SHA-512，并检查包内更新源配置。

## GitHub 更新发布

更新源固定为公开仓库 `SimonFlipig/Ediro`，使用 `electron-updater` 的 GitHub provider；不向客户端放入 GitHub Token。`package:win` 始终传 `publish: never`，构建本身不会上传或发布。生产更新依赖仓库和 Releases 对普通用户公开可读，草稿版本不会用于更新。

每次更新先提高 `package.json` 及锁文件中的版本号，再构建。发布标签使用 `v<版本号>`；把本次构建的安装包、同名 `.blockmap`、`latest.yml`、便携 ZIP 和校验文件放入同一个 Release。所有附件上传完成后再发布，避免客户端取得缺失文件。不要混用不同构建的安装包与更新信息。源码和第三方许可材料也须与版本对应。

客户端启动约 10 秒后检查，此后每 6 小时检查一次；开发模式不检查。后台检查不会自动下载、安装或弹出强制对话框，发现更新时顶部入口显示提示。下载完成后必须点击“保存并重启升级”；程序先提交编辑器内容、落盘并检查任务状态，再启动安装器，正常退出时不自动安装缓存更新。保存失败保留窗口供用户处理；网络或校验失败显示错误并允许重试。

便携版复用版本检测，但主进程禁止其下载安装器，只能打开固定仓库的发布页手动下载 ZIP。新版本不得覆盖用户的 `data`。源码开发版禁用在线检查及安装。当前未签名候选包提供传输与文件完整性校验，尚不提供发布者签名校验。

验证更新应区分：本地状态机/保存保护测试、本地 HTTP 下载校验与桌面交互、真实 GitHub 发布以及安装替换。前两项不代表已完成后两项；首版没有已发布的旧版本，真实跨版本升级留待后续版本发布时验收，并在首版发布说明中列为尚未验证的范围。

`win-unpacked` 是用于验收的安装版程序目录，另一个 `Ediro-<版本>-portable` 目录用于 ZIP 构建。不要把使用后的便携目录重新压缩分发，以免带入自己的数据。

打包采用应用文件白名单，只收录编译产物、运行依赖和许可文件；不会收录本机 `.local`、Project、output、原图、私有调优工具或全部开发源码。默认提示词来自已审定的发布快照。

当前未配置代码签名证书，候选包未签名；Windows 可能显示未知发布者提示。第三方许可材料的完整发布检查见 `THIRD_PARTY_NOTICES.md`。

应用包内包含 `third_party` 许可与源码索引。应用源码仍按每个应用版本独立提供；第三方源码改为内容寻址的固定依赖集合，允许多个应用版本显式引用同一附件，不随应用版本重压缩。旧 Release 附件不删除、不替换。

## 共享第三方源码的发布检查

Chromium 原包含下载的工具链和 Linux 系统根，公开集合使用记录了来源的派生源码 TAR。缓存缺少该 TAR 时，`sources:pack` 先校验原包，再通过 Python 3 标准库运行固定过滤脚本，最后核对派生结果；可用 `EDIRO_PYTHON_PATH` 指定 Python 可执行文件，或使用 `PYTHON` / PATH 中的 `python`。此过程不运行归档里的第三方代码，不把派生文件当成上游原始字节。具体策略与结果保存在 `third_party/build-evidence/chromium-source-filter*.json`。

1. 运行 `npm run sources:pack -- <可选的已有归档缓存目录>`。源码、许可材料、锁文件中的依赖项、构建配置及 Electron/sharp 原生输入参与 sourceSetId；应用自身版本号和打包时间不参与。`.local/source-sets/<完整ID>/` 已存在时验证 ZIP SHA256 后复用；文件损坏时报错，不静默重打或覆盖。
2. 完成 `config/source-review.json` 中所有审查项，保存可核验的证据材料，再将批准绑定到精确 sourceSetId。状态为 pending 时表示审查尚未完成；不得仅为通过脚本改成 approved。审查文本和源码材料发生变化会产生新集合。证据包括原生源码覆盖、重新链接、Electron 组成源码、JavaScript 与许可、安装器组件。
3. 首次将该集合上传到独立的公开源码存储位置；不要在应用更新仓库创建可能干扰版本流的源码集 Release。匿名完整下载一次并比对 ZIP 哈希后，在 `config/source-publications.json` 登记 sourceSetId、name、bytes、sha256、固定 HTTPS url；GitHub 附件还记录 assetApiUrl。此工具不创建仓库，也不自动上传，首次公开位置须先落实。永久保留引用中的集合，并另留备份。
4. 完成登记后重新 `npm run package:win`，使二进制内包含准确的 `SOURCE_CODE.md`、`source-reference.json`。仅本地预览允许未登记候选包，但包内明确标注不得分发。发布检查会拒绝这类包。
5. 按白名单导出当前应用源码，在候选目录准备 `Ediro-<版本>-source.zip`。运行 `npm run release:verify -- <候选目录>`：检查批准、共享源码可用性、实际原生文件与构建输入、程序附件校验和包内源码引用；同时逐文件核对应用源码 ZIP 与打包时的源文件快照（文本允许 Git 的 CRLF/LF 转换），拒绝错版、缺文件或重复路径；生成 `SOURCE_LINKS.md` 和新的 `SHA256SUMS.txt`。GitHub 附件每次核对公开 API 的文件哈希、大小和匿名下载可达性，避免每版重下大文件；其他存储完整下载校验。
6. 创建应用版本的草稿，把 `SOURCE_LINKS.md` 原文加入 Release 正文。上传安装包、blockmap、latest.yml、便携 ZIP、应用源码 ZIP、source-reference.json 和 SHA256SUMS.txt，共 7 项。不上传重复第三方 ZIP。
7. 用 `npm run release:publish -- <候选目录>` 正式发布。它重新执行源码检查，再核对草稿正文和所有远端附件哈希，全部通过才设为 latest。如 gh 不在 PATH，可设置 EDIRO_GH_PATH 指向 GitHub CLI。不要使用手动 `gh release edit` 绕过检查；脚本不能限制仓库管理员在 GitHub 上的直接操作。

第三方源码集超过单个附件大小时，打包脚本保留完整 ZIP，并将原字节拆成每卷不超过 1,900,000,000 字节的 `.zip.001`、`.zip.002` 等分卷。公开登记同时记录完整 ZIP 和每卷的大小、SHA256 及固定下载地址；首次登记须匿名下载全部分卷，核对逐卷及拼接后的完整哈希。后续发布检查每卷公开附件的哈希和可达性。使用者下载所有分卷到同一目录后，可用 7-Zip 打开 `.zip.001`。缺卷、换序或任一卷损坏都不能视为完整源码。

构建脚本不自动改变审查状态，内容哈希也不证明法律合规。依赖升级、源码补丁、相关构建方式、许可材料或实际原生输入变化都要求重新审查；只改 Ediro 界面／业务逻辑可复用共享包，但对应应用源码必须更新。拒绝 latest、临时授权、需要登录的源码链接。源码下载不可用、哈希不符或材料不全时停止发布。

GPLv3 §6(d) 允许源码分开托管，但分发方仍承担准确对应、清晰指引与持续可用责任；LGPL 的修改和重新链接权利不因动态 DLL 或共享附件而减少。官方依据：[GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#SourceAndBinaryOnDifferentSites)、[FFmpeg](https://ffmpeg.org/legal.html)。

## 打包后自检

候选 EXE 提供显式的开发验收参数：

```powershell
Ediro.exe --ediro-release-smoke=<报告父目录>
```

该模式只创建新的隔离测试目录，使用生成的合成素材和模拟模型，拒绝网络调用，不访问用户原有工程或模型库。验证打包后的前端、预加载桥接、默认提示词、sharp、SQLite worker、工程保存/重开及加密能力，并输出截图、报告或错误文件。正常启动不会执行该模式。

自检不能替代安装/卸载体验、另一台 Windows 电脑及真实模型生成验收。首版分发前仍需确认实际包内容、数据保留、源代码对应版本和许可材料。
