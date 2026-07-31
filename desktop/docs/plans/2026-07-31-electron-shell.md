# lotus-canvas Electron 桌面套壳 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 infinite-canvas 加一层 Electron 桌面壳，通过主进程改写响应头消除中转站跨域限制，前端 `web/` 零改动。

**Architecture:** 新增 `desktop/` 目录，主进程用 `session.webRequest.onHeadersReceived` 删除并重注入 `Access-Control-*` 头、对非 2xx 预检改写状态行；用 `app://canvas` 自定义标准协议加载 `web/dist`，使 `createBrowserRouter` 正常工作。全部业务逻辑抽成无 Electron 依赖的纯函数以便单元测试，`main.js` 只做接线。

**Tech Stack:** Electron 43.2.0、electron-builder 26.15.3、Node v24.18.0 内置测试运行器（`node:test` + `node:assert`）、CommonJS、无构建步骤。

设计依据：`desktop/docs/specs/2026-07-31-electron-shell-design.md`

## Global Constraints

- **`web/` 零改动。** 任何任务都不得修改 `web/` 下任何文件。这是上游可持续同步的前提。
- **仓库根目录零改动。** 新增的忽略规则写入 `desktop/.gitignore`，不改根 `.gitignore`。
- **bun 未安装。** 设计文档中所有 `bun` 命令一律改用 `npm`（本机 Node v24.18.0 / npm 11.16.0，`web/package-lock.json` 已存在）。
- **协议主机名固定为 `app://canvas`。** 它构成 origin，一经写入不可更改，否则 IndexedDB 视为不同来源，已有画布与素材全部读不到。
- **模块格式 CommonJS**（`require` / `module.exports`），不引入 TypeScript 或打包步骤。
- **不新增测试依赖。** 一律使用 Node 内置 `node:test` 与 `node:assert`。
- **`webSecurity` 保持 `true`。** 不得使用 `webSecurity: false`。
- **拦截器所有分支必须调用 `callback()`**，含 catch 分支。漏调会使请求永久挂起且无任何报错。
- 所有命令的工作目录：除非显式标注，均为 `lotus-canvas/desktop/`。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `desktop/package.json` | 依赖、脚本入口 |
| `desktop/.gitignore` | 忽略 `node_modules/`、`release/`、`data/` |
| `desktop/builder.yml` | electron-builder 打包配置（`dir` 目标 + `extraResources` 纳入 `web/dist`） |
| `desktop/main.js` | 仅接线：注册协议与拦截器、创建窗口、生命周期 |
| `desktop/src/cors.js` | 纯函数：CORS 头去重、注入、预检状态行改写 |
| `desktop/src/app-protocol.js` | 纯函数：`app://` 路径 → dist 文件路径，含 SPA 兜底与路径穿越防护 |
| `desktop/src/paths.js` | 纯函数：dist 目录与用户数据目录解析（区分打包态） |
| `desktop/test/cors.test.js` | `cors.js` 单元测试 |
| `desktop/test/app-protocol.test.js` | `app-protocol.js` 单元测试 |
| `desktop/test/paths.test.js` | `paths.js` 单元测试 |

`main.js` 无法单元测试（依赖 Electron 运行时），由 Task 4、5 的手工验收覆盖。

---

### Task 1: 脚手架与 CORS 拦截逻辑

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/.gitignore`
- Create: `desktop/src/cors.js`
- Test: `desktop/test/cors.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `stripCorsHeaders(responseHeaders: object) => object`
  - `shouldInterceptUrl(url: string) => boolean`
  - `buildCorsResponse(details: {method: string, statusCode: number, responseHeaders: object}) => {responseHeaders: object, statusLine?: string}`

- [ ] **Step 1: 创建 `desktop/package.json`**

```json
{
    "name": "lotus-canvas-desktop",
    "version": "0.1.0",
    "private": true,
    "description": "Electron 桌面套壳，通过主进程改写响应头消除中转站跨域限制",
    "main": "main.js",
    "scripts": {
        "start": "electron .",
        "test": "node --test test/",
        "build": "electron-builder --config builder.yml"
    },
    "devDependencies": {
        "electron": "43.2.0",
        "electron-builder": "26.15.3"
    }
}
```

- [ ] **Step 2: 创建 `desktop/.gitignore`**

```
node_modules/
release/
data/
```

- [ ] **Step 3: 安装依赖**

工作目录 `lotus-canvas/desktop/`：

```bash
npm install
```

Expected: 安装完成，生成 `desktop/node_modules/` 与 `desktop/package-lock.json`。首次下载 Electron 二进制约 100MB，耗时数分钟属正常。

- [ ] **Step 4: 写失败测试 `desktop/test/cors.test.js`**

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { stripCorsHeaders, shouldInterceptUrl, buildCorsResponse } = require("../src/cors");

test("stripCorsHeaders 移除任意大小写的 Access-Control-* 头", () => {
    const input = {
        "Access-Control-Allow-Origin": ["https://example.com"],
        "access-control-allow-methods": ["GET"],
        "ACCESS-CONTROL-EXPOSE-HEADERS": ["X-Foo"],
        "Content-Type": ["application/json"],
    };
    assert.deepStrictEqual(stripCorsHeaders(input), { "Content-Type": ["application/json"] });
});

test("stripCorsHeaders 容忍 undefined 输入", () => {
    assert.deepStrictEqual(stripCorsHeaders(undefined), {});
});

test("shouldInterceptUrl 只拦截 http/https", () => {
    assert.strictEqual(shouldInterceptUrl("https://api.example.com/v1/models"), true);
    assert.strictEqual(shouldInterceptUrl("http://api.example.com/v1/models"), true);
    assert.strictEqual(shouldInterceptUrl("app://canvas/index.html"), false);
    assert.strictEqual(shouldInterceptUrl("devtools://devtools/bundled/x.js"), false);
    assert.strictEqual(shouldInterceptUrl(undefined), false);
});

test("buildCorsResponse 注入四个 CORS 头，Allow-Headers 显式包含 Authorization", () => {
    const { responseHeaders } = buildCorsResponse({ method: "POST", statusCode: 200, responseHeaders: {} });
    assert.deepStrictEqual(responseHeaders["Access-Control-Allow-Origin"], ["*"]);
    assert.deepStrictEqual(responseHeaders["Access-Control-Expose-Headers"], ["*"]);
    assert.ok(responseHeaders["Access-Control-Allow-Headers"][0].includes("Authorization"));
    assert.ok(responseHeaders["Access-Control-Allow-Methods"][0].includes("OPTIONS"));
});

test("buildCorsResponse 不产生重复的 CORS 头", () => {
    const { responseHeaders } = buildCorsResponse({
        method: "GET",
        statusCode: 200,
        responseHeaders: { "access-control-allow-origin": ["https://other.example"] },
    });
    const names = Object.keys(responseHeaders).filter((n) => n.toLowerCase() === "access-control-allow-origin");
    assert.strictEqual(names.length, 1);
    assert.deepStrictEqual(responseHeaders[names[0]], ["*"]);
});

test("buildCorsResponse 对 404 预检改写状态行为 200", () => {
    const result = buildCorsResponse({ method: "OPTIONS", statusCode: 404, responseHeaders: {} });
    assert.strictEqual(result.statusLine, "HTTP/1.1 200 OK");
});

test("buildCorsResponse 对 405 预检同样改写状态行", () => {
    const result = buildCorsResponse({ method: "OPTIONS", statusCode: 405, responseHeaders: {} });
    assert.strictEqual(result.statusLine, "HTTP/1.1 200 OK");
});

test("buildCorsResponse 对已是 2xx 的预检不改写状态行", () => {
    const result = buildCorsResponse({ method: "OPTIONS", statusCode: 204, responseHeaders: {} });
    assert.strictEqual(result.statusLine, undefined);
});

test("buildCorsResponse 对非预检请求不改写状态行", () => {
    const result = buildCorsResponse({ method: "POST", statusCode: 404, responseHeaders: {} });
    assert.strictEqual(result.statusLine, undefined);
});

test("buildCorsResponse 保留上游业务响应头", () => {
    const { responseHeaders } = buildCorsResponse({
        method: "POST",
        statusCode: 200,
        responseHeaders: { "Content-Type": ["application/json"] },
    });
    assert.deepStrictEqual(responseHeaders["Content-Type"], ["application/json"]);
});
```

- [ ] **Step 5: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，报错 `Cannot find module '../src/cors'`。

- [ ] **Step 6: 实现 `desktop/src/cors.js`**

```js
"use strict";

const CORS_HEADER_PREFIX = "access-control-";

// Fetch 规范中 Access-Control-Allow-Headers 的 `*` 通配符不覆盖 Authorization，必须显式列出
const ALLOW_HEADERS = "Authorization, Content-Type, Accept, x-goog-api-key, *";
const ALLOW_METHODS = "GET, POST, PUT, DELETE, PATCH, OPTIONS";

/** 按大小写不敏感移除所有 Access-Control-* 响应头，避免与上游自带的 CORS 头重复 */
function stripCorsHeaders(responseHeaders) {
    const result = {};
    for (const [name, value] of Object.entries(responseHeaders || {})) {
        if (name.toLowerCase().startsWith(CORS_HEADER_PREFIX)) continue;
        result[name] = value;
    }
    return result;
}

/** 仅拦截外部 http/https，跳过 app:// 与 devtools:// 等应用自身请求 */
function shouldInterceptUrl(url) {
    return /^https?:\/\//i.test(String(url || ""));
}

/** 构造 onHeadersReceived 的响应对象；预检非 2xx 时改写状态行 */
function buildCorsResponse(details) {
    const responseHeaders = stripCorsHeaders(details.responseHeaders);
    responseHeaders["Access-Control-Allow-Origin"] = ["*"];
    responseHeaders["Access-Control-Allow-Headers"] = [ALLOW_HEADERS];
    responseHeaders["Access-Control-Allow-Methods"] = [ALLOW_METHODS];
    responseHeaders["Access-Control-Expose-Headers"] = ["*"];

    const isPreflight = String(details.method || "").toUpperCase() === "OPTIONS";
    const statusCode = Number(details.statusCode);
    if (isPreflight && !(statusCode >= 200 && statusCode < 300)) {
        return { responseHeaders, statusLine: "HTTP/1.1 200 OK" };
    }
    return { responseHeaders };
}

module.exports = { stripCorsHeaders, shouldInterceptUrl, buildCorsResponse };
```

- [ ] **Step 7: 运行测试确认通过**

```bash
npm test
```

Expected: PASS，10 个测试全绿。

- [ ] **Step 8: 提交**

工作目录 `lotus-canvas/`：

```bash
git add desktop/
git commit -m "feat(desktop): CORS 拦截纯函数与项目骨架"
```

---

### Task 2: `app://` 资源路径解析

**Files:**
- Create: `desktop/src/app-protocol.js`
- Test: `desktop/test/app-protocol.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `resolveAppAssetPath(pathname: string, distDir: string, exists?: (p: string) => boolean) => string`
  返回 dist 内的绝对文件路径。`exists` 默认为 `fs.existsSync`，测试时注入以避免真实文件系统依赖。

- [ ] **Step 1: 写失败测试 `desktop/test/app-protocol.test.js`**

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { resolveAppAssetPath } = require("../src/app-protocol");

const DIST = path.resolve(__dirname, "fixture-dist");
const INDEX = path.join(DIST, "index.html");
const always = () => true;
const never = () => false;

test("根路径返回 index.html", () => {
    assert.strictEqual(resolveAppAssetPath("/", DIST, always), INDEX);
});

test("SPA 路由（无扩展名）返回 index.html", () => {
    assert.strictEqual(resolveAppAssetPath("/canvas/abc123", DIST, always), INDEX);
});

test("存在的静态资源返回真实路径", () => {
    assert.strictEqual(resolveAppAssetPath("/assets/app.js", DIST, always), path.join(DIST, "assets", "app.js"));
});

test("不存在的静态资源回退 index.html", () => {
    assert.strictEqual(resolveAppAssetPath("/assets/missing.js", DIST, never), INDEX);
});

test("路径穿越被拦截", () => {
    assert.strictEqual(resolveAppAssetPath("/../../secret.txt", DIST, always), INDEX);
    assert.strictEqual(resolveAppAssetPath("/assets/../../../secret.txt", DIST, always), INDEX);
});

test("URL 编码路径被正确解码", () => {
    assert.strictEqual(resolveAppAssetPath("/assets/my%20app.js", DIST, always), path.join(DIST, "assets", "my app.js"));
});

test("非法百分号编码回退 index.html", () => {
    assert.strictEqual(resolveAppAssetPath("/%E0%A4%A", DIST, always), INDEX);
});

test("空 pathname 回退 index.html", () => {
    assert.strictEqual(resolveAppAssetPath("", DIST, always), INDEX);
    assert.strictEqual(resolveAppAssetPath(undefined, DIST, always), INDEX);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，报错 `Cannot find module '../src/app-protocol'`。

- [ ] **Step 3: 实现 `desktop/src/app-protocol.js`**

```js
"use strict";

const path = require("node:path");
const fs = require("node:fs");

/**
 * 把 app://canvas/<pathname> 映射到 dist 内的绝对文件路径。
 * 以下情况一律回退 index.html：根路径、无扩展名（SPA 路由）、解码失败、路径穿越、文件不存在。
 * net.fetch(file://) 本身不做路径穿越校验，防护必须在这里完成。
 */
function resolveAppAssetPath(pathname, distDir, exists = fs.existsSync) {
    const indexFile = path.join(distDir, "index.html");

    let decoded;
    try {
        decoded = decodeURIComponent(String(pathname || "/"));
    } catch {
        return indexFile;
    }

    const relative = decoded.replace(/^[/\\]+/, "");
    if (relative === "") return indexFile;

    const target = path.resolve(distDir, relative);
    const inside = path.relative(distDir, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return indexFile;

    if (!path.extname(target)) return indexFile;
    if (!exists(target)) return indexFile;
    return target;
}

module.exports = { resolveAppAssetPath };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test
```

Expected: PASS，累计 18 个测试全绿。

- [ ] **Step 5: 提交**

工作目录 `lotus-canvas/`：

```bash
git add desktop/
git commit -m "feat(desktop): app:// 资源路径解析与穿越防护"
```

---

### Task 3: 运行态目录解析

**Files:**
- Create: `desktop/src/paths.js`
- Test: `desktop/test/paths.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `resolveDistDir({isPackaged: boolean, resourcesPath: string, appDir: string}) => string`
  - `resolveUserDataDir({isPackaged: boolean, exePath: string, appDir: string}) => string`

**说明（相对设计文档的细化）：** 设计文档只写了打包态的便携数据目录。未打包运行时 `app.getPath("exe")` 指向 `node_modules/electron/dist/electron.exe`，数据会落进 `node_modules` 且会被重装依赖清除。因此未打包态改用 `desktop/data/`（已在 `.gitignore` 中）。两种形态 origin 均为 `app://canvas`，仅数据目录不同；日常使用的打包版始终只有一份数据。

- [ ] **Step 1: 写失败测试 `desktop/test/paths.test.js`**

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { resolveDistDir, resolveUserDataDir } = require("../src/paths");

test("打包态 dist 位于 resources/dist", () => {
    const result = resolveDistDir({
        isPackaged: true,
        resourcesPath: path.join("C:", "app", "resources"),
        appDir: path.join("C:", "app", "resources", "app.asar"),
    });
    assert.strictEqual(result, path.join("C:", "app", "resources", "dist"));
});

test("未打包态 dist 位于 ../web/dist", () => {
    const appDir = path.join("D:", "repo", "desktop");
    const result = resolveDistDir({ isPackaged: false, resourcesPath: "ignored", appDir });
    assert.strictEqual(result, path.join("D:", "repo", "web", "dist"));
});

test("打包态用户数据位于 exe 同级 data", () => {
    const result = resolveUserDataDir({
        isPackaged: true,
        exePath: path.join("E:", "green", "lotus-canvas.exe"),
        appDir: "ignored",
    });
    assert.strictEqual(result, path.join("E:", "green", "data"));
});

test("未打包态用户数据位于 desktop/data", () => {
    const appDir = path.join("D:", "repo", "desktop");
    const result = resolveUserDataDir({ isPackaged: false, exePath: "ignored", appDir });
    assert.strictEqual(result, path.join("D:", "repo", "desktop", "data"));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，报错 `Cannot find module '../src/paths'`。

- [ ] **Step 3: 实现 `desktop/src/paths.js`**

```js
"use strict";

const path = require("node:path");

/** 前端构建产物目录：打包态在 resources/dist，未打包时在仓库的 web/dist */
function resolveDistDir({ isPackaged, resourcesPath, appDir }) {
    return isPackaged ? path.join(resourcesPath, "dist") : path.join(appDir, "..", "web", "dist");
}

/**
 * 用户数据目录。
 * 打包态放 exe 同级 data/，整个绿色文件夹可拷走迁移。
 * 未打包态放 desktop/data/，避免写进 node_modules 被重装清除。
 */
function resolveUserDataDir({ isPackaged, exePath, appDir }) {
    return isPackaged ? path.join(path.dirname(exePath), "data") : path.join(appDir, "data");
}

module.exports = { resolveDistDir, resolveUserDataDir };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test
```

Expected: PASS，累计 22 个测试全绿。

- [ ] **Step 5: 提交**

工作目录 `lotus-canvas/`：

```bash
git add desktop/
git commit -m "feat(desktop): 运行态目录解析"
```

---

### Task 4: 主进程接线与开发态验收

**Files:**
- Create: `desktop/main.js`
- 依赖产物: `web/dist`（由前端构建生成，不纳入版本控制）

**Interfaces:**
- Consumes:
  - `require("./src/cors")` → `buildCorsResponse`、`shouldInterceptUrl`
  - `require("./src/app-protocol")` → `resolveAppAssetPath`
  - `require("./src/paths")` → `resolveDistDir`、`resolveUserDataDir`
- Produces: 可运行的桌面应用（未打包态）

- [ ] **Step 1: 构建前端产物**

工作目录 `lotus-canvas/web/`：

```bash
npm ci
npm run build
```

Expected: 生成 `web/dist/index.html` 与 `web/dist/assets/`。首次执行耗时较长属正常。

**必须用 `npm ci` 而非 `npm install`。** `npm install` 可能改写 `web/package-lock.json`，那会违反「`web/` 零改动」约束并在同步上游时产生冲突；`npm ci` 严格按锁文件安装，从不写回。

若 `npm ci` 因锁文件与 `package.json` 不同步而报错，改用 `npm install`，随后立即执行 `git checkout -- web/package-lock.json` 还原锁文件，并在任务报告中说明。

本步骤只读取 `web/` 源码、只写入被 git 忽略的 `web/dist` 与 `web/node_modules`，符合零改动约束。

- [ ] **Step 2: 确认构建产物存在**

工作目录 `lotus-canvas/`：

```bash
ls web/dist/index.html
```

Expected: 文件存在。若不存在，不要继续，先排查前端构建。

- [ ] **Step 3: 实现 `desktop/main.js`**

```js
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, net, protocol, session } = require("electron");

const { buildCorsResponse, shouldInterceptUrl } = require("./src/cors");
const { resolveAppAssetPath } = require("./src/app-protocol");
const { resolveDistDir, resolveUserDataDir } = require("./src/paths");

const APP_SCHEME = "app";
// 主机名 canvas 构成 origin，不可更改：改动后 IndexedDB 视为不同来源，画布与素材将全部读不到
const APP_ORIGIN = "app://canvas/";

// 必须在 app ready 之前注册。standard 让 History API 可用（前端使用 createBrowserRouter）；
// secure 提供安全上下文，IndexedDB 与 crypto.subtle 才可用
protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
]);

// 必须在任何 session 创建之前调用
app.setPath(
    "userData",
    resolveUserDataDir({ isPackaged: app.isPackaged, exePath: app.getPath("exe"), appDir: __dirname }),
);

const DIST_DIR = resolveDistDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: __dirname,
});

function registerCorsInterceptor() {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        try {
            if (!shouldInterceptUrl(details.url)) {
                callback({});
                return;
            }
            const result = buildCorsResponse(details);
            if (process.env.LOTUS_CORS_LOG === "1") {
                const rewritten = result.statusLine ? " -> 200" : "";
                console.log(`[cors] ${details.method} ${details.statusCode}${rewritten} ${details.url}`);
            }
            callback(result);
        } catch (error) {
            // 所有分支都必须调用 callback，漏调会让该请求永久挂起且无任何报错
            console.error("[cors] interceptor failed:", error);
            callback({});
        }
    });
}

function registerAppProtocol() {
    protocol.handle(APP_SCHEME, (request) => {
        const { pathname } = new URL(request.url);
        const filePath = resolveAppAssetPath(pathname, DIST_DIR);
        return net.fetch(pathToFileURL(filePath).toString());
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1600,
        height: 1000,
        show: false,
        webPreferences: {
            webSecurity: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.once("ready-to-show", () => win.show());
    win.loadURL(APP_ORIGIN);
    return win;
}

app.whenReady().then(() => {
    registerCorsInterceptor();
    registerAppProtocol();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 4: 启动应用并开启拦截日志**

工作目录 `lotus-canvas/desktop/`（PowerShell）：

```powershell
$env:LOTUS_CORS_LOG = "1"; npm start
```

Expected: 窗口打开并显示 infinite-canvas 画布界面。若白屏，打开开发者工具（`Ctrl+Shift+I`）查看 Console，重点排查资源 404 与协议注册。

- [ ] **Step 5: 确认目标中转站确实无 CORS（验收前提）**

在另一个终端执行，`<BASE_URL>` 替换为当前实际启用的中转站地址：

```bash
curl -s -o /dev/null -D - -X OPTIONS "<BASE_URL>/models" \
  -H "Origin: https://canvas.best" -H "Access-Control-Request-Method: POST" \
  | grep -ic access-control
```

Expected: 输出 `0` —— 该站确无 CORS 头，适合作为验收目标。
若输出大于 `0`，该站本身支持 CORS，用它验收属于空验证（不套壳也能通），必须换一个输出为 `0` 的中转站作为验收目标。

- [ ] **Step 6: 端到端验收 —— 模型列表拉通**

在应用内打开配置弹窗，填入 Step 5 中确认过的中转站 Base URL 与 API Key，触发模型列表拉取。

Expected:
- 模型列表成功返回并显示
- 终端日志出现该站 `/models` 的 `OPTIONS` 记录，且带 `-> 200` 标记（表示非 2xx 预检被改写）

这是**本阶段的主验收线**。模型列表能拉出即证明拦截生效——该站在网页版连模型列表都拉不到。

- [ ] **Step 7: 回归验收 —— 原本正常的中转站未被破坏**

切换到一个 Step 5 检查中输出大于 `0`（即本身支持 CORS、在网页版一直正常）的中转站，重新拉取模型列表。

Expected: 同样正常返回。这验证了 `stripCorsHeaders` 的「先删后加」逻辑没有产生重复头、没有破坏原本正常的站点。

- [ ] **Step 8: 提交**

工作目录 `lotus-canvas/`：

```bash
git add desktop/
git commit -m "feat(desktop): 主进程接线，跨域拦截与 app 协议生效"
```

---

### Task 5: 绿色文件夹打包与便携数据验收

**Files:**
- Create: `desktop/builder.yml`

**Interfaces:**
- Consumes: Task 4 产出的 `main.js`、`src/*`，以及 `web/dist`
- Produces: `desktop/release/win-unpacked/` 绿色文件夹

- [ ] **Step 1: 创建 `desktop/builder.yml`**

```yaml
appId: app.lotuscanvas.desktop
productName: lotus-canvas
directories:
  output: release
files:
  - main.js
  - src/**/*
  - package.json
extraResources:
  - from: ../web/dist
    to: dist
win:
  target:
    - dir
```

`extraResources` 把仓库外层的 `web/dist` 复制进 `resources/dist`，与 `resolveDistDir` 的打包态分支对应。`target: dir` 产出免安装绿色文件夹，不生成安装器。

- [ ] **Step 2: 执行打包**

工作目录 `lotus-canvas/desktop/`：

```bash
npm run build
```

Expected: 生成 `desktop/release/win-unpacked/`，其中含 `lotus-canvas.exe` 与 `resources/dist/`。

- [ ] **Step 3: 确认前端产物已进包**

```bash
ls release/win-unpacked/resources/dist/index.html
```

Expected: 文件存在。若缺失，检查 `builder.yml` 的 `extraResources` 路径与 `web/dist` 是否已构建。

- [ ] **Step 4: 运行打包版并验收便携数据**

双击 `desktop/release/win-unpacked/lotus-canvas.exe`。

Expected:
- 窗口正常打开并显示画布界面
- 配置中转站后模型列表可拉取（同 Task 4 Step 6 的主验收线）
- 在应用内新建一个画布项目后关闭应用，`release/win-unpacked/data/` 目录出现，内含 IndexedDB 数据

`data/` 出现在 exe 同级即证明便携数据配置生效，整个 `win-unpacked/` 文件夹可拷走迁移。

- [ ] **Step 5: 确认打包产物未进版本控制**

工作目录 `lotus-canvas/`：

```bash
git status --short
```

Expected: 输出中不含 `desktop/release/`、`desktop/data/`、`desktop/node_modules/`。若出现，检查 `desktop/.gitignore`。

- [ ] **Step 6: 提交**

```bash
git add desktop/
git commit -m "feat(desktop): electron-builder 绿色文件夹打包配置"
```

---

## 完成标准

全部任务完成后应满足：

1. `cd desktop && npm test` —— 22 个单元测试全部通过
2. 打包版 `lotus-canvas.exe` 双击可运行，画布界面正常
3. **主验收线**：一个经 `curl` 确认无 CORS 头的中转站，在应用内模型列表可正常拉取
4. **回归验收**：一个本身支持 CORS 的中转站仍正常工作
5. `data/` 目录生成在 exe 同级，整个文件夹可迁移
6. `git status` 中 `web/` 与仓库根目录文件无任何改动

## 后续可选事项（本计划不含）

- 实际生成图片的业务验证（涉及计费，由使用者自行执行）
- 若将来遇到「丢弃 OPTIONS 连接」的中转站，按设计文档「已知限制」第 1 条实现主进程 `protocol.handle` 接管 https 的退路
- 若 WebDAV 同步出现凭据相关问题，按「已知限制」第 2 条把 `Access-Control-Allow-Origin: *` 改为回显 `Origin` 并添加 `Access-Control-Allow-Credentials: true`
