"use strict";

const https = require("node:https");
const { Readable } = require("node:stream");

const { corsHeaderEntries } = require("./cors");

const RELAY_TIMEOUT_MS = 30 * 60 * 1000;
const KEEPALIVE_DELAY_MS = 15_000;

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

/**
 * 路由决策。预检本地应答与 POST 中继都必须限制在公网主机：
 * 二者都会给响应打上宽松的 CORS 头，而渲染进程中运行着从 URL 加载的远程插件代码。
 * 若对内网主机也放行，插件即可借这些头读取内网服务——这正是 shouldInterceptUrl 要守住的边界。
 */
function relayDecision(method, isPublicHost) {
    if (isPreflight(method)) return isPublicHost ? "preflight" : "passthrough";
    if (shouldRelay(method)) return isPublicHost ? "relay" : "passthrough";
    return "passthrough";
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

module.exports = { shouldRelay, isPreflight, relayDecision, buildRelayOptions, relayRequest, DROPPED_RESPONSE_HEADERS };
