import localforage from "localforage";

import { putDesktopMedia } from "@/services/desktop-media-storage";

type LegacyStoreName = "image_files" | "media_files";
type LegacyMediaItem = { storeName: LegacyStoreName; storageKey: string; blob: Blob };

export type LegacyMediaSummary = {
    records: number;
    bytes: number;
    maxBytes: number;
};

export type MediaMigrationProgress = {
    current: number;
    total: number;
    migrated: number;
    failed: number;
    processedBytes: number;
    totalBytes: number;
    storageKey?: string;
};

const imageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });

export async function readLegacyMediaSummary(): Promise<LegacyMediaSummary> {
    const items = await readLegacyMediaItems();
    return {
        records: items.length,
        bytes: items.reduce((sum, item) => sum + item.blob.size, 0),
        maxBytes: items.reduce((max, item) => Math.max(max, item.blob.size), 0),
    };
}

export async function migrateLegacyMedia(options: { shouldCancel: () => boolean; onProgress: (progress: MediaMigrationProgress) => void }) {
    const items = await readLegacyMediaItems();
    const totalBytes = items.reduce((sum, item) => sum + item.blob.size, 0);
    let migrated = 0;
    let failed = 0;
    let processedBytes = 0;
    const failures: Array<{ storageKey: string; error: string }> = [];

    for (let index = 0; index < items.length; index += 1) {
        if (options.shouldCancel()) break;
        const item = items[index];
        try {
            const entry = await putDesktopMedia(item.storageKey, item.blob, item.storageKey);
            if (entry.bytes !== item.blob.size || !entry.sha256) throw new Error("桌面媒体文件校验失败");
            await storeFor(item.storeName).removeItem(item.storageKey);
            migrated += 1;
        } catch (error) {
            failed += 1;
            failures.push({ storageKey: item.storageKey, error: error instanceof Error ? error.message : String(error) });
        }
        processedBytes += item.blob.size;
        options.onProgress({ current: index + 1, total: items.length, migrated, failed, processedBytes, totalBytes, storageKey: item.storageKey });
    }

    return { total: items.length, migrated, failed, canceled: options.shouldCancel(), failures };
}

async function readLegacyMediaItems() {
    const items: LegacyMediaItem[] = [];
    await Promise.all([
        imageStore.iterate<Blob, void>((blob, storageKey) => {
            if (blob instanceof Blob) items.push({ storeName: "image_files", storageKey, blob });
        }),
        mediaStore.iterate<Blob, void>((blob, storageKey) => {
            if (blob instanceof Blob) items.push({ storeName: "media_files", storageKey, blob });
        }),
    ]);
    return items.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
}

function storeFor(storeName: LegacyStoreName) {
    return storeName === "image_files" ? imageStore : mediaStore;
}
