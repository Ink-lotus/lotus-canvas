"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { MediaLibrary, migrateMediaLibrary, normalizeMediaLibraryDir, resolveEntryPath, validateStorageKey } = require("../src/media-library");
const { parseRange } = require("../src/media-protocol");

async function withLibrary(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-media-"));
    try {
        await run(new MediaLibrary(root), root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

test("storageKey 和索引路径拒绝路径穿越", () => {
    assert.throws(() => validateStorageKey("image:../../secret"));
    assert.throws(() => resolveEntryPath("C:\\library", "../secret.png"));
});

test("相同内容共享物理文件，最后一个映射删除时才进入回收站", async () => {
    await withLibrary(async (library) => {
        const first = await library.put("image:first", Buffer.from("same"), { mimeType: "image/png", suggestedName: "first.png" });
        const second = await library.put("image:second", Buffer.from("same"), { mimeType: "image/png", suggestedName: "second.png" });
        assert.strictEqual(first.path, second.path);
        const trashed = [];
        await library.remove("image:first", async (filePath) => trashed.push(filePath));
        assert.strictEqual(trashed.length, 0);
        await library.remove("image:second", async (filePath) => trashed.push(filePath));
        assert.strictEqual(trashed.length, 1);
    });
});

test("媒体文件按来源、类型和日期分层保存", async () => {
    await withLibrary(async (library) => {
        const external = await library.put("image:external", Buffer.from("external"), { mimeType: "image/png", origin: "external" });
        const generated = await library.put("video:generated", Buffer.from("generated"), { mimeType: "video/mp4", origin: "generated" });
        assert.match(external.path, /^external\/images\/\d{4}-\d{2}\//);
        assert.match(generated.path, /^generated\/videos\/\d{4}-\d{2}\//);
        assert.strictEqual(external.origin, "external");
        assert.strictEqual(generated.origin, "generated");
    });
});

test("不同来源的相同内容不共享物理文件", async () => {
    await withLibrary(async (library) => {
        const external = await library.put("image:external-copy", Buffer.from("same"), { mimeType: "image/png", origin: "external" });
        const generated = await library.put("image:generated-copy", Buffer.from("same"), { mimeType: "image/png", origin: "generated" });
        assert.notStrictEqual(external.path, generated.path);
    });
});

test("相同 storageKey 内容冲突时拒绝覆盖", async () => {
    await withLibrary(async (library) => {
        await library.put("video:item", Buffer.from("one"), { mimeType: "video/mp4" });
        await assert.rejects(() => library.put("video:item", Buffer.from("two"), { mimeType: "video/mp4" }), /不同媒体内容/);
    });
});

test("相同 storageKey 的物理文件缺失时允许按原内容修复", async () => {
    await withLibrary(async (library) => {
        await library.put("image:repair", Buffer.from("same"), { mimeType: "image/png" });
        await fs.rm((await library.get("image:repair")).filePath);
        await library.put("image:repair", Buffer.from("same"), { mimeType: "image/png" });
        assert.strictEqual(await fs.readFile((await library.get("image:repair")).filePath, "utf8"), "same");
    });
});

test("Range 解析支持完整、开放与后缀范围", () => {
    assert.deepStrictEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
    assert.deepStrictEqual(parseRange("bytes=6-", 10), { start: 6, end: 9 });
    assert.deepStrictEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
    assert.strictEqual(parseRange("bytes=20-30", 10), false);
});

test("媒体库自定义目录规范化为 lotus-canvas/data/library", () => {
    assert.strictEqual(normalizeMediaLibraryDir(path.join("D:", "Media")), path.join("D:", "Media", "lotus-canvas", "data", "library"));
    assert.strictEqual(normalizeMediaLibraryDir(path.join("D:", "Media", "lotus-canvas")), path.join("D:", "Media", "lotus-canvas", "data", "library"));
    assert.strictEqual(normalizeMediaLibraryDir(path.join("D:", "Media", "lotus-canvas", "data")), path.join("D:", "Media", "lotus-canvas", "data", "library"));
    assert.strictEqual(normalizeMediaLibraryDir(path.join("D:", "Media", "lotus-canvas", "data", "library")), path.join("D:", "Media", "lotus-canvas", "data", "library"));
});

test("媒体库迁移完成校验后删除旧目录", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-migrate-"));
    const source = path.join(root, "old", "library");
    const target = path.join(root, "new", "lotus-canvas", "data", "library");
    try {
        const sourceLibrary = new MediaLibrary(source);
        await sourceLibrary.put("image:item", Buffer.from("media"), { mimeType: "image/png" });
        const result = await migrateMediaLibrary(source, target);
        assert.strictEqual(result.migrated, true);
        assert.strictEqual(await fs.stat(target).then(() => true), true);
        await assert.rejects(() => fs.stat(source));
        const targetLibrary = new MediaLibrary(target);
        assert.ok(await targetLibrary.get("image:item"));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("媒体库迁移目标非空时保留旧目录并拒绝覆盖", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-migrate-"));
    const source = path.join(root, "old");
    const target = path.join(root, "new");
    try {
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(path.join(source, "media.bin"), "media");
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "keep.txt"), "keep");
        await assert.rejects(() => migrateMediaLibrary(source, target), (error) => error.code === "MEDIA_LIBRARY_TARGET_NOT_EMPTY");
        assert.strictEqual(await fs.readFile(path.join(source, "media.bin"), "utf8"), "media");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
