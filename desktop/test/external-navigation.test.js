"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { isExternalUrl } = require("../src/external-navigation");

test("isExternalUrl 识别 http/https 外链", () => {
    assert.strictEqual(isExternalUrl("https://github.com/basketikun/infinite-canvas"), true);
    assert.strictEqual(isExternalUrl("http://example.com/a?b=1#c"), true);
    assert.strictEqual(isExternalUrl("HTTPS://EXAMPLE.COM/"), true);
});

test("isExternalUrl 拒绝非外链协议", () => {
    assert.strictEqual(isExternalUrl("app://canvas/"), false);
    assert.strictEqual(isExternalUrl("app://canvas/projects"), false);
    assert.strictEqual(isExternalUrl("blob:https://example.com/uuid"), false);
    assert.strictEqual(isExternalUrl("mailto:x@y.com"), false);
    assert.strictEqual(isExternalUrl("javascript:alert(1)"), false);
    assert.strictEqual(isExternalUrl("/relative/path"), false);
    assert.strictEqual(isExternalUrl(""), false);
    assert.strictEqual(isExternalUrl(undefined), false);
    assert.strictEqual(isExternalUrl(null), false);
});
