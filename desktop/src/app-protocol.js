"use strict";

const path = require("node:path");
const fs = require("node:fs");

/**
 * 把 app://canvas/<pathname> 映射到 dist 内的绝对文件路径。
 * 以下情况一律回退 index.html：根路径、无扩展名（SPA 路由）、解码失败、路径穿越、文件不存在。
 * net.fetch(file://) 本身不做路径穿越校验，防护必须在这里完成。
 */
function resolveAppAssetPath(pathname, distDir, exists = fs.existsSync) {
    const indexFile = path.join(distDir, "index.html");

    let decoded;
    try {
        decoded = decodeURIComponent(String(pathname || "/"));
    } catch {
        return indexFile;
    }

    const relative = decoded.replace(/^[/\\]+/, "");
    if (relative === "") return indexFile;

    const target = path.resolve(distDir, relative);
    const inside = path.relative(distDir, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return indexFile;

    if (!path.extname(target)) return indexFile;
    if (!exists(target)) return indexFile;
    return target;
}

module.exports = { resolveAppAssetPath };
