"use strict";

const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, Menu, net, protocol, session, shell, dialog, ipcMain } = require("electron");

const { buildCorsResponse, corsHeaderEntries, shouldInterceptUrl } = require("./src/cors");
const { isExternalUrl } = require("./src/external-navigation");
const { resolveAppAssetPath } = require("./src/app-protocol");
const { MediaLibrary } = require("./src/media-library");
const { createMediaProtocolHandler } = require("./src/media-protocol");
const { relayDecision, relayRequest } = require("./src/relay");
const { isPortableRuntime, resolveDistDir, resolveLibraryDir, resolveUserDataDir } = require("./src/paths");

let autoUpdater;
try {
    ({ autoUpdater } = require("electron-updater"));
} catch {
    autoUpdater = null;
}

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

const PORTABLE = isPortableRuntime({ isPackaged: app.isPackaged, exePath: app.getPath("exe") });

// 必须在任何 session 创建之前调用
app.setPath(
    "userData",
    resolveUserDataDir({ isPackaged: app.isPackaged, portable: PORTABLE, exePath: app.getPath("exe"), appDir: __dirname, appDataPath: app.getPath("appData") }),
);

const DIST_DIR = resolveDistDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: __dirname,
});
let mediaLibrary;
let handleMediaRequest;
let mainWindow;
let updateState = { status: "idle" };
const DESKTOP_RELEASE_REPOSITORY = "https://github.com/Ink-lotus/infinite-canvas/releases/download";

const MEDIA_LIBRARY_CONFIG = "media-library.json";

async function readMediaLibraryPath() {
    if (PORTABLE) return resolveLibraryDir(app.getPath("userData"));
    const configPath = path.join(app.getPath("userData"), MEDIA_LIBRARY_CONFIG);
    try {
        const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
        if (typeof parsed.path === "string" && parsed.path.trim()) return path.resolve(parsed.path);
    } catch {
        // First run or an invalid config falls back to the app data directory.
    }
    return resolveLibraryDir(app.getPath("userData"));
}

async function saveMediaLibraryPath(rootPath) {
    const configPath = path.join(app.getPath("userData"), MEDIA_LIBRARY_CONFIG);
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, `${JSON.stringify({ path: rootPath }, null, 2)}\n`, "utf8");
}

async function initializeMediaLibrary() {
    let rootPath = await readMediaLibraryPath();
    if (app.isPackaged && !PORTABLE && !fs.existsSync(path.join(app.getPath("userData"), MEDIA_LIBRARY_CONFIG))) {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
        if (!result.canceled && result.filePaths[0]) rootPath = path.resolve(result.filePaths[0]);
        await saveMediaLibraryPath(rootPath);
    }
    mediaLibrary = new MediaLibrary(rootPath);
    handleMediaRequest = createMediaProtocolHandler({ library: mediaLibrary, shell });
}

function sendUpdateState(next) {
    updateState = { ...updateState, ...next };
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:update-state", updateState);
}

function configureUpdater() {
    if (!autoUpdater || !app.isPackaged || PORTABLE) return;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("checking-for-update", () => sendUpdateState({ status: "checking" }));
    autoUpdater.on("update-available", (info) => sendUpdateState({ status: "available", version: info.version }));
    autoUpdater.on("update-not-available", (info) => sendUpdateState({ status: "not-available", version: info.version }));
    autoUpdater.on("download-progress", (progress) => sendUpdateState({ status: "downloading", percent: progress.percent, bytesPerSecond: progress.bytesPerSecond, transferred: progress.transferred, total: progress.total }));
    autoUpdater.on("update-downloaded", (info) => sendUpdateState({ status: "downloaded", version: info.version, percent: 100 }));
    autoUpdater.on("error", (error) => sendUpdateState({ status: "error", message: error?.message || String(error) }));
}

function registerDesktopIpc() {
    ipcMain.handle("desktop:get-app-info", () => ({ isDesktop: true, portable: PORTABLE, version: app.getVersion(), updateSupported: Boolean(autoUpdater && app.isPackaged && !PORTABLE) }));
    ipcMain.handle("desktop:get-media-library-path", () => mediaLibrary.rootDir);
    ipcMain.handle("desktop:select-media-library", async () => {
        if (PORTABLE) return mediaLibrary.rootDir;
        const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
        if (result.canceled || !result.filePaths[0]) return null;
        const rootPath = path.resolve(result.filePaths[0]);
        mediaLibrary = new MediaLibrary(rootPath);
        handleMediaRequest = createMediaProtocolHandler({ library: mediaLibrary, shell });
        await saveMediaLibraryPath(rootPath);
        return rootPath;
    });
    ipcMain.handle("desktop:check-for-updates", async (_event, releaseTag) => {
        if (!autoUpdater || PORTABLE || !app.isPackaged) return null;
        if (typeof releaseTag === "string" && /^desktop-v\\d+\\.\\d+\\.\\d+$/.test(releaseTag)) {
            autoUpdater.setFeedURL({ provider: "generic", url: `${DESKTOP_RELEASE_REPOSITORY}/${releaseTag}/` });
        }
        const result = await autoUpdater.checkForUpdates();
        return { ...updateState, version: result?.updateInfo?.version };
    });
    ipcMain.handle("desktop:download-update", async () => {
        if (!autoUpdater || PORTABLE || !app.isPackaged) return null;
        await autoUpdater.downloadUpdate();
        return updateState;
    });
    ipcMain.handle("desktop:quit-and-install", () => {
        if (autoUpdater && updateState.status === "downloaded") autoUpdater.quitAndInstall(false, true);
    });
}

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
    protocol.handle(APP_SCHEME, async (request) => {
        const mediaResponse = handleMediaRequest ? await handleMediaRequest(request) : null;
        if (mediaResponse) return mediaResponse;
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
            preload: path.join(__dirname, "preload.js"),
        },
    });
    mainWindow = win;
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
    registerDesktopIpc();
    configureUpdater();
    return initializeMediaLibrary();
}).then(() => {
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
