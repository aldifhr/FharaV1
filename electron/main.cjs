const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const DEV_SERVER_URL = process.env.DEV_SERVER_URL || "http://localhost:3000";

// Zoom: Ctrl/Cmd + "=" / "+" / numpad add zooms in, "-" / numpad subtract
// zooms out, "0" resets, plus Ctrl/Cmd + mouse wheel. The level is clamped
// and saved to userData/zoom.json so it survives restarts. The default menu
// (and its zoom roles) stays in place.
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.5;

function zoomFile() {
  return path.join(app.getPath("userData"), "zoom.json");
}

function clampZoom(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 0;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

function readZoom() {
  try {
    return clampZoom(JSON.parse(fs.readFileSync(zoomFile(), "utf8")).zoomLevel);
  } catch {
    return 0;
  }
}

function writeZoom(level) {
  try {
    fs.mkdirSync(path.dirname(zoomFile()), { recursive: true });
    fs.writeFileSync(zoomFile(), JSON.stringify({ zoomLevel: clampZoom(level) }));
  } catch (err) {
    console.error(`[electron] Could not save zoom level: ${err.message}`);
  }
}

function setZoom(webContents, level) {
  const next = clampZoom(level);
  webContents.setZoomLevel(next);
  writeZoom(next);
}

/** "in" | "out" | "reset" for a zoom shortcut, else null. */
function zoomAction(input) {
  if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return null;
  const { key, code } = input;
  if (key === "=" || key === "+" || code === "Equal" || code === "NumpadAdd") return "in";
  if (key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract") return "out";
  if (key === "0" || code === "Digit0" || code === "Numpad0") return "reset";
  return null;
}

function attachZoom(window) {
  const contents = window.webContents;
  contents.on("before-input-event", (event, input) => {
    const action = zoomAction(input);
    if (!action) return;
    event.preventDefault();
    const current = contents.getZoomLevel();
    if (action === "in") setZoom(contents, current + ZOOM_STEP);
    else if (action === "out") setZoom(contents, current - ZOOM_STEP);
    else setZoom(contents, 0);
  });
  // Ctrl/Cmd + mouse wheel.
  contents.on("zoom-changed", (_event, direction) => {
    const current = contents.getZoomLevel();
    setZoom(contents, current + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP));
  });
  // Restore the saved level on every load (navigation can reset it).
  contents.on("did-finish-load", () => contents.setZoomLevel(readZoom()));
  // Keep a level changed through the View menu roles too.
  window.on("close", () => writeZoom(contents.getZoomLevel()));
}

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

  attachZoom(window);

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
    title: "Choose project folder",
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
