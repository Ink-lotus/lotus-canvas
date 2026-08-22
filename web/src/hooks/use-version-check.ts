import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION, IS_DESKTOP_BUILD } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

const latestVersionUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main/VERSION";
const latestChangelogUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md";
const desktopReleasesUrl = "https://api.github.com/repos/Ink-lotus/infinite-canvas/releases?per_page=30";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function desktopApi() {
    return IS_DESKTOP_BUILD && typeof window !== "undefined" ? window.lotusDesktop : undefined;
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
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const api = desktopApi();
    const [appInfo, setAppInfo] = useState<{ isDesktop: boolean; portable: boolean; version: string; updateSupported: boolean } | null>(null);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
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
            if (IS_DESKTOP_BUILD) {
                const response = await fetch(desktopReleasesUrl, { headers: { Accept: "application/vnd.github+json" } });
                if (!response.ok) return false;
                const releases = (await response.json()) as Array<{ tag_name?: string; prerelease?: boolean; draft?: boolean; published_at?: string }>;
                const latest = getLatestDesktopRelease(releases.filter((release) => !release.draft && !release.prerelease));
                setLatestVersion(latest?.tag_name?.replace(/^desktop-v/, "") || currentVersion);
                setDesktopReleaseTag(latest?.tag_name || null);
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
    }, [currentVersion]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                if (IS_DESKTOP_BUILD) {
                    const response = await fetch(desktopReleasesUrl, { headers: { Accept: "application/vnd.github+json" } });
                    if (!response.ok) throw new Error(t("version.readFailed"));
                    const releases = (await response.json()) as Array<{ tag_name?: string; body?: string; prerelease?: boolean; draft?: boolean; published_at?: string }>;
                    const latest = getLatestDesktopRelease(releases.filter((release) => !release.draft && !release.prerelease));
                    setLatestVersion(latest?.tag_name?.replace(/^desktop-v/, "") || currentVersion);
                    setDesktopReleaseTag(latest?.tag_name || null);
                    if (latest?.body?.trim()) setReleases(parseChangelog(latest.body));
                    if (updateSupported && latest?.tag_name) {
                        checkedDesktopReleaseTag.current = latest.tag_name;
                        void api?.checkForUpdates(latest.tag_name).catch(() => undefined);
                    }
                    if (showMessage) message.success(t("version.updated"));
                    return Boolean(latest);
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

function getLatestDesktopRelease<T extends { tag_name?: string }>(releases: T[]) {
    return releases
        .filter((release) => /^desktop-v\d+\.\d+\.\d+$/.test(release.tag_name || ""))
        .sort((a, b) => {
            const av = toVersionParts(a.tag_name!.replace(/^desktop-v/, "")) || [0, 0, 0];
            const bv = toVersionParts(b.tag_name!.replace(/^desktop-v/, "")) || [0, 0, 0];
            return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
        })[0];
}
