import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vizzoChangesPreferences", {
  getAuto: (): boolean => ipcRenderer.sendSync("changes:auto-message:get") === true,
  setAuto: (enabled: boolean): void => { ipcRenderer.sendSync("changes:auto-message:set", enabled); },
});
