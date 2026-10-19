import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gendragoon", {
  platform: process.platform,
  setTransferActive(active: boolean) {
    ipcRenderer.send("transfer-active", active === true);
  },
  onUpdaterNotice(callback: (text: string) => void) {
    ipcRenderer.on("updater-notice", (_event, text: unknown) => {
      if (typeof text === "string") callback(text);
    });
  },
  getSecret(name: string): Promise<Uint8Array | null> {
    return ipcRenderer.invoke("secret:get", name);
  },
  setSecret(name: string, bytes: Uint8Array): Promise<void> {
    return ipcRenderer.invoke("secret:set", name, bytes);
  },
  deleteSecret(name: string): Promise<void> {
    return ipcRenderer.invoke("secret:delete", name);
  },
  getIdToken(): Promise<string | undefined> {
    return ipcRenderer.invoke("auth:id-token");
  },
});
