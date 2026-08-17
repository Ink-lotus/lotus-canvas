export type DesktopMediaEntry = {
    storageKey: string;
    path: string;
    kind: "image" | "video" | "audio" | "file";
    mimeType: string;
    bytes: number;
    sha256: string;
    createdAt: string;
    filePath?: string;
};

export type DesktopMediaStats = {
    rootPath: string;
    records: number;
    files: number;
    bytes: number;
    freeBytes: number | null;
};

const MEDIA_ROUTE = "/__lotus_media__";

export function isDesktopMediaLibrary() {
    return typeof window !== "undefined" && window.location.protocol === "app:";
}

export function desktopMediaUrl(storageKey: string) {
    return `${desktopOrigin()}${MEDIA_ROUTE}/files/${encodeURIComponent(storageKey)}`;
}

export async function putDesktopMedia(storageKey: string, blob: Blob, suggestedName = "", signal?: AbortSignal) {
    const response = await fetch(desktopMediaUrl(storageKey), {
        method: "PUT",
        headers: {
            "Content-Type": blob.type || "application/octet-stream",
            ...(suggestedName ? { "X-Lotus-File-Name": encodeURIComponent(suggestedName) } : {}),
        },
        body: blob,
        signal,
    });
    return readJson<DesktopMediaEntry>(response);
}

export async function getDesktopMediaBlob(storageKey: string) {
    const response = await fetch(desktopMediaUrl(storageKey));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await responseError(response));
    return response.blob();
}

export async function hasDesktopMedia(storageKey: string) {
    const response = await fetch(desktopMediaUrl(storageKey), { method: "HEAD" });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(await responseError(response));
    return true;
}

export async function deleteDesktopMedia(storageKey: string) {
    const response = await fetch(desktopMediaUrl(storageKey), { method: "DELETE" });
    if (response.status === 404 || response.status === 204) return;
    throw new Error(await responseError(response));
}

export async function listDesktopMediaKeys(kind?: DesktopMediaEntry["kind"]) {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    const response = await fetch(`${desktopOrigin()}${MEDIA_ROUTE}/keys${query}`);
    return (await readJson<{ keys: string[] }>(response)).keys;
}

export async function readDesktopMediaStats() {
    return readJson<DesktopMediaStats>(await fetch(`${desktopOrigin()}${MEDIA_ROUTE}/status`));
}

export async function openDesktopMediaLibrary() {
    await assertResponse(await fetch(`${desktopOrigin()}${MEDIA_ROUTE}/open-root`, { method: "POST" }));
}

export async function revealDesktopMedia(storageKey: string) {
    await assertResponse(await fetch(`${desktopOrigin()}${MEDIA_ROUTE}/reveal/${encodeURIComponent(storageKey)}`, { method: "POST" }));
}

export async function readDesktopMediaInfo(storageKey: string) {
    return readJson<DesktopMediaEntry>(await fetch(`${desktopOrigin()}${MEDIA_ROUTE}/info/${encodeURIComponent(storageKey)}`));
}

function desktopOrigin() {
    return `${window.location.protocol}//${window.location.host}`;
}

async function readJson<T>(response: Response): Promise<T> {
    if (!response.ok) throw new Error(await responseError(response));
    return response.json() as Promise<T>;
}

async function assertResponse(response: Response) {
    if (!response.ok) throw new Error(await responseError(response));
}

async function responseError(response: Response) {
    try {
        const payload = (await response.json()) as { error?: { message?: string } };
        return payload.error?.message || `HTTP ${response.status}`;
    } catch {
        return `HTTP ${response.status}`;
    }
}
