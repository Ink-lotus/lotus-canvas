"use strict";

const path = require("node:path");

/** 前端构建产物目录：打包态在 resources/dist，未打包时在仓库的 web/dist */
function resolveDistDir({ isPackaged, resourcesPath, appDir }) {
    return isPackaged ? path.join(resourcesPath, "dist") : path.join(appDir, "..", "web", "dist");
}

/**
 * 用户数据目录。
 * 打包态放 exe 同级 data/，整个绿色文件夹可拷走迁移。
 * 未打包态放 desktop/data/，避免写进 node_modules 被重装清除。
 */
function resolveUserDataDir({ isPackaged, exePath, appDir }) {
    return isPackaged ? path.join(path.dirname(exePath), "data") : path.join(appDir, "data");
}

module.exports = { resolveDistDir, resolveUserDataDir };
