import { Alert, App, Button, Progress, Spin, Tooltip } from "antd";
import type { TFunction } from "i18next";
import { Database, FolderOpen, HardDrive, Layers3, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { isDesktopMediaLibrary, openDesktopMediaLibrary, readDesktopAppInfo, readDesktopMediaStats, selectDesktopMediaLibrary, type DesktopAppInfo, type DesktopMediaStats } from "@/services/desktop-media-storage";
import { readLocalStorageUsage, type LocalStorageUsage } from "@/services/local-storage-usage";

const storeLabelKeys: Record<string, string> = {
    app_state: "appState",
    image_files: "images",
    media_files: "media",
    image_generation_logs: "imageLogs",
    video_generation_logs: "videoLogs",
    agent_chat_messages: "agentMessages",
    prompt_cache: "promptCache",
};

export function ConfigLocalStorage({ active }: { active: boolean }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [usage, setUsage] = useState<LocalStorageUsage | null>(null);
    const [desktopStats, setDesktopStats] = useState<DesktopMediaStats | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
    const [changingLibrary, setChangingLibrary] = useState(false);
    const [libraryError, setLibraryError] = useState("");
    const desktop = isDesktopMediaLibrary();

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const [nextUsage, nextDesktopStats] = await Promise.all([
                readLocalStorageUsage(),
                desktop ? readDesktopMediaStats() : Promise.resolve(null),
            ]);
            setUsage(nextUsage);
            setDesktopStats(nextDesktopStats);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("config.localStorage.readFailed"));
        } finally {
            setLoading(false);
        }
    }, [desktop, t]);

    useEffect(() => {
        if (active && !usage) void refresh();
    }, [active, refresh, usage]);

    useEffect(() => {
        if (!active || !desktop) return;
        void readDesktopAppInfo().then(setAppInfo).catch(() => setAppInfo(null));
    }, [active, desktop]);

    const indexedDbBytes = usage?.contentBytes ?? 0;
    const percent = usage ? Math.min(100, (usage.usage / usage.quota) * 100) : 0;

    const openLibrary = async () => {
        try {
            await openDesktopMediaLibrary();
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : t("common.mediaActionFailed"));
        }
    };

    const changeLibrary = async () => {
        setChangingLibrary(true);
        setLibraryError("");
        try {
            const nextPath = await selectDesktopMediaLibrary();
            if (!nextPath) return;
            await refresh();
            message.success(t("config.localStorage.library.changed"));
        } catch (reason) {
            const detail = reason instanceof Error ? reason.message : t("config.localStorage.library.changeFailed");
            setLibraryError(detail);
            message.error(t("config.localStorage.library.changeFailed"));
        } finally {
            setChangingLibrary(false);
        }
    };

    return (
        <div className="space-y-3">
            {desktop && desktopStats ? (
                <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                                <HardDrive className="size-4" />
                                <span>{t("config.localStorage.library.title")}</span>
                                {appInfo?.isDesktop ? (
                                    <Tooltip title={t("config.localStorage.library.change")}>
                                        <Button
                                            type="text"
                                            size="small"
                                            icon={<Settings2 className="size-4" />}
                                            loading={changingLibrary}
                                            aria-label={t("config.localStorage.library.change")}
                                            onClick={() => void changeLibrary()}
                                        />
                                    </Tooltip>
                                ) : null}
                            </div>
                            <div className="mt-1 break-all font-mono text-[11px] text-stone-500">{desktopStats.rootPath}</div>
                        </div>
                        <Button icon={<FolderOpen className="size-4" />} onClick={() => void openLibrary()}>{t("config.localStorage.library.open")}</Button>
                    </div>
                    {libraryError ? <Alert className="mt-3" type="error" showIcon message={t("config.localStorage.library.changeFailed")} description={libraryError} /> : null}
                    {changingLibrary ? <div className="mt-3 flex items-center gap-2 text-xs text-stone-500"><Spin size="small" />{t("config.localStorage.library.changing")}</div> : null}
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <StorageMetric icon={<HardDrive className="size-4" />} label={t("config.localStorage.library.usage")} value={formatStorageBytes(desktopStats.bytes)} hint={t("config.localStorage.library.files", { count: desktopStats.files })} />
                        <StorageMetric icon={<Layers3 className="size-4" />} label={t("config.localStorage.library.references")} value={String(desktopStats.records)} hint={t("config.localStorage.library.dedupHint")} />
                    </div>
                </section>
            ) : null}
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Database className="size-4" />
                            {t("config.localStorage.title")}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">{t("config.localStorage.description")}</div>
                    </div>
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                        {t("config.localStorage.refresh")}
                    </Button>
                </div>
                {error ? <Alert className="mt-4" type="error" showIcon message={t("config.localStorage.readFailed")} description={error} /> : null}
                {!usage && loading ? (
                    <div className="flex min-h-48 items-center justify-center"><Spin /></div>
                ) : usage ? (
                    <>
                        <div className="mt-4 grid gap-3 sm:grid-cols-3">
                            <StorageMetric icon={<Database className="size-4" />} label={t("config.localStorage.indexedDbUsage")} value={formatStorageBytes(indexedDbBytes)} hint={t("config.localStorage.contentEstimate")} />
                            <StorageMetric icon={<HardDrive className="size-4" />} label={t("config.localStorage.siteUsage")} value={formatStorageBytes(usage.usage)} hint={t("config.localStorage.siteUsageHint")} />
                            <StorageMetric icon={<Layers3 className="size-4" />} label={t("config.localStorage.quota")} value={formatStorageBytes(usage.quota)} hint={t("config.localStorage.quotaHint")} />
                        </div>
                        <div className="mt-4">
                            <div className="mb-1 flex justify-between text-xs text-stone-500">
                                <span>{t("config.localStorage.quotaProgress")}</span>
                                <span className="tabular-nums">{percent.toFixed(2)}%</span>
                            </div>
                            <Progress percent={percent} showInfo={false} />
                        </div>
                    </>
                ) : null}
            </section>
            {usage?.databases.map((database) => (
                <section key={database.name} className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                    <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{t("config.localStorage.mainDatabase")}</div>
                            <div className="mt-0.5 truncate font-mono text-[11px] text-stone-500">{database.name} · v{database.version}</div>
                        </div>
                        <div className="shrink-0 text-sm font-medium tabular-nums">{formatStorageBytes(database.bytes)}</div>
                    </div>
                    <div className="divide-y divide-stone-200 dark:divide-stone-800">
                        {database.stores.map((store) => (
                            <div key={store.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-4 py-3 text-sm">
                                <div className="min-w-0">
                                    <div className="truncate font-medium">{storeLabel(store.name, t)}</div>
                                    <div className="mt-0.5 truncate font-mono text-[11px] text-stone-500">{store.name}</div>
                                </div>
                                <div className="text-right text-xs text-stone-500 tabular-nums">{t("config.localStorage.records", { count: store.records })}</div>
                                <div className="w-20 text-right font-medium tabular-nums">{formatStorageBytes(store.bytes)}</div>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

function StorageMetric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
    return (
        <div className="rounded-lg bg-stone-100/70 p-3 dark:bg-stone-900/70">
            <div className="flex items-center gap-2 text-xs text-stone-500">{icon}{label}</div>
            <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-[11px] text-stone-500">{hint}</div>
        </div>
    );
}

function storeLabel(name: string, t: TFunction) {
    const key = storeLabelKeys[name];
    return key ? t(`config.localStorage.stores.${key}`) : name;
}

function formatStorageBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
