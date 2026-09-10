const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

let mainWindow = null;
let tray = null;
let backendProcess = null;
const BACKEND_PORT = 877;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const isDev = !app.isPackaged;

function resolveBackendCommand() {
  // In dev, we assume the backend is started separately (see README / start script)
  // via `uv run run.py` or the venv python. In a packaged build we bundle a
  // portable python env under resources/backend and launch it directly.
  if (isDev) return null;

  const backendDir = path.join(process.resourcesPath, "backend");
  const pythonBin =
    process.platform === "win32"
      ? path.join(backendDir, "venv", "Scripts", "python.exe")
      : path.join(backendDir, "venv", "bin", "python");
  return { cmd: pythonBin, args: ["run.py"], cwd: backendDir };
}

function startBackend() {
  const resolved = resolveBackendCommand();
  if (!resolved) {
    console.log("[Nuvi] Dev mode: expecting backend to already be running on", BACKEND_URL);
    return;
  }
  backendProcess = spawn(resolved.cmd, resolved.args, { cwd: resolved.cwd });
  backendProcess.stdout.on("data", (d) => console.log(`[backend] ${d}`));
  backendProcess.stderr.on("data", (d) => console.error(`[backend] ${d}`));
  backendProcess.on("exit", (code) => console.log(`[Nuvi] backend exited: ${code}`));
}

function waitForBackend(retries = 40) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      http
        .get(`${BACKEND_URL}/api/health`, (res) => {
          if (res.statusCode === 200) resolve(true);
          else retry(n);
        })
        .on("error", () => retry(n));
    };
    const retry = (n) => {
      if (n <= 0) return resolve(false);
      setTimeout(() => attempt(n - 1), 500);
    };
    attempt(retries);
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1200, width - 80),
    height: Math.min(800, height - 80),
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#0d0d0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    frame: process.platform !== "win32",
    icon: path.join(__dirname, "renderer", "assets", "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("closed", () => (mainWindow = null));
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, "renderer", "assets", "icons", "tray.png"));
    const menu = Menu.buildFromTemplate([
      { label: "Show Nuvi", click: () => mainWindow?.show() },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray.setToolTip("Nuvi");
    tray.setContextMenu(menu);
    tray.on("click", () => mainWindow?.show());
  } catch (e) {
    console.warn("Tray icon not available:", e.message);
  }
}

app.whenReady().then(async () => {
  startBackend();
  await waitForBackend();
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backendProcess) backendProcess.kill();
});

ipcMain.handle("get-backend-url", () => BACKEND_URL);
ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));
