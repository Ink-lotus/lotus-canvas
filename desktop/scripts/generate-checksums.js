"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const releaseDir = path.resolve(process.env.RELEASE_DIR || path.join(__dirname, "..", "release"));
const checksumName = "SHA256SUMS.txt";
const checksumPath = path.join(releaseDir, checksumName);

function hashFile(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

function main() {
    if (!fs.existsSync(releaseDir)) throw new Error(`未找到发布目录：${releaseDir}`);

    const files = fs.readdirSync(releaseDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name !== checksumName)
        .filter((entry) => /\.(exe|zip|blockmap)$/i.test(entry.name) || entry.name === "latest.yml")
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    if (files.length === 0) throw new Error(`发布目录没有可校验文件：${releaseDir}`);

    const content = files.map((fileName) => `${hashFile(path.join(releaseDir, fileName))} *${fileName}`).join("\n") + "\n";
    fs.writeFileSync(checksumPath, content, "utf8");
    console.log(`已生成校验文件：${checksumPath}`);
}

main();
