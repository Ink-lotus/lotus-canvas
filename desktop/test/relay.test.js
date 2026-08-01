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

test("relayDecision 只对公网主机放行中继与预检", () => {
    const { relayDecision } = require("../src/relay");
    assert.strictEqual(relayDecision("POST", true), "relay");
    assert.strictEqual(relayDecision("OPTIONS", true), "preflight");
    assert.strictEqual(relayDecision("GET", true), "passthrough");
});

test("relayDecision 对非公网主机一律透传，不中继也不应答预检", () => {
    const { relayDecision } = require("../src/relay");
    assert.strictEqual(relayDecision("POST", false), "passthrough");
    assert.strictEqual(relayDecision("OPTIONS", false), "passthrough");
    assert.strictEqual(relayDecision("GET", false), "passthrough");
});
