const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("moagentDesktop", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
});
