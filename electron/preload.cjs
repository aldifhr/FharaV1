const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fharaDesktop", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
});
