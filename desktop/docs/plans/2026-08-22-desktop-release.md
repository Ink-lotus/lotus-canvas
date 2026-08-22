# lotus-canvas Windows 桌面端构建、签名、发布与自动更新实施计划

> 面向后续会话：开始实现前先通读本文，按阶段顺序执行并更新任务状态。本文是实施计划，不代表功能已经完成。

## 目标

建立一套只提交源码、不提交桌面构建产物的 Windows 发布流程：

- GitHub Actions 在 Windows Runner 上构建前端和 Electron 桌面端。
- 每个桌面端版本同时生成 Windows 安装包和绿色版压缩包。
- 安装包及其可执行文件使用 Windows 代码签名证书签名。
- GitHub Actions 将产物发布到 `Ink-lotus/infinite-canvas` 的 GitHub Release。
- 已安装的 NSIS 版本通过 `electron-updater` 检测新版本；只在用户点击“立即更新”后下载，并由用户确认重启安装。
- 绿色版保持免安装、可拷贝迁移，用户手动替换程序文件即可更新；`data/` 与 exe 同级且必须保留。
- 安装版首次启动允许选择媒体库目录，应用数据固定保存到 `%APPDATA%\lotus-canvas`，卸载时可由用户选择是否删除应用数据。

## 当前基线

- 根目录 `VERSION` 继续表示上游 Web 项目版本，例如 `v0.16.0`。
- `desktop/package.json` 使用独立桌面端版本，例如 `0.1.0`；桌面端每次发布必须提升该版本。
- 当前 `desktop/builder.yml` 已配置 Windows `nsis` 与 `dir` 目标，发布签名和更新验证仍需在 Windows 环境人工验收。
- `web/dist`、`desktop/release`、本机部署目录和 `data/` 均不提交到 Git。
- 前端构建产物必须由 CI 从当前源码重新生成，不能依赖提交者本机的 `web/dist`。
- 当前远程约定：`origin` 为 `https://github.com/Ink-lotus/infinite-canvas.git`，`upstream` 为原作者仓库；Release 只能发布到 `origin` 对应仓库。

## 版本与触发规则

### 版本来源

- `desktop/package.json.version` 是 Electron 应用和自动更新比较使用的版本来源。
- 根目录 `VERSION` 不因桌面端独立发版而修改。
- GitHub Release tag 使用 `desktop-v<desktop-version>`，例如 `desktop-v0.1.1`，避免与上游 `v0.16.0` 等 Web 版本 tag 冲突。
- CI 必须校验 tag 中的版本与 `desktop/package.json.version` 完全一致；不一致时失败且不得创建 Release。

### Workflow 触发

- `pull_request` 和普通分支 `push`：只做依赖安装、Web 构建、桌面端测试和打包验证，不创建公开 Release。
- `push` 到 `desktop-v*` tag：执行签名、构建全部发布产物并创建或更新 GitHub Release。
- `workflow_dispatch`：支持手动运行验证构建；发布模式必须显式输入或确认目标 tag，默认不得覆盖已有 Release。
- 不把每次源码提交都当成正式版本发布。正式发布必须先提升桌面端版本并创建 tag。

## 目标产物

每个桌面端 Release 至少包含：

1. NSIS Windows 安装包，例如 `lotus-canvas-0.1.1-win-x64.exe`。
2. 绿色版压缩包，例如 `lotus-canvas-0.1.1-win-x64-portable.zip`，内容来自 `win-unpacked/`，不包含用户 `data/`。
3. `latest.yml` 及安装包对应的 blockmap 等自动更新元数据。
4. `SHA256SUMS.txt`，列出所有发布文件的 SHA-256 校验值。

绿色版不能直接上传未压缩的 `win-unpacked/` 目录作为唯一下载项；必须提供可下载的 zip，并在压缩包内保留完整目录结构。

## 实施约束

- CI 使用 Windows Runner，避免在 Linux 上交叉构建 Windows 安装包。
- CI 使用 Node.js 22 LTS 和 `npm ci`，分别按 `web/package-lock.json`、`desktop/package-lock.json` 安装依赖。
- 不使用 `npm run deploy`，不访问或覆盖任何固定本机安装目录。
- GitHub Actions 只能写入 Release 资产，不得写入 `main`、`upstream` 或其他代码分支。
- Release workflow 使用最小权限：`contents: write`；PR/普通构建使用只读权限。
- 不把 API Key、WebDAV 凭据、用户 `data/`、日志、证书文件或证书密码打进产物或上传到仓库。
- 签名证书通过 GitHub Secrets 注入，构建结束后删除临时证书文件。
- 安装版自动更新和绿色版手动更新必须分别验证，不把绿色版误标记为支持应用内自动更新。

## 阶段 1：打包配置

**目标：** 在本地可重复生成安装包和绿色版压缩包。

- [x] 扩展 `desktop/builder.yml` 的 Windows target，同时保留 `dir`，增加 `nsis`。
- [x] 增加稳定的 `artifactName` 规则，文件名包含应用名、桌面端版本、平台和架构。
- [x] 配置 GitHub provider 的 owner/repo 为 `Ink-lotus/infinite-canvas`，但默认使用 `publish: never`，避免本地构建误发布。
- [x] 按 electron-builder 当前版本确认 `latest.yml`、blockmap 和 NSIS 产物的生成方式。
- [x] 为 `desktop/package.json` 补充 `author`、应用图标和必要的元数据。
- [x] 新增脚本或构建步骤，将 `release/win-unpacked/` 压缩为绿色版 zip；压缩前确认没有 `data/`。
- [x] 保持现有本地 `npm run build` 语义清晰；本地构建不应自动签名或上传 Release。

**阶段验收：** 在干净的 `web/dist` 前提下，本地能生成 NSIS 安装包、绿色版 zip，并确认两个产物都能启动 `app://canvas`。

## 阶段 2：GitHub Actions 构建工作流

**目标：** 从源码自动构建，不依赖仓库中的构建目录。

建议新增 `.github/workflows/desktop-build.yml`，包括以下步骤：

- [x] 使用 `actions/checkout` 检出 tag 对应源码。
- [x] 使用 `actions/setup-node` 固定 Node.js 22，并缓存两个 lockfile 对应的 npm 依赖。
- [x] 在 `web/` 执行 `npm ci` 和 `npm run build`。
- [x] 在 `desktop/` 执行 `npm ci` 和 `npm test`。
- [x] 校验 `desktop/package.json.version` 与 tag 版本一致。
- [x] 执行 Electron Builder，生成 `nsis` 和 `dir` 目标；CI 中显式使用 `--publish never`，发布由后续步骤统一控制。
- [x] 压缩 `release/win-unpacked/` 为绿色版 zip，排除 `data/`、日志和临时文件。
- [x] 生成 `SHA256SUMS.txt`。
- [x] 使用 GitHub CLI 创建 Release 并上传资产；重复运行时必须显式处理已存在的 Release，不静默覆盖错误版本。
- [x] 普通分支只上传短期 Actions artifact，不创建 GitHub Release。

**普通分支构建：** 可以复用同一套构建步骤作为验证，但只上传短期 Actions artifact，不创建 GitHub Release。

**阶段验收：** 从一个测试 tag 触发 workflow，Release 中出现安装包、绿色版 zip、更新元数据和校验文件；代码仓库没有新增 `dist`、`release` 或 exe 文件。

## 阶段 3：Windows 代码签名

**目标：** 公开发布的安装包和应用可执行文件显示可信发布者，降低 SmartScreen 和杀毒软件误报。

- [ ] 准备适用于 Windows 软件发布的代码签名证书及其密码。
- [ ] 将证书转换为 CI 可用的受保护格式，通过 `WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD` 等 GitHub Secrets 注入。
- [ ] 优先使用 electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD` 签名能力；只有内置签名不足时才增加显式 `signtool` 步骤。
- [ ] 配置可信时间戳服务，避免证书过期后历史构建失去有效签名。
- [ ] 签名步骤只在 tag 发布 workflow 执行；普通 PR 构建不使用证书。
- [ ] 构建后使用 `Get-AuthenticodeSignature` 检查安装包和关键 exe 的签名状态、签名者和时间戳。
- [ ] 签名失败时整个 Release workflow 失败，不上传未签名产物冒充正式版本。
- [ ] 记录证书轮换流程，不在仓库文档中写入证书密码或私钥内容。

**阶段验收：** Release 中的正式安装包和应用 exe 均显示预期签名状态；证书文件和密码未出现在 Actions 日志、artifact 或 Git 历史中。

## 阶段 4：GitHub Release 发布

**目标：** 将构建产物与桌面端版本绑定，供用户下载和自动更新读取。

- [ ] Release 名称和说明明确标注桌面端版本，不混用根目录 Web 版本。
- [ ] Release tag 使用 `desktop-v<version>`，并标记为正式 release 或预发布版本。
- [ ] 上传安装包、绿色版 zip、`latest.yml`、blockmap 和 `SHA256SUMS.txt`。
- [ ] Release 资产只来自当前 tag 的构建结果，不从工作区历史构建目录复制。
- [ ] 发布说明注明：安装版支持自动更新，绿色版需要手动下载并替换程序文件，`data/` 目录不能删除。
- [ ] 发布失败或签名失败时不创建可被自动更新读取的正式版本。
- [ ] 验证匿名访问 Release 资产的可用性；自动更新不应依赖把仓库写权限打进客户端。

## 阶段 5：安装版更新检测与用户确认安装

**目标：** 仅让 NSIS 安装版通过 GitHub Release 检测更新；下载和重启安装必须由用户明确触发和确认。

- [x] 在 `desktop/` 增加 `electron-updater` 依赖，并锁定版本。
- [x] 仅对 packaged、非绿色版应用启用 updater；开发态和绿色版默认关闭。
- [x] 使用 GitHub provider 指向 `Ink-lotus/infinite-canvas`，并通过桌面端 `desktop-v*` Release 检测。
- [x] 关闭静默下载和强制安装，提供检查中、发现新版本、下载进度、安装提示和失败提示等状态。
- [x] 启动时检测一次；网络失败只更新状态，不影响主应用使用。
- [x] 下载完成后由用户确认立即重启安装，绿色版不显示应用内更新入口。
- [ ] 新版本安装后验证 exe 同级 `data/` 仍存在，IndexedDB 和媒体库数据可继续读取。
- [x] 区分构建发布与客户端更新状态，分别在 CI 和应用界面验收。

**阶段验收：** 用已安装的旧版本测试升级到新桌面端版本；确认更新源、版本比较、下载、重启安装和数据保留均正常。用绿色版测试时不出现误导性的自动更新入口。

## 阶段 6：绿色版更新策略

- [x] 绿色版 zip 不包含用户 `data/`，也不把本机用户数据打进 Release；启动后在 exe 同级创建 `data/`。
- [x] 发布说明提供手动更新步骤：退出应用、备份 `data/`、解压新版程序、覆盖程序文件、恢复并保留 `data/`。
- [ ] 若未来要提供一键绿色版更新器，必须单独设计更新器进程、文件占用处理、回滚和签名校验，不直接复用 NSIS updater。
- [x] 当前阶段不实现绿色版应用内自动更新，避免破坏便携目录和用户数据。

## 完整验收清单

- [x] 本地 `web` 构建成功，桌面端 `npm test` 全部通过。
- [ ] CI 在 Windows Runner 上从干净检出完成构建，不依赖已存在的 `web/dist`。
- [ ] NSIS 安装包可以在干净 Windows 环境安装、启动和卸载。
- [ ] 绿色版 zip 解压后可以直接启动，目录可移动到另一个位置。
- [ ] 安装版升级不会删除或重置 `%APPDATA%\lotus-canvas` 及用户选择的媒体库。
- [x] 绿色版替换程序文件不会删除或重置 exe 同级 `data/`。
- [ ] 正式 Release 资产均有 SHA-256 校验值；签名状态符合发布要求。
- [ ] SmartScreen、安装包启动、外链系统浏览器打开、媒体文件库和 AI 请求中继完成一次人工回归。
- [ ] 用户确认后自动更新从至少一个旧桌面版本升级到新版本，失败网络场景不会阻塞应用启动。
- [ ] 普通分支或 PR 构建不会创建公开 Release，也不会使用签名证书。
- [ ] 构建产物未进入 Git 工作区，`git status` 不出现 `web/dist`、`desktop/release` 或本地部署目录。

## 暂不纳入本计划

- macOS、Linux 桌面包及其签名/公证。
- Microsoft Store / MSIX 发布。
- 绿色版一键自动更新器。
- 云端用户数据同步和服务端更新代理。
- 在本计划完成前修改现有桌面媒体库的数据存储逻辑。

## 与既有文档的关系

- 本计划补充并覆盖 `desktop/docs/specs/2026-07-31-electron-shell-design.md` 中“未签名、不做自动更新”的原始非目标；原有 CORS、`app://canvas`、用户数据目录和绿色版设计仍继续有效。
- 当前待办入口为 `docs/content/docs/progress/todo.zh-CN.mdx` 与 `docs/content/docs/progress/todo.mdx`；实现某一阶段后，应将对应待办移入 `pending-test`，人工验证通过后再更新正式功能文档。
