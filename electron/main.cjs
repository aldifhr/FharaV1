const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");

const DEV_SERVER_URL = process.env.DEV_SERVER_URL || "http://localhost:3000";

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // Robust retry until dev server ready
  let attempts = 0;
  const tryLoad = () => {
    attempts++;
    console.log(`[electron] Loading ${DEV_SERVER_URL} (attempt ${attempts})...`);
    window.loadURL(DEV_SERVER_URL).catch((err) => {
      console.error(`[electron] Load failed: ${err.message}`);
      if (attempts < 30) setTimeout(tryLoad, 2000);
    });
  };

  window.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[electron] did-fail-load ${code} ${desc} ${url}`);
    if (attempts < 30) setTimeout(tryLoad, 2000);
  });

  window.webContents.on("did-finish-load", () => {
    console.log("[electron] Page loaded:", window.webContents.getURL());
  });

  window.on("closed", () => {
    // do nothing on mac
  });

  tryLoad();
}

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Pilih folder project",
  });
  return result.canceled ? null : result.filePaths[0];
});

// Disable sandbox for local dev (common on macOS)
app.commandLine.appendSwitch("no-sandbox");

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
