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

使用符合 `package.json` engines 要求的 Node，在 Windows x64 上运行：

```powershell
npm ci
npm run check
npm run package:win
```

打包固定使用项目安装的 Electron 运行时；electron-builder 版本锁定在开发依赖中。`package:win` 自动完成构建，收集依赖许可材料，再生成安装程序与便携 ZIP，不上传远端。

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

应用包内包含 `third_party` 许可与源码索引。运行 `node scripts/package-third-party-sources.mjs` 可按固定来源和 SHA-256 重建独立第三方源码附件；运行 `node scripts/prepare-public-source.mjs` 可按白名单导出应用源码。源码 ZIP、第三方源码 ZIP、发布说明和程序附件应在同一 Release 提供。

## 打包后自检

候选 EXE 提供显式的开发验收参数：

```powershell
Ediro.exe --ediro-release-smoke=<报告父目录>
```

该模式只创建新的隔离测试目录，使用生成的合成素材和模拟模型，拒绝网络调用，不访问用户原有工程或模型库。验证打包后的前端、预加载桥接、默认提示词、sharp、SQLite worker、工程保存/重开及加密能力，并输出截图、报告或错误文件。正常启动不会执行该模式。

自检不能替代安装/卸载体验、另一台 Windows 电脑及真实模型生成验收。首版分发前仍需确认实际包内容、数据保留、源代码对应版本和许可材料。
