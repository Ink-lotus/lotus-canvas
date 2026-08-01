# lotus-canvas 主进程中继与界面精简 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有 POST 由 Electron 主进程用 Node `https` 发出（TCP keepalive + 30 分钟超时），消除长耗时生图的 HTTP 524；同时隐藏默认菜单栏并补回开发者工具快捷键。

**Architecture:** `protocol.handle("https")` 接管全部 https 请求，分三路：OPTIONS 本地合成 200；POST 走 Node `https` 中继并自行补 CORS 头；其余用 `net.fetch(request, { bypassCustomProtocolHandlers: true })` 原样透传，继续由既有 `onHeadersReceived` 注入 CORS 头。纯逻辑抽为无 Electron 依赖的函数以便单元测试。

**Tech Stack:** Electron 43.2.0、Node 内置 `node:https` / `node:stream`、Node 内置测试运行器。不新增任何依赖。

设计依据：`desktop/docs/specs/2026-08-01-main-process-relay-design.md`

## Global Constraints

- **`web/` 零改动。** 任何任务都不得修改 `web/` 下任何文件。
- **仓库根目录零改动。**
- **不新增任何依赖。** 不得引入 `undici` 或其他包；测试仅用 `node:test` / `node:assert`。
- **模块格式 CommonJS**，不引入 TypeScript 或打包步骤。
- **`webSecurity` 保持 `true`。**
- **既有 `onHeadersReceived` 头注入必须保留且行为不变。** 它负责 GET 的跨域，中继不覆盖 GET。
- **`shouldInterceptUrl` 的公网限制不得放宽。**
- **协议主机名固定 `app://canvas`。**
- 现有 24 个测试必须全部继续通过。
- 工作目录：除非标注，均为 `lotus-canvas/desktop/`。测试命令 `npm test`。

## File Structure

| 文件 | 改动 | 职责 |
| --- | --- | --- |
| `desktop/src/cors.js` | 修改 | 新增 `corsHeaderEntries()` 供中继与既有注入共用 |
| `desktop/src/relay.js` | 新增 | 中继：判定、请求参数构造、Node https 执行 |
| `desktop/main.js` | 修改 | `protocol.handle("https")` 三路分发；移除菜单并补回快捷键 |
| `desktop/test/relay.test.js` | 新增 | `relay.js` 纯函数测试 |
| `desktop/test/cors.test.js` | 修改 | 追加 `corsHeaderEntries` 测试 |

---

### Task 1: CORS 头复用与中继纯函数

**Files:**
- Modify: `desktop/src/cors.js`
- Create: `desktop/src/relay.js`
- Test: `desktop/test/relay.test.js`（新增）、`desktop/test/cors.test.js`（追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `corsHeaderEntries() => { [name: string]: string }`（cors.js 新增导出，共 4 项）
  - `shouldRelay(method: string) => boolean`
  - `isPreflight(method: string) => boolean`
  - `buildRelayOptions(rawUrl: string, headers: Iterable<[string, string]>) => { protocol, hostname, port, path, headers }`
  - `DROPPED_RESPONSE_HEADERS: Set<string>`

- [ ] **Step 1: 在 `desktop/src/cors.js` 中新增 `corsHeaderEntries` 并让 `buildCorsResponse` 复用**

在 `ALLOW_METHODS` 常量之后插入：

```js
/** 四个 CORS 响应头的普通对象形式，供 buildCorsResponse 与主进程中继共用，避免两处各写一份 */
function corsHeaderEntries() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Allow-Methods": ALLOW_METHODS,
        "Access-Control-Expose-Headers": "*",
    };
}
```

把 `buildCorsResponse` 中逐条赋值的四行替换为：

```js
    for (const [name, value] of Object.entries(corsHeaderEntries())) {
        responseHeaders[name] = [value];
    }
```

并把 `module.exports` 改为：

```js
module.exports = { stripCorsHeaders, shouldInterceptUrl, buildCorsResponse, corsHeaderEntries };
```

不要改动 `isNonPublicHost`、`shouldInterceptUrl` 或 `stripCorsHeaders` 的任何逻辑。

- [ ] **Step 2: 在 `desktop/test/cors.test.js` 末尾追加测试**

```js
test("corsHeaderEntries 返回四个头且 Allow-Headers 显式包含 Authorization", () => {
    const { corsHeaderEntries } = require("../src/cors");
    const entries = corsHeaderEntries();
    assert.strictEqual(Object.keys(entries).length, 4);
    assert.strictEqual(entries["Access-Control-Allow-Origin"], "*");
    assert.strictEqual(entries["Access-Control-Expose-Headers"], "*");
    assert.ok(entries["Access-Control-Allow-Headers"].includes("Authorization"));
    assert.ok(entries["Access-Control-Allow-Methods"].includes("OPTIONS"));
});
```

- [ ] **Step 3: 写 `desktop/test/relay.test.js`（此时应失败）**

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { shouldRelay, isPreflight, buildRelayOptions } = require("../src/relay");

test("shouldRelay 只对 POST 为真", () => {
    assert.strictEqual(shouldRelay("POST"), true);
    assert.strictEqual(shouldRelay("post"), true);
    assert.strictEqual(shouldRelay("GET"), false);
    assert.strictEqual(shouldRelay("OPTIONS"), false);
    assert.strictEqual(shouldRelay("PUT"), false);
    assert.strictEqual(shouldRelay(undefined), false);
});

test("isPreflight 只对 OPTIONS 为真", () => {
    assert.strictEqual(isPreflight("OPTIONS"), true);
    assert.strictEqual(isPreflight("options"), true);
    assert.strictEqual(isPreflight("POST"), false);
    assert.strictEqual(isPreflight(undefined), false);
});

test("buildRelayOptions 剔除逐跳头、host 与 content-length", () => {
    const { headers } = buildRelayOptions("https://api.example.com/v1/x", [
        ["host", "api.example.com"],
        ["connection", "keep-alive"],
        ["keep-alive", "timeout=5"],
        ["transfer-encoding", "chunked"],
        ["upgrade", "h2c"],
        ["proxy-connection", "keep-alive"],
        ["te", "trailers"],
        ["trailer", "X-Foo"],
        ["content-length", "123"],
        ["authorization", "Bearer sk-test"],
        ["content-type", "application/json"],
    ]);
    assert.deepStrictEqual(headers, {
        authorization: "Bearer sk-test",
        "content-type": "application/json",
    });
});

test("buildRelayOptions 拆解 URL 且默认端口为 443", () => {
    const options = buildRelayOptions("https://api.example.com/v1/images/generations", []);
    assert.strictEqual(options.protocol, "https:");
    assert.strictEqual(options.hostname, "api.example.com");
    assert.strictEqual(options.port, 443);
    assert.strictEqual(options.path, "/v1/images/generations");
});

test("buildRelayOptions 保留显式端口与查询串", () => {
    const options = buildRelayOptions("https://api.example.com:8443/v1/models?limit=5&x=1", []);
    assert.strictEqual(options.port, "8443");
    assert.strictEqual(options.path, "/v1/models?limit=5&x=1");
});

test("buildRelayOptions 容忍空 headers", () => {
    assert.deepStrictEqual(buildRelayOptions("https://a.example.com/p", undefined).headers, {});
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，报错 `Cannot find module '../src/relay'`。

- [ ] **Step 5: 实现 `desktop/src/relay.js` 的纯函数部分**

```js
"use strict";

// 转发给上游时必须剔除的请求头。
// content-length 一并剔除：请求体由中继整体缓冲后重新写出，长度由中继自行设置，
// 沿用原值会在任何字节差异下造成上游解析错乱。
const DROPPED_REQUEST_HEADERS = new Set([
    "connection", "keep-alive", "transfer-encoding", "upgrade",
    "proxy-authorization", "proxy-connection", "te", "trailer",
    "host", "content-length",
]);

// 回传给渲染进程时必须剔除的响应头。content-length 剔除是因为响应体以流形式返回，
// 由 Response 自行处理长度；保留原值会在流被重新分块时不一致。
const DROPPED_RESPONSE_HEADERS = new Set([
    "connection", "keep-alive", "transfer-encoding", "upgrade", "trailer",
    "content-length",
]);

/** 是否走主进程中继。生成类调用均为 POST；GET 透传，其跨域由 onHeadersReceived 注入处理 */
function shouldRelay(method) {
    return String(method || "").toUpperCase() === "POST";
}

/** 是否为跨域预检请求 */
function isPreflight(method) {
    return String(method || "").toUpperCase() === "OPTIONS";
}

/** 由请求 URL 与请求头构造 Node https.request 的参数 */
function buildRelayOptions(rawUrl, headers) {
    const url = new URL(rawUrl);
    const outbound = {};
    for (const [name, value] of headers || []) {
        if (DROPPED_REQUEST_HEADERS.has(String(name).toLowerCase())) continue;
        outbound[name] = value;
    }
    return {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: outbound,
    };
}

module.exports = { shouldRelay, isPreflight, buildRelayOptions, DROPPED_RESPONSE_HEADERS };
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npm test
```

Expected: PASS，累计 31 个测试全绿（原 24 + 新增 7）。

- [ ] **Step 7: 提交**

工作目录 `lotus-canvas/`：

```bash
git add desktop/src/cors.js desktop/src/relay.js desktop/test/cors.test.js desktop/test/relay.test.js
git commit -m "feat(desktop): CORS 头复用与中继纯函数"
```

---

### Task 2: 中继执行与 https 接管

**Files:**
- Modify: `desktop/src/relay.js`（追加 `relayRequest`）
- Modify: `desktop/main.js`

**Interfaces:**
- Consumes: `shouldRelay`、`isPreflight`、`buildRelayOptions`、`DROPPED_RESPONSE_HEADERS`（Task 1）；`corsHeaderEntries`（Task 1）
- Produces: `relayRequest(request: Request) => Promise<Response>`

- [ ] **Step 1: 在 `desktop/src/relay.js` 顶部补充 require，并追加 `relayRequest`**

文件顶部 `"use strict";` 之后加入：

```js
const https = require("node:https");
const { Readable } = require("node:stream");

const { corsHeaderEntries } = require("./cors");

const RELAY_TIMEOUT_MS = 30 * 60 * 1000;
const KEEPALIVE_DELAY_MS = 15_000;
```

在 `module.exports` 之前加入：

```js
/**
 * 由主进程发起上游请求并返回 Web Response。
 *
 * 存在的唯一理由是 socket.setKeepAlive：生图期间连接上没有任何字节流动，
 * 中间层（网关 / NAT）会在约 100 秒后静默切断空闲连接，导致客户端收到 524，
 * 而上游照常算完并计费。定期 TCP keepalive 探测使连接在等待期间保持存活。
 * 浏览器环境无法控制该行为，因此这段必须在主进程执行。
 */
async function relayRequest(request) {
    const options = buildRelayOptions(request.url, request.headers);
    const bodyBuffer = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    if (bodyBuffer) options.headers["content-length"] = String(bodyBuffer.length);
    options.method = request.method;

    return await new Promise((resolve, reject) => {
        const upstream = https.request(options, (response) => {
            const headers = { ...corsHeaderEntries() };
            for (const [name, value] of Object.entries(response.headers)) {
                const lower = name.toLowerCase();
                if (DROPPED_RESPONSE_HEADERS.has(lower)) continue;
                if (lower.startsWith("access-control-")) continue;
                headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
            }
            // 流式回传：SSE 通道与大体积 base64 图片都不能整体缓冲
            resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers }));
        });

        upstream.on("socket", (socket) => socket.setKeepAlive(true, KEEPALIVE_DELAY_MS));
        upstream.setTimeout(RELAY_TIMEOUT_MS, () => {
            upstream.destroy(new Error(`上游 ${RELAY_TIMEOUT_MS / 60000} 分钟未响应`));
        });
        upstream.on("error", reject);

        if (bodyBuffer) upstream.end(bodyBuffer);
        else upstream.end();
    });
}
```

把 `module.exports` 改为：

```js
module.exports = { shouldRelay, isPreflight, buildRelayOptions, relayRequest, DROPPED_RESPONSE_HEADERS };
```

- [ ] **Step 2: 确认既有测试未被破坏**

```bash
npm test
```

Expected: PASS，31 个测试全绿。`relayRequest` 涉及真实网络，不做单元测试，由 Step 6 的端到端验证覆盖。

- [ ] **Step 3: 在 `desktop/main.js` 中接管 https**

在既有 `const { resolveAppAssetPath } = require("./src/app-protocol");` 之后追加：

```js
const { isPreflight, relayRequest, shouldRelay } = require("./src/relay");
```

并把既有的 cors require 一行**扩展**（不要新增第二行 require 同一模块）：

```js
const { buildCorsResponse, corsHeaderEntries, shouldInterceptUrl } = require("./src/cors");
```

注意：`registerCorsInterceptor` 整个函数不得改动。

在 `registerAppProtocol` 函数之后新增：

```js
function relayErrorResponse(error) {
    const message = error && error.message ? error.message : String(error);
    return new Response(JSON.stringify({ error: { message: `主进程中继失败：${message}` } }), {
        status: 502,
        headers: { ...corsHeaderEntries(), "Content-Type": "application/json; charset=utf-8" },
    });
}

// 接管 https：POST 由主进程发出以保持长连接存活，其余原样透传。
function registerHttpsRelay() {
    protocol.handle("https", async (request) => {
        try {
            if (isPreflight(request.method)) {
                return new Response(null, { status: 200, headers: corsHeaderEntries() });
            }
            if (shouldRelay(request.method)) {
                if (process.env.LOTUS_CORS_LOG === "1") console.log(`[relay] ${request.method} ${request.url}`);
                return await relayRequest(request);
            }
            return await net.fetch(request, { bypassCustomProtocolHandlers: true });
        } catch (error) {
            console.error("[relay] failed:", error);
            return relayErrorResponse(error);
        }
    });
}
```

在 `app.whenReady().then(...)` 中，`registerAppProtocol();` 之后加一行 `registerHttpsRelay();`。

- [ ] **Step 4: 启动应用确认三条路径都工作**

```powershell
$env:LOTUS_CORS_LOG = "1"; npm start
```

Expected: 窗口正常打开并渲染画布界面（说明 GET 透传未被破坏——页面资源走 `app://`，而插件与素材走 https GET 透传）。

- [ ] **Step 5: 验证预检是否进入处理器（设计文档已知限制第 4 条）**

打开开发者工具的 Network 面板，观察一次带 `Authorization` 的跨域请求。

记录结论：若未见 OPTIONS 发往网络，说明预检被本地应答；若见到 OPTIONS 并由 `[cors]` 日志改写 404 → 200，说明预检未进入 `protocol.handle`，走的是既有路径。**两种结果都不算失败**，如实写入报告即可。

- [ ] **Step 6: 端到端验证 —— 主验收线**

在应用内配置 wisart 渠道（Base URL `https://wisart.kuaileshifu.com`），执行一次生图。

Expected:
- 主进程日志出现 `[relay] POST https://wisart.kuaileshifu.com/v1/images/generations`
- **生图成功返回图片，不再出现 HTTP 524**

这是本增量存在的唯一理由。若仍然 524，不要标记 DONE，记录耗时与完整错误后报告 BLOCKED。

- [ ] **Step 7: 回归验证 —— 模型列表**

在同一渠道点击拉取模型列表。

Expected: 成功返回 `nano-banana-pro`、`nano-banana-2`、`nano-banana-2-lite`、`gpt-image-2`。这验证 GET 透传与既有 `onHeadersReceived` 注入未被 https 接管破坏。

- [ ] **Step 8: 提交**

```bash
git add desktop/src/relay.js desktop/main.js
git commit -m "feat(desktop): 主进程中继 POST，保持长连接存活以消除 524"
```

---

### Task 3: 隐藏菜单栏并补回开发者工具快捷键

**Files:**
- Modify: `desktop/main.js`

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 移除默认菜单**

把 `main.js` 顶部的 electron require 改为包含 `Menu`：

```js
const { app, BrowserWindow, Menu, net, protocol, session } = require("electron");
```

在 `app.whenReady().then(...)` 回调的第一行加入：

```js
    // 移除默认的 File / Edit / View / Window 菜单
    Menu.setApplicationMenu(null);
```

- [ ] **Step 2: 补回开发者工具快捷键**

默认菜单被移除后，`Ctrl+Shift+I` 与 `F12` 会一并失效——它们由菜单的 `toggleDevTools` 角色提供。开发者工具是排查网络问题的主要手段，必须补回。

在 `createWindow` 中 `win.loadURL(APP_ORIGIN);` 之前插入：

```js
    // 默认菜单被移除后，devtools 快捷键随之失效，这里显式补回
    win.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const isF12 = input.key === "F12";
        const isInspect = input.control && input.shift && input.key.toLowerCase() === "i";
        if (!isF12 && !isInspect) return;
        win.webContents.toggleDevTools();
        event.preventDefault();
    });
```

- [ ] **Step 3: 验证**

```bash
npm start
```

Expected:
- 窗口顶部不再有 File / Edit / View / Window 菜单栏
- 按 `F12` 能打开开发者工具，再按能关闭
- 按 `Ctrl+Shift+I` 同样能切换
- 在提示词输入框里 `Ctrl+C` / `Ctrl+V` 仍可用（Windows 上由 Chromium 原生处理，不依赖菜单；若实测失效，如实报告，不要自行改用其他方案）

- [ ] **Step 4: 提交**

```bash
git add desktop/main.js
git commit -m "feat(desktop): 隐藏默认菜单栏并补回 devtools 快捷键"
```

---

### Task 4: 重新打包与整体验收

**Files:** 无代码改动

- [ ] **Step 1: 重建前端产物（仅当 `web/dist` 不存在时）**

```bash
ls ../web/dist/index.html
```

存在则跳过。不存在则在 `lotus-canvas/web/` 执行 `npm ci && npm run build`；若 `npm ci` 因锁文件不同步失败，改用 `npm install`，随后立即 `git checkout -- web/package-lock.json` 还原并在报告中说明。

- [ ] **Step 2: 打包**

```bash
npm run build
```

Expected: `release/win-unpacked/` 重新生成。

- [ ] **Step 3: 确认打包产物含本次改动**

```bash
npx --yes asar extract-file release/win-unpacked/resources/app.asar src/relay.js relay-check.js && grep -c setKeepAlive relay-check.js && rm -f relay-check.js
```

注意：`asar extract-file` 会忽略目标路径参数，按 basename 写入当前工作目录，因此上面先提取到当前目录再删除。

Expected: 输出 `1` 或更大，证明中继代码已进包。

- [ ] **Step 4: 打包版整体验收**

运行 `release/win-unpacked/lotus-canvas.exe`，逐项确认：

1. 无菜单栏，`F12` 可开关开发者工具
2. wisart 渠道模型列表可拉取
3. wisart 渠道生图成功，无 524
4. `release/win-unpacked/data/` 仍在 exe 同级生成

- [ ] **Step 5: 确认工作区干净**

```bash
git status --short
```

Expected: 不含 `desktop/release/`、`desktop/data/`、`desktop/node_modules/`，也不含 `web/` 或仓库根目录的任何改动。

- [ ] **Step 6: 提交（若有文档更新）**

若实测结果与设计文档的「已知限制」第 4 条不符，更新该条后提交：

```bash
git add desktop/docs/
git commit -m "docs(desktop): 依实测更新预检行为结论"
```

## 完成标准

1. `npm test` —— 31 个测试全部通过
2. **wisart 渠道生图成功，不再出现 HTTP 524**（本增量的唯一存在理由）
3. 模型列表仍可正常拉取（回归）
4. 菜单栏消失，`F12` 与 `Ctrl+Shift+I` 可切换开发者工具
5. `git status` 中 `web/` 与仓库根目录无任何改动

## 后续可选事项（本计划不含）

- 若 WebDAV 同步（`PUT` / `PROPFIND`）将来出现同类超时，扩展 `shouldRelay`
- 若上游对 POST 返回 307/308，验证渲染进程的重定向跟随行为是否符合预期
