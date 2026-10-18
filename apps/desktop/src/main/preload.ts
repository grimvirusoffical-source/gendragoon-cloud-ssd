import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("gendragoon", {
  platform: process.platform,
});
