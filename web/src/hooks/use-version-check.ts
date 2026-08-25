import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

const latestVersionUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main/VERSION";
const latestChangelogUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md";
// 桌面端走 releases.atom 而不是 api.github.com：后者匿名配额是 60 次/小时/IP，
// 走代理时该配额由整个出口 IP 上的所有人共享、长期为 0，而这次请求是更新检测的唯一入口——
// 拿不到标签就不会调 checkForUpdates，electron-updater 根本不会启动。atom 不计入该配额。
const desktopReleaseFeedUrl = "https://github.com/Ink-lotus/lotus-canvas/releases.atom";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

// 桌面端一律按运行时判定：preload 在首次 render 前就注入了 window.lotusDesktop。
// 不用编译期的 __DESKTOP_BUILD__，是因为漏设该构建变量时失败是静默的——
// 版本号会退回上游 Web 版本，更新检查也会转去上游仓库。
function desktopApi() {
    return typeof window !== "undefined" ? window.lotusDesktop : undefined;
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const api = desktopApi();
    const [appInfo, setAppInfo] = useState<{ isDesktop: boolean; portable: boolean; version: string; updateSupported: boolean } | null>(null);
    const currentVersion = appInfo?.version || APP_VERSION;
    const [latestVersion, setLatestVersion] = useState(APP_VERSION);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const [desktopUpdateState, setDesktopUpdateState] = useState<LotusDesktopUpdateState>({ status: "idle" });
    const [desktopReleaseTag, setDesktopReleaseTag] = useState<string | null>(null);
    const checkedDesktopReleaseTag = useRef<string | null>(null);
    const hasNewVersion = isNewerVersion(latestVersion, currentVersion);
    const isDesktop = Boolean(appInfo?.isDesktop);
    const updateSupported = Boolean(appInfo?.updateSupported && !appInfo.portable);

    useEffect(() => {
        if (!api) {
            setAppInfo(null);
            return;
        }
        void api.getAppInfo().then(setAppInfo).catch(() => setAppInfo(null));
        return api.onUpdateState(setDesktopUpdateState);
    }, [api]);

    useEffect(() => {
        if (desktopUpdateState.version) setLatestVersion(desktopUpdateState.version);
    }, [desktopUpdateState.version]);

    useEffect(() => {
        if (!api || !updateSupported || !desktopReleaseTag || checkedDesktopReleaseTag.current === desktopReleaseTag) return;
        checkedDesktopReleaseTag.current = desktopReleaseTag;
        void api.checkForUpdates(desktopReleaseTag).catch(() => undefined);
    }, [api, desktopReleaseTag, updateSupported]);

    const checkLatestVersion = useCallback(async () => {
        try {
            if (api) {
                const latest = await fetchLatestDesktopRelease();
                setLatestVersion(latest ? releaseTagVersion(latest.tag) : currentVersion);
                setDesktopReleaseTag(latest?.tag || null);
                return Boolean(latest);
            }
            const response = await fetch(latestVersionUrl);
            if (!response.ok) return false;
            const version = await response.text();
            setLatestVersion(version.trim() || currentVersion);
            return true;
        } catch {
            return false;
        }
    }, [api, currentVersion]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                if (api) {
                    const latest = await fetchLatestDesktopRelease();
                    // 取不到任何 desktop-v* 发布时按失败处理：静默当成"已是最新"会把真实故障伪装成正常
                    if (!latest) throw new Error(t("version.readFailed"));
                    setLatestVersion(releaseTagVersion(latest.tag));
                    setDesktopReleaseTag(latest.tag);
                    if (latest.notes.trim()) setReleases(parseChangelog(latest.notes));
                    if (updateSupported) {
                        checkedDesktopReleaseTag.current = latest.tag;
                        void api.checkForUpdates(latest.tag).catch(() => undefined);
                    }
                    if (showMessage) message.success(t("version.updated"));
                    return true;
                }
                const [versionResponse, changelogResponse] = await Promise.all([fetch(latestVersionUrl), fetch(latestChangelogUrl)]);
                if (!versionResponse.ok) throw new Error(t("version.readFailed"));
                if (!changelogResponse.ok) throw new Error(t("version.changelogFailed"));
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                setLatestVersion(version.trim() || currentVersion);
                if (changelog.trim()) setReleases(parseChangelog(changelog));
                if (showMessage) message.success(t("version.updated"));
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [api, currentVersion, latestVersion, localReleases, message, t, updateSupported, desktopReleaseTag],
    );

    const downloadDesktopUpdate = useCallback(async () => {
        if (!api || !updateSupported) return false;
        try {
            await api.checkForUpdates(desktopReleaseTag || `desktop-v${latestVersion}`);
            await api.downloadUpdate();
            return true;
        } catch {
            message.error(t("version.downloadFailed"));
            return false;
        }
    }, [api, desktopReleaseTag, latestVersion, message, t, updateSupported]);

    const installDesktopUpdate = useCallback(async () => {
        if (!api || !updateSupported) return;
        await api.quitAndInstall();
    }, [api, updateSupported]);

    useEffect(() => {
        void checkLatestVersion();
    }, [checkLatestVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    return {
        open,
        setOpen,
        openReleaseModal,
        currentVersion,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        checkLatestRelease,
        isDesktop,
        updateSupported,
        desktopUpdateState,
        downloadDesktopUpdate,
        installDesktopUpdate,
    };
}

type DesktopRelease = { tag: string; notes: string };

const DESKTOP_TAG_PATTERN = /^desktop-v\d+\.\d+\.\d+$/;

function releaseTagVersion(tag: string) {
    return tag.replace(/^desktop-v/, "");
}

/**
 * 解析 GitHub 的 releases.atom。
 * <id> 形如 tag:github.com,2008:Repository/<repoId>/<tag>；<content> 是渲染成 HTML 的 release notes。
 * 注意：atom 不含 prerelease 标记，无法像 REST 那样过滤预发布；当前发布流程（desktop-build.yml）
 * 只产出正式版，因此不受影响。草稿不会出现在 atom 中。
 */
function parseDesktopReleaseFeed(xml: string): DesktopRelease[] {
    const feed = new DOMParser().parseFromString(xml, "application/xml");
    return Array.from(feed.getElementsByTagName("entry"))
        .map((entry) => ({
            tag: entry.getElementsByTagName("id")[0]?.textContent?.split("/").pop()?.trim() || "",
            notes: entry.getElementsByTagName("content")[0]?.textContent || "",
        }))
        .filter((release) => DESKTOP_TAG_PATTERN.test(release.tag));
}

/** atom 已按发布时间倒序，仍按版本号显式取最大值，避免补发旧版本时选错 */
function pickLatestDesktopRelease(releases: DesktopRelease[]) {
    return releases.slice().sort((a, b) => {
        const av = toVersionParts(releaseTagVersion(a.tag)) || [0, 0, 0];
        const bv = toVersionParts(releaseTagVersion(b.tag)) || [0, 0, 0];
        return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
    })[0];
}

async function fetchLatestDesktopRelease() {
    const response = await fetch(desktopReleaseFeedUrl);
    if (!response.ok) throw new Error(`releases.atom responded ${response.status}`);
    return pickLatestDesktopRelease(parseDesktopReleaseFeed(await response.text()));
}
