"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lotusDesktop", {
    getAppInfo: () => ipcRenderer.invoke("desktop:get-app-info"),
    selectMediaLibrary: () => ipcRenderer.invoke("desktop:select-media-library"),
    getMediaLibraryPath: () => ipcRenderer.invoke("desktop:get-media-library-path"),
    checkForUpdates: (releaseTag) => ipcRenderer.invoke("desktop:check-for-updates", releaseTag),
    downloadUpdate: () => ipcRenderer.invoke("desktop:download-update"),
    quitAndInstall: () => ipcRenderer.invoke("desktop:quit-and-install"),
    onUpdateState: (listener) => {
        const handler = (_event, state) => listener(state);
        ipcRenderer.on("desktop:update-state", handler);
        return () => ipcRenderer.removeListener("desktop:update-state", handler);
    },
});
