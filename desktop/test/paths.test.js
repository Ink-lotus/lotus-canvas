"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { resolveDistDir, resolveLibraryDir, resolveUserDataDir } = require("../src/paths");

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

test("媒体库位于 userData/library", () => {
    assert.strictEqual(resolveLibraryDir(path.join("E:", "green", "data")), path.join("E:", "green", "data", "library"));
});
