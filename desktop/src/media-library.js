"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const MANIFEST_FILE = ".lotus-media-index.json";
const MANIFEST_BACKUP_FILE = ".lotus-media-index.backup.json";
const MANIFEST_VERSION = 1;
const DEFAULT_MEDIA_ORIGIN = "external";
const STORAGE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,96}$/;
const MEDIA_ORIGINS = new Set(["external", "generated"]);

class MediaLibrary {
    constructor(rootDir) {
        this.rootDir = path.resolve(rootDir);
        this.manifestPath = path.join(this.rootDir, MANIFEST_FILE);
        this.backupPath = path.join(this.rootDir, MANIFEST_BACKUP_FILE);
        this.manifest = null;
        this.writeQueue = Promise.resolve();
    }

    async put(storageKey, body, options = {}) {
        validateStorageKey(storageKey);
        const origin = normalizeMediaOrigin(options.origin);
        if (!body) throw mediaError("EMPTY_BODY", "媒体内容为空");
        const tempDir = path.join(this.rootDir, ".tmp");
        await fsp.mkdir(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, `${crypto.randomUUID()}.part`);
        let bytes = 0;
        const digest = crypto.createHash("sha256");
        const inspect = new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                digest.update(chunk);
                callback(null, chunk);
            },
        });
        try {
            await pipeline(toNodeStream(body), inspect, fs.createWriteStream(tempPath, { flags: "wx" }));
            if (!bytes) throw mediaError("EMPTY_BODY", "媒体内容为空");
            const sha256 = digest.digest("hex");
            return await this.serialize(() => this.commitTempFile(storageKey, tempPath, { ...options, origin, bytes, sha256 }));
        } catch (error) {
            await fsp.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async get(storageKey) {
        validateStorageKey(storageKey);
        const manifest = await this.loadManifest();
        const entry = manifest.entries[storageKey];
        if (!entry) return null;
        const filePath = resolveEntryPath(this.rootDir, entry.path);
        try {
            const stat = await fsp.stat(filePath);
            if (!stat.isFile()) return null;
            return { ...entry, origin: entry.origin || DEFAULT_MEDIA_ORIGIN, storageKey, filePath };
        } catch {
            return null;
        }
    }

    async remove(storageKey, trashItem) {
        validateStorageKey(storageKey);
        return this.serialize(async () => {
            const manifest = await this.loadManifest();
            const entry = manifest.entries[storageKey];
            if (!entry) return false;
            const shared = Object.entries(manifest.entries).some(([key, item]) => key !== storageKey && item.path === entry.path);
            if (!shared) {
                const filePath = resolveEntryPath(this.rootDir, entry.path);
                if (fs.existsSync(filePath)) await trashItem(filePath);
            }
            const next = cloneManifest(manifest);
            delete next.entries[storageKey];
            await this.saveManifest(next);
            return true;
        });
    }

    async stats() {
        const manifest = await this.loadManifest();
        const paths = new Map();
        Object.values(manifest.entries).forEach((entry) => paths.set(entry.path, entry.bytes));
        return {
            rootPath: this.rootDir,
            records: Object.keys(manifest.entries).length,
            files: paths.size,
            bytes: Array.from(paths.values()).reduce((sum, bytes) => sum + bytes, 0),
        };
    }

    async keys(kind) {
        const manifest = await this.loadManifest();
        return Object.entries(manifest.entries)
            .filter(([, entry]) => !kind || entry.kind === kind)
            .map(([storageKey]) => storageKey);
    }

    async freeBytes() {
        await fsp.mkdir(this.rootDir, { recursive: true });
        if (typeof fsp.statfs !== "function") return null;
        const stat = await fsp.statfs(this.rootDir);
        return Number(stat.bavail) * Number(stat.bsize);
    }

    serialize(action) {
        const result = this.writeQueue.then(action, action);
        this.writeQueue = result.catch(() => undefined);
        return result;
    }

    async commitTempFile(storageKey, tempPath, options) {
        let manifest = await this.loadManifest();
        const existing = manifest.entries[storageKey];
        if (existing) {
            if (existing.sha256 !== options.sha256 || existing.bytes !== options.bytes) throw mediaError("KEY_CONFLICT", "相同 storageKey 已对应不同媒体内容");
            const existingPath = resolveEntryPath(this.rootDir, existing.path);
            if (fs.existsSync(existingPath)) {
                await fsp.rm(tempPath, { force: true });
                return { ...existing, origin: existing.origin || DEFAULT_MEDIA_ORIGIN, storageKey };
            }
            manifest = cloneManifest(manifest);
            delete manifest.entries[storageKey];
        }

        const kind = mediaKind(options.mimeType, storageKey);
        const origin = options.origin;
        const duplicate = Object.values(manifest.entries).find((entry) => entry.origin === origin && entry.kind === kind && entry.sha256 === options.sha256 && fs.existsSync(resolveEntryPath(this.rootDir, entry.path)));
        const next = cloneManifest(manifest);
        let relativePath = duplicate?.path;
        let committedPath = "";
        if (!relativePath) {
            const now = new Date();
            const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
            const shortId = storageKey.split(":")[1].slice(0, 8);
            const baseName = safeBaseName(options.suggestedName) || kind;
            const extension = mediaExtension(options.mimeType, kind);
            const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
            relativePath = path.posix.join(origin, `${kind}s`, month, `${stamp}_${baseName}_${shortId}.${extension}`);
            committedPath = resolveEntryPath(this.rootDir, relativePath);
            await fsp.mkdir(path.dirname(committedPath), { recursive: true });
            await fsp.rename(tempPath, committedPath);
        } else {
            await fsp.rm(tempPath, { force: true });
        }

        const entry = {
            path: relativePath,
            origin,
            kind,
            mimeType: normalizeMimeType(options.mimeType, kind),
            bytes: options.bytes,
            sha256: options.sha256,
            createdAt: new Date().toISOString(),
        };
        next.entries[storageKey] = entry;
        try {
            await this.saveManifest(next);
        } catch (error) {
            if (committedPath) await fsp.rm(committedPath, { force: true }).catch(() => undefined);
            throw error;
        }
        return { ...entry, storageKey };
    }

    async loadManifest() {
        if (this.manifest) return this.manifest;
        await fsp.mkdir(this.rootDir, { recursive: true });
        let raw;
        try {
            raw = await fsp.readFile(this.manifestPath, "utf8");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            this.manifest = createManifest();
            return this.manifest;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw mediaError("INVALID_MANIFEST", "媒体库索引已损坏，已拒绝覆盖");
        }
        if (parsed?.app !== "lotus-canvas" || parsed?.version !== MANIFEST_VERSION || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
            throw mediaError("INVALID_MANIFEST", "媒体库索引版本未知或格式无效，已拒绝覆盖");
        }
        for (const [storageKey, entry] of Object.entries(parsed.entries)) {
            validateStorageKey(storageKey);
            validateEntry(this.rootDir, entry);
        }
        this.manifest = parsed;
        return this.manifest;
    }

    async saveManifest(manifest) {
        manifest.updatedAt = new Date().toISOString();
        const tempPath = `${this.manifestPath}.${crypto.randomUUID()}.tmp`;
        await fsp.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        try {
            if (fs.existsSync(this.manifestPath)) await fsp.copyFile(this.manifestPath, this.backupPath);
            await fsp.rename(tempPath, this.manifestPath);
            this.manifest = manifest;
        } catch (error) {
            await fsp.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}

function createManifest() {
    return { app: "lotus-canvas", version: MANIFEST_VERSION, updatedAt: new Date().toISOString(), entries: {} };
}

function cloneManifest(manifest) {
    return { ...manifest, entries: { ...manifest.entries } };
}

function validateStorageKey(storageKey) {
    if (!STORAGE_KEY_PATTERN.test(String(storageKey || ""))) throw mediaError("INVALID_KEY", "无效的媒体 storageKey");
}

function validateEntry(rootDir, entry) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.mimeType !== "string" || typeof entry.sha256 !== "string" || !Number.isFinite(entry.bytes)) {
        throw mediaError("INVALID_MANIFEST", "媒体库索引包含无效记录，已拒绝覆盖");
    }
    if (entry.origin !== undefined && !MEDIA_ORIGINS.has(entry.origin)) throw mediaError("INVALID_MANIFEST", "媒体库索引包含无效来源，已拒绝覆盖");
    resolveEntryPath(rootDir, entry.path);
}

function normalizeMediaOrigin(value) {
    const origin = String(value || DEFAULT_MEDIA_ORIGIN);
    if (!MEDIA_ORIGINS.has(origin)) throw mediaError("INVALID_ORIGIN", "无效的媒体来源");
    return origin;
}

function resolveEntryPath(rootDir, relativePath) {
    const normalized = String(relativePath || "").replaceAll("\\", "/");
    const target = path.resolve(rootDir, normalized);
    const inside = path.relative(rootDir, target);
    if (!normalized || inside.startsWith("..") || path.isAbsolute(inside)) throw mediaError("INVALID_PATH", "媒体索引路径越界");
    return target;
}

function safeBaseName(value) {
    const source = path.basename(String(value || ""), path.extname(String(value || "")));
    const cleaned = source.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/[. ]+$/g, "").trim().slice(0, 48);
    if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return "";
    return cleaned;
}

function mediaKind(mimeType, storageKey) {
    const mime = String(mimeType || "").toLowerCase();
    if (mime.startsWith("image/") || storageKey.startsWith("image:")) return "image";
    if (mime.startsWith("video/") || storageKey.startsWith("video")) return "video";
    if (mime.startsWith("audio/") || storageKey.startsWith("audio")) return "audio";
    return "file";
}

function normalizeMimeType(mimeType, kind) {
    const value = String(mimeType || "").trim();
    if (value) return value;
    if (kind === "image") return "image/png";
    if (kind === "video") return "video/mp4";
    if (kind === "audio") return "audio/mpeg";
    return "application/octet-stream";
}

function mediaExtension(mimeType, kind) {
    const mime = normalizeMimeType(mimeType, kind).toLowerCase();
    if (mime.includes("jpeg")) return "jpg";
    if (mime.includes("svg")) return "svg";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("gif")) return "gif";
    if (mime.includes("png")) return "png";
    if (mime.includes("webm")) return "webm";
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("wav")) return "wav";
    if (mime.includes("ogg")) return "ogg";
    if (mime.includes("flac")) return "flac";
    if (mime.includes("aac")) return "aac";
    if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
    return "bin";
}

function toNodeStream(body) {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Readable.from([body]);
    if (typeof body.stream === "function") return Readable.fromWeb(body.stream());
    if (typeof body.getReader === "function") return Readable.fromWeb(body);
    if (typeof body[Symbol.asyncIterator] === "function" || typeof body[Symbol.iterator] === "function") return Readable.from(body);
    throw mediaError("INVALID_BODY", "不支持的媒体数据流");
}

function mediaError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

module.exports = {
    MANIFEST_FILE,
    MANIFEST_VERSION,
    MediaLibrary,
    normalizeMediaOrigin,
    mediaExtension,
    mediaKind,
    resolveEntryPath,
    safeBaseName,
    validateStorageKey,
};
