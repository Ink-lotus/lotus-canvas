"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { Readable } = require("node:stream");

const MEDIA_PREFIX = "/__lotus_media__";

function createMediaProtocolHandler({ library, shell }) {
    return async function handleMediaRequest(request) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith(`${MEDIA_PREFIX}/`)) return null;
        try {
            const route = url.pathname.slice(MEDIA_PREFIX.length + 1);
            if (route === "status" && request.method === "GET") {
                return jsonResponse({ ...(await library.stats()), freeBytes: await library.freeBytes() });
            }
            if (route === "keys" && request.method === "GET") {
                const kind = url.searchParams.get("kind") || undefined;
                return jsonResponse({ keys: await library.keys(kind) });
            }
            if (route === "open-root" && request.method === "POST") {
                const error = await shell.openPath(library.rootDir);
                if (error) throw new Error(error);
                return new Response(null, { status: 204 });
            }
            if (route.startsWith("reveal/") && request.method === "POST") {
                const entry = await library.get(readStorageKey(route, "reveal/"));
                if (!entry) return jsonError(404, "媒体文件不存在");
                shell.showItemInFolder(entry.filePath);
                return new Response(null, { status: 204 });
            }
            if (route.startsWith("info/") && request.method === "GET") {
                const entry = await library.get(readStorageKey(route, "info/"));
                return entry ? jsonResponse(entry) : jsonError(404, "媒体文件不存在");
            }
            if (!route.startsWith("files/")) return jsonError(404, "未知媒体路由");
            const storageKey = readStorageKey(route, "files/");
            if (request.method === "PUT") {
                const entry = await library.put(storageKey, request.body, {
                    mimeType: request.headers.get("content-type") || "application/octet-stream",
                    suggestedName: decodeHeader(request.headers.get("x-lotus-file-name")),
                    origin: decodeHeader(request.headers.get("x-lotus-media-origin")),
                });
                return jsonResponse(entry, 201);
            }
            if (request.method === "DELETE") {
                const removed = await library.remove(storageKey, (filePath) => shell.trashItem(filePath));
                return new Response(null, { status: removed ? 204 : 404 });
            }
            if (request.method !== "GET" && request.method !== "HEAD") return jsonError(405, "不支持的请求方法");
            const entry = await library.get(storageKey);
            if (!entry) return jsonError(404, "媒体文件不存在");
            return fileResponse(entry, request);
        } catch (error) {
            const status = error?.code === "INVALID_KEY" || error?.code === "INVALID_BODY" || error?.code === "EMPTY_BODY" || error?.code === "INVALID_ORIGIN" ? 400 : error?.code === "KEY_CONFLICT" ? 409 : 500;
            return jsonError(status, error?.message || String(error));
        }
    };
}

async function fileResponse(entry, request) {
    const stat = await fsp.stat(entry.filePath);
    const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Type": entry.mimeType,
    });
    const range = parseRange(request.headers.get("range"), stat.size);
    if (range === false) {
        headers.set("Content-Range", `bytes */${stat.size}`);
        return new Response(null, { status: 416, headers });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const length = Math.max(0, end - start + 1);
    headers.set("Content-Length", String(length));
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    const stream = fs.createReadStream(entry.filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
}

function parseRange(value, size) {
    if (!value) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (!match || (!match[1] && !match[2]) || size <= 0) return false;
    let start;
    let end;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isInteger(suffix) || suffix <= 0) return false;
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return false;
    return { start, end: Math.min(end, size - 1) };
}

function readStorageKey(route, prefix) {
    const value = route.slice(prefix.length);
    if (!value || value.includes("/")) throw Object.assign(new Error("无效的媒体 storageKey"), { code: "INVALID_KEY" });
    try {
        return decodeURIComponent(value);
    } catch {
        throw Object.assign(new Error("无效的媒体 storageKey"), { code: "INVALID_KEY" });
    }
}

function decodeHeader(value) {
    if (!value) return "";
    try {
        return decodeURIComponent(value);
    } catch {
        return "";
    }
}

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function jsonError(status, message) {
    return jsonResponse({ error: { message } }, status);
}

module.exports = { MEDIA_PREFIX, createMediaProtocolHandler, parseRange };
