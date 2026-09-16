/* ===========================================================================
 * NUVI — Electron main process (Phase 1)
 * ---------------------------------------------------------------------------
 * Responsibilities in this phase:
 *   1. Enforce a single running instance.
 *   2. Launch the existing Node backend (server.ts, bundled to dist/server.cjs)
 *      silently as a child process — no console window, no browser tab.
 *   3. Show a splash window while the backend boots, then load the real UI
 *      (http://localhost:3000) into the main application window.
 *   4. Clean up the backend (and its child Python agent) on quit.
 *
 * Tray, window-state persistence, close-to-tray and notifications arrive in
 * Phase 2; installer/auto-update/PyInstaller in later phases. The backend and
 * AI logic are reused verbatim — nothing here reimplements chat/memory/voice.
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog, desktopCapturer, session } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch { /* updater not available in dev without install */ }

// --- Constants -------------------------------------------------------------
const DEFAULT_PORT = 3000;
let SERVER_PORT = DEFAULT_PORT;
let SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 40_000;

// In development we run from the repo root; when packaged the app files live in
// resources/app (asar-unpacked handling is added in the packaging phase).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Single-instance guard — second launches focus the existing window instead of
// starting a second backend on the same port.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
    );
  }

  // Use the Node runtime bundled with Electron (ELECTRON_RUN_AS_NODE) so the
  // machine does not need a separate Node install once packaged.
  // Data (memories, settings, secrets, logs) must live in a writable per-user
  // folder — the install dir under Program Files is read-only.
  const dataDir = app.getPath('userData');

  // Frozen Python desktop agent (bundled as an extraResource when packaged).
  // In development this file won't exist, so the backend falls back to running
  // the agent from source with a local Python interpreter.
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'nuvi-agent.exe')
    : path.join(APP_ROOT, 'agent_dist', 'nuvi-agent', 'nuvi-agent.exe');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    NUVI_LAUNCHED_BY: 'electron',
    NUVI_DATA_DIR: dataDir,
    NUVI_APP_ROOT: APP_ROOT,
  };
  if (fs.existsSync(agentExe)) {
    env.NUVI_AGENT_EXE = agentExe;
    console.log(`[Nuvi] Desktop agent exe found: ${agentExe}`);
  } else {
    console.warn(`[Nuvi] Desktop agent exe NOT found at: ${agentExe} — desktop tools will rely on auto-detection at runtime.`);
  }

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Parse actual port from server stdout (it picks a free port if 3000 is occupied)
  const portPromise = new Promise((resolve) => {
    let resolved = false;
    serverProcess.stdout?.on('data', (d) => {
      const text = d.toString();
      process.stdout.write(`[server] ${text}`);
      if (!resolved) {
        const match = text.match(/localhost:(\d+)/);
        if (match) {
          const detected = parseInt(match[1], 10);
          if (detected && detected !== SERVER_PORT) {
            SERVER_PORT = detected;
            SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
            console.log(`[Nuvi] Server started on alternative port ${SERVER_PORT}`);
          }
          resolved = true;
          resolve();
        }
      }
    });
    // Fallback: resolve after 3s even if no port detected (server might not log it)
    setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 3000);
  });

  serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code, signal) => {
    if (!isQuitting) {
      dialog.showErrorBox(
        'NUVI backend stopped',
        `The NUVI backend process exited unexpectedly (code ${code}, signal ${signal}).`,
      );
      app.quit();
    }
  });

  return portPromise;
}
function stopBackend() {
  if (serverProcess && !serverProcess.killed) {
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree so the auto-spawned Python agent goes too.
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }
  serverProcess = null;
}

/** Poll the backend until it answers with a Nuvi-specific response, or reject on timeout. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      // Use /api/config — a JSON endpoint unique to the Nuvi backend.
      // Avoids matching another app that may be on the same port.
      const req = http.get(`${SERVER_ORIGIN}/api/config`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          // /api/config returns {"hasApiKey":...} — verify it's actually Nuvi
          if (body.includes('hasApiKey')) {
            resolve();
          } else if (Date.now() > deadline) {
            reject(new Error('Backend did not become ready in time.'));
          } else {
            setTimeout(tryOnce, 400);
          }
        });
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Backend did not become ready in time.'));
        } else {
          setTimeout(tryOnce, 400);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => (splashWindow = null));
}

function createMainWindow() {
  const iconPath = path.join(APP_ROOT, 'assets', 'icon.png');
  const fallbackIcon = path.join(APP_ROOT, 'build', 'icon.png');
  const winIcon = fs.existsSync(iconPath) ? iconPath : (fs.existsSync(fallbackIcon) ? fallbackIcon : undefined);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false, // revealed on ready-to-show to avoid a white flash
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'NUVI',
    icon: winIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Screen capture for Electron — getDisplayMedia is not natively supported,
  // must be handled via desktopCapturer. This makes the "Share Screen" button
  // in App.tsx work identically to the web version.
  // Uses the default session handler (Electron 30+ API).
  try {
    const ses = session.defaultSession;
    ses.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        if (sources.length === 0) {
          callback({});
          return;
        }
        callback({
          video: request.videoRequested ? sources[0] : undefined,
          audio: request.audioRequested ? 'loopback' : undefined,
        });
      }).catch(() => callback({}));
    }, { useSystemPicker: true });

    ses.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'media' || permission === 'display-capture') callback(true);
      else callback(false);
    });
  } catch (e) {
    console.warn('[Nuvi] setDisplayMediaRequestHandler failed:', e.message);
  }

  try {
    mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        callback({ video: sources[0] });
      });
    });
  } catch {}

  // Open external links (http/https to non-local hosts) in the real browser
  // instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.close();
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('closed', () => (mainWindow = null));

  mainWindow.loadURL(SERVER_ORIGIN);
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
// ---------------------------------------------------------------------------
function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: ${info.version}`);
    if (mainWindow) mainWindow.webContents.send('nuvi:update-available', info);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Downloaded ${info.version}, will install on quit`);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Nuvi Update Ready',
      message: `Nuvi ${info.version} downloaded. Restart to install?`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) { isQuitting = true; autoUpdater.quitAndInstall(); }
    });
  });
  autoUpdater.on('error', (e) => console.warn('[Updater] error', e?.message || e));
  // check 5s after boot, then every 4h
  setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch(()=>{}), 5000);
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(()=>{}), 4 * 60 * 60 * 1000);
}

async function bootstrap() {
  app.setAppUserModelId('com.nuvi.desktop');
  createSplashWindow();

  try {
    await startBackend(); // waits for port detection
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    createMainWindow();
    setupAutoUpdater();
  } catch (err) {
    if (splashWindow) splashWindow.close();
    dialog.showErrorBox(
      'NUVI failed to start',
      `${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  // Phase 2 introduces close-to-tray; for now quitting when all windows close
  // is the expected behaviour on Windows.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

process.on('exit', stopBackend);
