"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const releaseDir = path.join(desktopDir, "release");
const sourceDir = path.join(releaseDir, "win-unpacked");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const outputPath = path.join(releaseDir, `${packageJson.productName || "lotus-canvas"}-${packageJson.version}-win-x64-portable.zip`);

const excludedDirectoryNames = new Set(["data", "log", "logs", "temp", "tmp"]);

function shouldCopy(sourcePath) {
    const relativePath = path.relative(sourceDir, sourcePath);
    if (!relativePath) return true;
    const parts = relativePath.split(path.sep).map((part) => part.toLowerCase());
    return !parts.some((part) => excludedDirectoryNames.has(part) || part.endsWith(".log"));
}

function copyPortableFiles(stagingDir) {
    fs.cpSync(sourceDir, stagingDir, {
        recursive: true,
        filter: shouldCopy,
    });
    fs.writeFileSync(path.join(stagingDir, "portable.flag"), "lotus-canvas portable build\n", "utf8");
}

function zipWithPowerShell(stagingDir) {
    const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$source = [Environment]::GetEnvironmentVariable('LOTUS_PORTABLE_SOURCE')",
        "$destination = [Environment]::GetEnvironmentVariable('LOTUS_PORTABLE_DESTINATION')",
        "Compress-Archive -Path (Join-Path $source '*') -DestinationPath $destination -Force",
    ].join("; ");
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: "inherit",
        env: {
            ...process.env,
            LOTUS_PORTABLE_SOURCE: stagingDir,
            LOTUS_PORTABLE_DESTINATION: outputPath,
        },
    });
}

function zipWithZip(stagingDir) {
    execFileSync("zip", ["-q", "-r", outputPath, "."], { cwd: stagingDir, stdio: "inherit" });
}

function main() {
    if (!fs.existsSync(path.join(sourceDir, "lotus-canvas.exe"))) {
        throw new Error(`未找到绿色版源目录：${sourceDir}，请先运行 npm run build`);
    }

    fs.rmSync(outputPath, { force: true });
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "lotus-canvas-portable-"));
    try {
        copyPortableFiles(stagingDir);
        if (process.platform === "win32" || process.env.POWERSHELL) {
            zipWithPowerShell(stagingDir);
        } else {
            zipWithZip(stagingDir);
        }
        console.log(`已生成绿色版：${outputPath}`);
    } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }
}

main();
