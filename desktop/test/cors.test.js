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

test("shouldInterceptUrl 跳过回环与内网地址", () => {
    assert.strictEqual(shouldInterceptUrl("http://localhost:3000/v1/models"), false);
    assert.strictEqual(shouldInterceptUrl("http://127.0.0.1:8080/v1"), false);
    assert.strictEqual(shouldInterceptUrl("http://0.0.0.0/v1"), false);
    assert.strictEqual(shouldInterceptUrl("http://10.0.0.1/v1"), false);
    assert.strictEqual(shouldInterceptUrl("http://172.16.0.1/v1"), false);
    assert.strictEqual(shouldInterceptUrl("http://192.168.1.5/v1"), false);
    assert.strictEqual(shouldInterceptUrl("http://169.254.169.254/latest/meta-data"), false);
    assert.strictEqual(shouldInterceptUrl("http://[::1]:3000/v1"), false);
    assert.strictEqual(shouldInterceptUrl("https://100.64.0.1/v1"), false);
    assert.strictEqual(shouldInterceptUrl("http://myserver.local/v1"), false);
});

test("shouldInterceptUrl 保留公网边界地址", () => {
    assert.strictEqual(shouldInterceptUrl("http://172.32.0.1/v1"), true);
    assert.strictEqual(shouldInterceptUrl("http://172.15.0.1/v1"), true);
    assert.strictEqual(shouldInterceptUrl("http://192.169.1.5/v1"), true);
    assert.strictEqual(shouldInterceptUrl("http://100.128.0.1/v1"), true);
    assert.strictEqual(shouldInterceptUrl("https://11.0.0.1/v1"), true);
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
