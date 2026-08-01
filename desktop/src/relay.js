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
