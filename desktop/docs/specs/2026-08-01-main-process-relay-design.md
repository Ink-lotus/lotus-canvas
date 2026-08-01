# lotus-canvas：主进程中继与界面精简设计

日期：2026-08-01
前置设计：`desktop/docs/specs/2026-07-31-electron-shell-design.md`（Electron 套壳与跨域拦截，已实施完成）

## 背景与问题

套壳解决了跨域，但生图仍然失败。用户实测现象：

- 中转站后台显示**大部分生图成功且已正常扣费**，只有一张真失败并退费
- 应用内报 `请求失败（HTTP 524）`
- Base URL 与 API Key 均正确（`buildApiUrl` 见 `web/src/stores/use-config-store.ts:389`，会自动补 `/v1`，填 `https://wisart.kuaileshifu.com` 是对的）

即：**生成在服务端成功了，响应没能回到客户端**。

### 根因

生图期间连接上没有任何字节流动。等待时长超过中间层（网关 / NAT）对空闲连接的容忍上限（约 100 秒）后，连接被静默切断，客户端收到 524，而上游照常算完并计费。

同一中转站在两个 infinite-canvas 衍生项目中可正常使用，二者共同点是**都有服务端**：

| 项目 | 实现 |
| --- | --- |
| `open-ai-canvas` | Go 后端，`ImageTimeoutMinutes: 8` |
| `flyreq-image-studio` | Node 后端，undici keepalive + 30 分钟超时 |

`flyreq-image-studio` 的 `backend/server.js:2222` 注释直接记录了同一故障：

> 启用 TCP keepalive，防止连接被静默断开。Node.js 内置 fetch 基于 undici，默认不发送 TCP keepalive，导致长时间等待响应（如 4K 图片生成）时连接被网络层丢弃。

其配置为 `keepAliveInitialDelay: 15000`、`headersTimeout` 与 `bodyTimeout` 均 30 分钟。

两者的请求体与 infinite-canvas 几乎一致（同为 `POST /v1/images/generations`，同带 `response_format: "b64_json"`）。**差别不在请求内容，在由谁发出该请求。**

浏览器环境对 TCP keepalive、`headersTimeout`、连接池行为**没有任何控制权**，因此当前架构（请求由渲染进程发出）无法修复。Electron 主进程是 Node 运行时，具备完整控制权。

置信度说明：根因系由三条证据推断——用户描述的「扣费成功但客户端报错」症状、`flyreq` 注释中对同一故障模式的明确记录、两个可用项目均走服务端 HTTP 且均调优了 keepalive 与超时。未在 wisart 上直接抓包验证。

## 目标与非目标

**目标**

- 消除长耗时生成请求的 524
- 前端 `web/` 继续零改动
- 隐藏默认菜单栏（File / Edit / View / Window），同时保留开发者工具快捷键
- 不引入新的运行时依赖

**非目标**

- 不做后端服务进程、不做任务队列、不做生成结果持久化
- 不改造前端代码
- 不将全部流量改道（仅 POST 走中继）

## 能力验证（2026-08-01 实测）

| 前提 | 结果 |
| --- | --- |
| `protocol.handle("https", ...)` 在 Electron 43.2.0 可用 | ✅ `canHandleHttps: true` |
| 主进程可 `require("undici")` | ❌ 不可用。`flyreq` 系将 `undici@^8.2.0` 显式装为依赖 |

因 undici 不可直接 require，且项目约束为不新增依赖，改用 Node 内置 `https` 模块，通过 `socket.setKeepAlive(true, 15000)` 达成等价效果，并可完全控制超时。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 哪些请求走中继 | **所有 POST** | 生成类调用全为 POST；插件 JS、素材下载全为 GET。规则简单，几乎无误伤，且无需任何配置 |
| 用什么发请求 | **Node 内置 `https`** | 零新增依赖，`socket.setKeepAlive` 与 flyreq 的 undici 配置等价 |
| 预检处理 | **主进程本地应答** | 预检不再发往网络，顺带消除前一设计「中转站丢弃 OPTIONS 则失效」的限制 |
| 原 CORS 头注入 | **保留** | 见下节 |
| 菜单栏 | **移除并补回快捷键** | 见组件设计第 3 节 |

### 为何保留原有的 `onHeadersReceived` 头注入

中继只覆盖 POST。`GET /v1/models`（拉取模型列表）是 GET，不走中继，其跨域仍依赖响应头注入——而该接口正是实测确认在 wisart 上被跨域拦死的接口，也是既有验收标准。

两者互补而非重复：**中继管 POST 的超时与跨域，头注入管 GET 的跨域，本地预检应答管两者的 OPTIONS。**

若要彻底移除头注入，需让 GET 也走中继，届时插件 JS 与素材下载全部改道 Node，风险与收益不成比例，故不采纳。

## 架构

```
渲染进程（web/ 未修改）
    │  axios / fetch
    ▼
protocol.handle("https")                     ← 主进程接管全部 https
    ├─ OPTIONS      → 本地合成 200 + CORS 头，不发往网络
    ├─ POST         → Node https 发出（TCP keepalive 15s + 长超时），响应流式回传并补 CORS 头
    └─ 其余（GET 等）→ net.fetch(request, { bypassCustomProtocolHandlers: true }) 原样透传
                          ↓
                     session.webRequest.onHeadersReceived  ← 既有头注入，继续生效
```

## 组件设计

### 1. `desktop/src/relay.js`（新增）

纯逻辑与 Node I/O 分离，便于测试：

- `shouldRelay(method)` — 是否走中继。当前规则：`POST`
- `isPreflight(method)` — 是否为 `OPTIONS`
- `buildRelayOptions(url, headers)` — 构造 Node `https.request` 的参数，剔除逐跳头（`connection`、`keep-alive`、`transfer-encoding`、`upgrade`、`proxy-*`）与 `host`
- `relayRequest(request)` — 执行中继，返回 Web `Response`

实现要求：

- `req.on("socket", (s) => s.setKeepAlive(true, 15000))` — 每 15 秒一次 TCP keepalive 探测，防止空闲连接被中间层丢弃。**这是本设计的核心**
- 超时设为 30 分钟（与 flyreq 一致），而非依赖默认值
- 请求体整体读入 Buffer 后写出，并据此设置正确的 `Content-Length`。参考图为 base64、体积可达数 MB，缓冲开销可接受；而流式转发需处理 `Content-Length` 与实际字节数不一致的风险，可靠性更差
- 响应体以流的形式返回，**不整体缓冲**——`image.ts` 存在 SSE 流式通道（`/responses`），缓冲会破坏它，且生图返回的 base64 体积很大
- 不自动跟随重定向：原样返回 3xx，由渲染进程自行跟随（会再次进入本处理器）

### 2. CORS 头补齐

中继返回的响应由主进程合成，`onHeadersReceived` 对其不生效，故中继必须自行补 CORS 头。

为避免重复定义，`desktop/src/cors.js` 新增导出 `corsHeaderEntries()`，返回四个头的普通对象；`buildCorsResponse` 与中继共用之。既有行为与测试不变。

预检的本地应答同样使用该函数，返回 `200` 空体。

### 3. `desktop/main.js` 菜单栏

`Menu.setApplicationMenu(null)` 移除默认菜单。

**副作用**：`Ctrl+Shift+I` 与 `F12` 由默认菜单的 `toggleDevTools` 角色提供，移除菜单后一并失效。而开发者工具是排查网络问题的主要手段，必须补回。

通过 `webContents.on("before-input-event")` 重新注册：`F12` 或 `Ctrl+Shift+I` 切换开发者工具。

## 错误处理

| 场景 | 处理 |
| --- | --- |
| 上游连接失败 / DNS 失败 / 超时（30 分钟）/ 请求体读取失败 / 中继内部异常 | 统一返回 `502`，响应体为 JSON `{ error: { message } }` 并带 CORS 头，使前端能显示可读错误而非静默失败。不细分状态码：对本地单人工具而言，区分「上游拒绝」与「中继内部出错」对使用者没有可操作差异，而 message 已携带具体原因 |

中继处理器整体包 try/catch，任何分支都必须返回一个 `Response`。抛出未捕获异常会使该请求永久挂起且无任何报错。

## 验证

**成功标准一（本增量的主验收线）：** 在应用内用 wisart 渠道成功生成一张图片，且中转站后台记录与客户端结果一致。这是本增量存在的唯一理由。

**成功标准二（回归，必须同时满足）：** 模型列表仍能正常拉取。中继改变了 POST 的路径，而模型列表是 GET，须确认既有头注入未被破坏。

分层验证：

1. **单元层** — `shouldRelay` / `isPreflight` / `buildRelayOptions` 的纯函数测试，含逐跳头剔除
2. **机制层** — 主进程日志确认 POST 走中继、OPTIONS 本地应答、GET 透传三条路径各自生效
3. **端到端层** — 上述两条成功标准
4. **界面层** — 菜单栏消失，`F12` 与 `Ctrl+Shift+I` 仍能开启开发者工具

## 已知限制

1. **仅 POST 走中继。** 其他方法（含 WebDAV 的 `PUT` / `PROPFIND`）仍由渲染进程发出，若将来出现同类超时，需扩展 `shouldRelay`
2. **不自动跟随重定向。** 依赖渲染进程跟随；若上游对 POST 返回 307/308，行为取决于前端 fetch 实现
3. **根因未经抓包证实。** 若实测后 524 仍然出现，说明推断有误，需在 wisart 上直接抓包重新定位
4. **POST 不再产生预检 OPTIONS（Task 2 实测已确认）。** 当 `protocol.handle("https")` 接管请求后，实测根本没有生成任何 OPTIONS 预检——既没有 OPTIONS 进入主进程处理器，也没有 OPTIONS 发往网络。原先「预检是否会路由到自定义协议处理器」的疑问就此消解：既无预检，「本地应答预检」这一分支在 POST 场景下不会被触发，也无需触发
5. 前一设计的已知限制中，「中转站丢弃 OPTIONS 连接」一条对 POST 请求不再适用——如第 4 条所述，POST 已不再产生预检，也就不存在会被中转站丢弃的 OPTIONS
