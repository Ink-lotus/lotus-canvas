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

/**
 * 判断主机名是否属于回环、私网、链路本地或其他非公网地址。
 * 注意：这是基于主机名的判断，不做 DNS 解析，因此无法防御指向内网 IP 的域名（DNS rebinding）。
 */
function isNonPublicHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    if (host === "") return true;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1" || host === "::" || host === "0.0.0.0") return true;

    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const first = Number(ipv4[1]);
        const second = Number(ipv4[2]);
        if (first === 0 || first === 127 || first === 10) return true;
        if (first === 172 && second >= 16 && second <= 31) return true;
        if (first === 192 && second === 168) return true;
        if (first === 169 && second === 254) return true;
        if (first === 100 && second >= 64 && second <= 127) return true;
    }
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    if (/^fe80:/.test(host)) return true;
    return false;
}

/**
 * 仅拦截指向公网的 http/https 请求。
 * 回环与内网地址一律跳过：前端插件系统会加载并执行远程 JS，
 * 若对这些地址也注入 CORS 头，等于让第三方插件代码获得读取本机与内网服务的能力。
 */
function shouldInterceptUrl(url) {
    let parsed;
    try {
        parsed = new URL(String(url || ""));
    } catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return !isNonPublicHost(parsed.hostname);
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
