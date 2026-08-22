# lotus-canvas：Electron 桌面套壳设计

日期：2026-07-31

## 背景与问题

infinite-canvas 是纯静态前端 SPA，AI 请求由浏览器直连用户配置的 OpenAI 兼容中转站。中转站不返回 CORS 头时，浏览器拦截请求，功能不可用。

上游明确不提供后端：`Dockerfile` 注释「运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口」；官方文档写明 Vercel 部署「不需要额外配置服务端」；作者对 issue #5（跨域报错）的回复是「走后端」，但项目本身不带，社区添加代理的 PR #79 未合并（`merged: false`）。

### 实测诊断

中转站 `https://wisart.kuaileshifu.com/v1`，2026-07-31：

| 检查项 | 结果 |
| --- | --- |
| API Key 有效性 | 有效（真 Key → `prompt is required`；假 Key 对照 → `Invalid or missing API key.`） |
| `POST /v1/images/generations` | 服务端调用正常 |
| `GET /v1/models` | HTTP 200，返回 4 个模型 |
| `OPTIONS /v1/images/generations` | **404**，`Access-Control-*` 头数量 **0** |
| `OPTIONS /v1/models` | `Access-Control-*` 头数量 **0** |
| 实际响应中的 CORS 头 | **0** |

结论：问题纯粹是 CORS。中转站完全未实现 CORS，连 OPTIONS 路由都没配（nginx 直接 404）。服务端调用一切正常，不是 Key 问题，也不是中转站封禁。

预检失败有两重原因，任一条都足以拦截：预检响应要求 2xx 而它返回 404；且完全没有 `Access-Control-Allow-Origin`。`/v1/models` 同样无 CORS 头，因此网页版连模型列表都拉不到——全线不通。

## 目标与非目标

**目标**

- 保留 infinite-canvas 全部画布能力：节点、连线、参考图可视化编辑、画布编排、多渠道管理
- 消除跨域限制
- `web/` 零改动，便于持续同步上游更新
- 本机自用，绿色免安装，数据可随文件夹迁移

**非目标**

- 不做多用户、登录、配额、管理后台
- 不做后端中继服务
- 不改造前端代码
- 不做自动更新、不做代码签名
- 不对外提供服务

## 方案选型

| 方案 | 否决理由 |
| --- | --- |
| Vercel 静态部署 | 不解决问题。根 `vercel.json` 只有 SPA 兜底重写，无代理；浏览器仍直连中转站，跨域原样存在 |
| 上游中转站开 CORS | 中转站非本人所有，无法配置 |
| nginx 同源反代 | 部分中转站不接受反代 |
| 本地中继后端 | 可行（服务端调用实测正常），但需常驻两个进程 |
| 打包成 codeg skill | 失去画布 UI，且 skill 只提供 know-how 不提供工具能力，仍需另写脚本 |
| 从零重建应用 | 前端 26,889 行，`pages/canvas/project.tsx` 单文件 3,049 行，且依赖中无任何画布库（react-flow / konva / fabric / tldraw 均无）——节点、连线、拖拽、缩放、框选、撤销重做全为手写。为绕开小问题重写最难部分，性价比倒挂 |
| Tauri 套壳 | 需引入 Rust 工具链；且 Tauri webview 内发外部请求仍受 CORS 约束，必须改用 `@tauri-apps/plugin-http` 改造约 20 处调用点，破坏零改动前提，上游同步将持续冲突 |

**选定：Electron 套壳 + 主进程响应头改写。**

关键依据：实测 OPTIONS 返回 404 而**非丢弃连接**，说明服务器确实响应，`onHeadersReceived` 必然触发，改写方案成立。

## 架构

```
lotus-canvas/
├── web/            上游，零改动
├── canvas-agent/   上游，零改动
├── plugins/        上游，零改动
└── desktop/        本项目唯一新增
    ├── package.json
    ├── main.js
    ├── builder.yml
    └── docs/specs/  本设计文档
```

数据流：

```
渲染进程（infinite-canvas 前端，未修改）
    │  axios / fetch 直连中转站
    ▼
Electron session.webRequest.onHeadersReceived
    │  删除已有 CORS 头 → 注入 CORS 头 → 预检非 2xx 时改写状态行
    ▼
中转站（无 CORS 头）
```

前端全程无感知，它认为对方支持 CORS。

## 组件设计

### 1. 应用加载：`app://` 自定义协议

前端使用 `createBrowserRouter`（`web/src/router.tsx:15`），依赖 History API，`file://` 下必然白屏。注册自定义标准协议解决：

- `protocol.registerSchemesAsPrivileged` 注册 `app`，权限 `standard: true`（History API 可用，BrowserRouter 正常）、`secure: true`（安全上下文，IndexedDB 与 `crypto.subtle` 可用）、`supportFetchAPI`、`stream`
- `protocol.handle("app", ...)` 将请求映射到 `web/dist`
- SPA 兜底：路径不含扩展名或目标文件不存在时返回 `index.html`
- 窗口加载 `app://canvas/`

**`app://canvas` 中的主机名 `canvas` 一经确定不可再改。** 它构成 origin 的一部分，修改后 IndexedDB 视为不同来源，已有画布、素材与生成记录将全部不可见（数据仍在磁盘上，但应用读不到）。

不使用本地 HTTP 静态服务，避免端口冲突与本机监听端口。

**不设 dev 模式。** `web/` 零改动意味着不需要前端热更新；改 `desktop/main.js` 后重启 Electron 即可。因此只有 `app://canvas` 一个 origin，只有一份 IndexedDB 数据，不存在 dev/prod 数据隔离问题。

代价：将来若要改前端，需每次 `bun run build` 才能看到效果。在零改动前提下不构成问题。

### 2. 跨域拦截

`session.defaultSession.webRequest.onHeadersReceived` 中：

1. 按**大小写不敏感**删除响应中已有的 `Access-Control-*` 头。这一步保证对本身正确返回 CORS 头的中转站不产生重复头，它们照常工作
2. 注入：
   - `Access-Control-Allow-Origin: *`
   - `Access-Control-Allow-Headers: Authorization, Content-Type, Accept, x-goog-api-key, *`
   - `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS`
   - `Access-Control-Expose-Headers: *`
3. 若 `details.method === "OPTIONS"` 且状态码非 2xx，改写 `statusLine` 为 `HTTP/1.1 200 OK`
4. 仅处理外部 http/https，跳过 `app://` 与 `devtools://`，避免干扰应用自身资源加载

**两处必须遵守的约束：**

- **所有分支必须调用 `callback()`**，包含异常分支。漏调一次会使该请求永久挂起，表现为应用卡住且无任何报错，极难排查。拦截器整体包 try/catch，catch 分支调用 `callback({})`
- **`Access-Control-Allow-Headers: *` 按 Fetch 规范不覆盖 `Authorization`**，必须显式列出。否则预检照样失败，且报错信息具误导性

**保留 `webSecurity: true`。** 项目含插件系统（`web/src/lib/canvas/plugin-loader.ts` 从 URL 加载远程 JS）与第三方提示词仓库拉取，关闭 webSecurity 会放大这些远程代码的权限。需说明的是：`webSecurity: true` 与 `Access-Control-Allow-Origin: *` 是正交的两件事——前者保证插件等远程代码拿不到 Node 与文件系统权限；后者却确实移除了被拦截主机的跨域读取保护，这是本方案对公网主机自觉接受的取舍。为此拦截范围收窄到公网地址（`desktop/src/cors.js` 的 `isNonPublicHost`），使插件代码无法借注入的 CORS 头去读取回环与内网服务。

### 3. 数据存储

- 绿色版通过 `app.setPath("userData", path.join(path.dirname(app.getPath("exe")), "data"))` 将数据落在 exe 同级 `data/`，整个文件夹可拷走迁移；安装版按桌面发布计划保存到 `%APPDATA%\\lotus-canvas\\data`
- 画布、素材、生成记录仍由前端存 IndexedDB（localforage），无需改动

### 4. 打包

- electron-builder，Windows `dir` 目标（绿色文件夹）
- 构建顺序：先 `cd web && bun run build` 产出 `web/dist`，再 `cd desktop && bun run build` 打包
- `web/dist` 位于 `desktop/` 之外，需在 `builder.yml` 中通过 `extraResources` 显式纳入（例如 `from: ../web/dist` → `to: dist`），主进程据此解析 `DIST` 路径；打包态与未打包态的 `DIST` 取值不同，由 `app.isPackaged` 区分
- 选择 `dir` 而非 `portable`：portable 本质是自解压包，每次启动解压到 `%TEMP%`，有数秒启动开销；`dir` 直接启动。「免安装」的实际诉求（不写注册表、不进控制面板、删除即卸载）`dir` 全部满足

## 错误处理

| 场景 | 处理 |
| --- | --- |
| 拦截器内部异常 | try/catch 包裹，catch 分支调用 `callback({})`，避免请求挂起 |
| 静态资源不存在 | 回退 `index.html`，支撑 SPA 路由 |
| 中转站丢弃 OPTIONS 连接 | 本方案失效，见「已知限制」 |

## 验证

**主成功标准：** 在应用内配置**当前实际启用的中转站**，其模型列表能正常拉取。

**验证目标必须是一个「在网页版确实因跨域失败」的中转站。** 这是该标准成立的前提：若选用一个本身就正确返回 CORS 头的中转站（用户当前在用的其他几个即属此类），测试通过不能说明任何问题——不套壳同样能通，属于空验证。这类中转站只应用于**回归验证**，即确认拦截器没有破坏原本正常工作的站点。

验证前先跑一次预检诊断，确认目标中转站确实无 CORS：

```bash
curl -s -o /dev/null -D - -X OPTIONS "<BASE_URL>/models" \
  -H "Origin: https://canvas.best" -H "Access-Control-Request-Method: POST" \
  | grep -ic access-control
# 输出 0 → 该站确无 CORS 头，适合作为验证目标
# 输出 >0 → 该站本身支持 CORS，只能用于回归验证
```

已知满足条件的实例（2026-07-31 实测）：`https://wisart.kuaileshifu.com/v1`，`OPTIONS` 返回 404 且 `Access-Control-*` 头数量为 0，模型列表应返回 `nano-banana-pro`、`nano-banana-2`、`nano-banana-2-lite`、`gpt-image-2`。该实例仅作为参照，不构成验收标准本身。

分层验证，由廉至贵：

1. **拦截器层** — 主进程日志确认目标站的 `OPTIONS /models` 被改写为 2xx
2. **端到端层** — 模型列表拉通。**本阶段验收线**
3. **业务层** — 实际生成图片。涉及计费，由用户自行验证

另需一项**回归验证**：切换到一个原本在网页版正常工作的中转站，确认其模型列表与生成功能未被拦截器破坏（对应组件设计第 2 节「先删后加」的去重逻辑）。

## 已知限制与退路

1. **中转站丢弃 OPTIONS 连接时本方案失效。** 若服务器对 OPTIONS 完全不响应，则无响应头可拦截，`onHeadersReceived` 不会触发。用户当前在用的其他中转站在网页端无跨域问题，暂不处理。将来若出现，退路是在主进程用 `protocol.handle` 接管 https，对特定 host 由主进程直接发起请求，完全不产生预检
2. **`Access-Control-Allow-Origin: *` 与携带凭据的请求不兼容。** 若 WebDAV 同步出现问题，改为回显请求的 `Origin` 头并添加 `Access-Control-Allow-Credentials: true`
3. **无前端热更新。** 改 `web/` 需 `bun run build`
4. **未签名。** 可能触发 Windows Defender 或国产杀软提示
5. **拦截跳过回环、私网与链路本地地址。** 因此运行在 `localhost` 或内网地址上的中继在本套壳内不生效。若将来确有需要，放宽 `desktop/src/cors.js` 中的 `isNonPublicHost` 即可
6. **主机检查基于主机名、不做 DNS 解析。** 因此解析到内网 IP 的公网域名不会被拦截（DNS rebinding）。作为单用户本机工具，接受该风险

## 上游同步

`web/` 零改动、所有改动集中在新增的 `desktop/` 目录（含本设计文档），上游更新不会产生冲突。

仓库已 clone 完成，`origin` 已重命名为 `upstream` 指向上游。后续更新：

```bash
git fetch upstream && git merge upstream/main
```

不使用 git 时覆盖法亦可行，但必须**先删除**上游目录再放入新版——直接覆盖粘贴只做添加与替换，不会移除上游已删除的文件，残留文件可能被旧引用误用。
