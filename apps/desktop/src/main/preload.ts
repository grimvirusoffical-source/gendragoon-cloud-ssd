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
  /** Manual "Check for updates". Resolves with the state the cycle ended in. */
  checkForUpdates(): Promise<unknown> {
    return ipcRenderer.invoke("updater:check");
  },
  /** Which distribution this build is and whether it self-updates. */
  getUpdatePolicy(): Promise<unknown> {
    return ipcRenderer.invoke("updater:policy");
  },
  getUpdateState(): Promise<unknown> {
    return ipcRenderer.invoke("updater:state");
  },
  onUpdateState(callback: (state: unknown) => void) {
    ipcRenderer.on("updater-state", (_event, state: unknown) => callback(state));
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
  /** Opens Stripe Checkout in the system browser. The main process refuses any non-Stripe URL. */
  openBilling(url: string): Promise<boolean> {
    return ipcRenderer.invoke("billing:open", url);
  },
  getDeviceName(): Promise<string | null> {
    return ipcRenderer.invoke("device:name");
  },
  getIdToken(): Promise<string | undefined> {
    return ipcRenderer.invoke("auth:id-token");
  },
});
