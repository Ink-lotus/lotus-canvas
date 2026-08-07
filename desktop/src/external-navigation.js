"use strict";

/**
 * 判断是否为需要转交系统默认浏览器的外部 http(s) 链接。
 * 桌面壳内不渲染外网页面：前端 target="_blank" / window.open 的 http(s) 链接
 * 一律由主进程拦截、弹框询问后用默认浏览器打开。app:// 内部与其它协议不在其列。
 */
function isExternalUrl(rawUrl) {
    if (typeof rawUrl !== "string") return false;
    return /^https?:\/\/.+/i.test(rawUrl.trim());
}

module.exports = { isExternalUrl };
