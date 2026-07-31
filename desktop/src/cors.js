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
