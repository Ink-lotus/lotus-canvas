"use strict";

// 把打包产物同步到实际运行目录，并把用户数据目录排除在外。
//
// 存在的理由：electron-builder 每次打包都会清空并重建 release/win-unpacked/，
// 而用户数据目录按设计位于 exe 同级。若直接在构建目录里运行应用，
// 数据就落在构建目录内，下一次打包会连同数据一起删除——已经发生过一次。
// 因此构建目录只作为产物中转，运行目录必须是另一个位置。

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.resolve(__dirname, "..", "release", "win-unpacked");
const DEFAULT_TARGET = "D:\\tool\\lotus-canvas";
const USER_DATA_DIR_NAME = "data";

function resolveTarget() {
    const raw = (process.env.LOTUS_INSTALL_DIR || DEFAULT_TARGET).trim();
    const resolved = path.resolve(raw);
    // /MIR 会镜像删除目标端多余内容，指向盘符根目录或过浅的路径将造成严重后果
    if (path.dirname(resolved) === resolved || resolved.split(path.sep).filter(Boolean).length < 2) {
        throw new Error(`安装目录过浅，拒绝执行：${resolved}`);
    }
    return resolved;
}

function main() {
    const target = resolveTarget();

    if (!fs.existsSync(path.join(SOURCE, "lotus-canvas.exe"))) {
        console.error(`未找到打包产物：${SOURCE}`);
        console.error("请先运行 npm run build");
        process.exit(1);
    }

    // /MIR 清理旧版本残留文件；两个 /XD 分别排除源端与目标端的 data/，
    // 使其既不被复制覆盖，也不被镜像删除。
    const args = [
        SOURCE,
        target,
        "/MIR",
        "/XD",
        path.join(SOURCE, USER_DATA_DIR_NAME),
        path.join(target, USER_DATA_DIR_NAME),
        "/NFL",
        "/NDL",
        "/NP",
        "/R:2",
        "/W:2",
    ];

    const result = spawnSync("robocopy", args, { stdio: "inherit" });

    // robocopy 退出码 0-7 均表示成功（1 = 有文件被复制，3 = 有复制且有多余项被清理），
    // 8 及以上才是失败。不做转换的话 npm 会把正常结果当成错误。
    const code = result.status === null ? 16 : result.status;
    if (code >= 8) {
        console.error(`robocopy 失败，退出码 ${code}`);
        process.exit(code);
    }

    console.log(`已部署到 ${target}`);
    console.log(`用户数据目录 ${path.join(target, USER_DATA_DIR_NAME)} 未被触碰`);
}

main();
