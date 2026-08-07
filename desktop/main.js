"use strict";

const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, net, protocol, session, shell, dialog } = require("electron");

const { buildCorsResponse, corsHeaderEntries, shouldInterceptUrl } = require("./src/cors");
const { isExternalUrl } = require("./src/external-navigation");
const { resolveAppAssetPath } = require("./src/app-protocol");
const { relayDecision, relayRequest } = require("./src/relay");
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
            const decision = relayDecision(request.method, shouldInterceptUrl(request.url));
            if (decision === "preflight") {
                return new Response(null, { status: 200, headers: corsHeaderEntries() });
            }
            if (decision === "relay") {
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

// 外部 http(s) 链接不放进壳内渲染：弹框询问，选是则交给系统默认浏览器，选否则取消跳转。
async function askOpenExternal(win, url) {
    const result = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["打开", "取消"],
        defaultId: 0,
        cancelId: 1,
        title: "打开外部链接",
        message: "是否使用系统默认浏览器打开？",
        detail: url,
    });
    if (result.response === 0) await shell.openExternal(url);
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
    // 前端 target="_blank" / window.open 的外链：拦截并由用户决定是否用默认浏览器打开；
    // 非外链维持 Electron 默认，避免改变壳内其它行为
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isExternalUrl(url)) {
            void askOpenExternal(win, url);
            return { action: "deny" };
        }
        return {};
    });
    // 默认菜单被移除后，devtools 快捷键随之失效，这里显式补回
    win.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const isF12 = input.key === "F12";
        const isInspect = input.control && input.shift && input.key.toLowerCase() === "i";
        if (!isF12 && !isInspect) return;
        win.webContents.toggleDevTools();
        event.preventDefault();
    });
    win.loadURL(APP_ORIGIN);
    return win;
}

app.whenReady().then(() => {
    // 移除默认的 File / Edit / View / Window 菜单
    Menu.setApplicationMenu(null);
    registerCorsInterceptor();
    registerAppProtocol();
    registerHttpsRelay();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
