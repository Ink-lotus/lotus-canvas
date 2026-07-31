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
