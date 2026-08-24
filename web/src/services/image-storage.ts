import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";
import { deleteDesktopMedia, desktopMediaUrl, getDesktopMediaBlob, hasDesktopMedia, isDesktopMediaLibrary, listDesktopMediaKeys, putDesktopMedia, type MediaOrigin } from "@/services/desktop-media-storage";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();

// A reference image or a stored file could not be read locally, so retrying the same request on another channel cannot help.
export class ImageReadError extends Error {
    constructor() {
        super(i18n.t("common.imageReadFailed"));
        this.name = "ImageReadError";
    }
}

export async function uploadImage(input: string | Blob, options?: { suggestedName?: string; origin?: MediaOrigin }): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `image:${nanoid()}`;
    const desktop = isDesktopMediaLibrary();
    if (desktop) await putDesktopMedia(storageKey, blob, options?.suggestedName || (input instanceof File ? input.name : ""), undefined, options?.origin);
    else await store.setItem(storageKey, blob);
    const url = desktop ? desktopMediaUrl(storageKey) : URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    if (isDesktopMediaLibrary() && (await hasDesktopMedia(storageKey))) {
        const url = desktopMediaUrl(storageKey);
        objectUrls.set(storageKey, url);
        return url;
    }
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    if (isDesktopMediaLibrary()) {
        const blob = await getDesktopMediaBlob(storageKey);
        if (blob) return blob;
    }
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob, origin: MediaOrigin = "external") {
    const desktop = isDesktopMediaLibrary();
    if (desktop) await putDesktopMedia(storageKey, blob, "", undefined, origin);
    else await store.setItem(storageKey, blob);
    const url = desktop ? desktopMediaUrl(storageKey) : URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    const response = await fetch(url);
    if (!response.ok) throw new ImageReadError();
    return blobToDataUrl(await response.blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            if (isDesktopMediaLibrary()) await deleteDesktopMedia(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    if (isDesktopMediaLibrary()) {
        const desktopKeys = await listDesktopMediaKeys("image");
        desktopKeys.forEach((key) => {
            if (!usedKeys.has(key)) unused.push(key);
        });
    }
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new ImageReadError());
        reader.readAsDataURL(blob);
    });
}
