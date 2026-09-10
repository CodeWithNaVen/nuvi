const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nuvi", {
  getBackendUrl: () => ipcRenderer.invoke("get-backend-url"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
