# AGENT.md — Nuvi

## Overview
Nuvi is a Jarvis-like agentic desktop assistant. Voice-first, with screen vision, holographic browser projection, persistent memory, and full Windows control via a local Python agent. The desktop build is Electron; the web build is Vite + React.

## Tech Stack
- **Frontend:** React 19 + Vite 6 + Tailwind CSS 4 + motion + lucide-react
- **Orb:** Canvas-based `NuviOrb` (no three/gsap) — reactive to live mic/TTS amplitude
- **Backend:** Node 18+ + Express + ws + @google/genai (Gemini 3.1 Flash Live — Aoede, 3.5 Flash memory, 2.5 Flash vision)
- **Desktop Agent:** Python 3.10+ FastAPI (52 tools) on `http://127.0.0.1:8765`
- **Packaging:** Electron 43 + electron-builder (nsis + portable)

## Project Structure
```
nuvi/
  electron/main.cjs       # Electron lifecycle, backend spawn, display media handler
  electron/preload.cjs    # contextBridge only
  electron/splash.html    # splash screen
  desktop_agent/          # FastAPI — apps, files, browser, clipboard, screenshots, startup
  public/                 # Web icons: favicon.ico/png, icon.png, apple-touch-icon.png
  assets/icon.* / build/icon.* # Desktop icons for BrowserWindow + installer
  src/main.tsx            # entry, ApiKeyGate wrapper
  src/App.tsx             # stage (orb/captions/controls) + sidebar (Chat/Settings/Memory)
  src/components/         # NuviOrb, ApiKeyGate, BrowserAgent, MemoryDashboard, SettingsPanel
  src/lib/audio.ts        # NuviAudioSession (16k in / 24k out, live WS)
  src/lib/wakeWord.ts     # NuviWakeWordDetector (Web Speech API)
  src/lib/settingsStore.ts# nuvi.settings.v2 localStorage
  src/lib/memoryTypes.ts  # Memory categories
  server.ts               # Express + Vite dev middleware + /live WS bridge + proxies
  server_memory.ts        # load/save/format memories, Gemini consolidation
  server_paths.ts         # DATA_DIR = NUVI_DATA_DIR || cwd
```

## Commands
```powershell
cd C:\dev\automations\agents\nuvi
npm install
Copy-Item .env.example .env  # set GEMINI_API_KEY

# Desktop agent (separate terminal)
pip install -r desktop_agent/requirements.txt
python -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765

# Web
npm run dev      # http://localhost:3000 (Vite middleware)
npm run build    # vite -> dist/ + esbuild server.ts -> dist/server.cjs
npm start        # node dist/server.cjs
npm run preview
npm run lint     # tsc --noEmit

# Desktop
npm run electron # electron . (requires dist/server.cjs)
npm run app      # build + electron
npm run dist     # electron-builder -> release/
```

## Environment
- `GEMINI_API_KEY` — fallback; primary key is stored via Settings gate in `NUVI_DATA_DIR/secrets.json` (userData in packaged app, cwd in dev)
- `NUVI_DATA_DIR` — writable data dir (memories.json, settings.json, logs/)
- `NUVI_AGENT_EXE` / `NUVI_PYTHON` — frozen agent exe or Python interpreter for auto-spawn
- `.env.example` documents all vars

## Architecture Notes

### Live Voice (`/live`)
`src/lib/audio.ts` streams 16k PCM via `session.sendRealtimeInput({audio})`, plays 24k PCM with gapless `AudioBufferSource` scheduling, exposes `inputAnalyser`/`outputAnalyser` for orb. `server.ts` bridges WS to `ai.live.connect` (Aoede voice), relays transcriptions, tool calls, and `memory_sync`.

### System Prompt & Tools
`server.ts` builds `baseInstructions` (Nuvi persona) + `formatSystemInstructionsWithMemories` (NUVI MEMORY CORE). Tools include `browserOpen/Search/Click/MediaControl/Scroll/Type/GoBack/TabAction`, `changeBackground`, `saveCustomMemory`, and 52 desktop tools routed via `callDesktopAgent` to `http://127.0.0.1:8765/execute`.

### Screen Vision
`src/App.tsx` `getDisplayMedia` + `canvas.toDataURL("image/jpeg",0.55)` → `sendVideoFrame` every 2s. Electron `electron/main.cjs` provides `session.setDisplayMediaRequestHandler` with `desktopCapturer` and `useSystemPicker:true` so the desktop picker works.

### Memory
`memories.json` grouped by `identity/preference/goal/project/relationship/emotional/behavior`. Auto-consolidation via `gemini-3.5-flash` JSON mode in `server_memory.ts:processConversationSlice`.

### Proxies
`server.ts` exposes `/api/proxy` (scrape), `/api/web-proxy` (iframe-safe HTML), `/api/youtube-search`, `/api/memories`, `/api/settings`, `/api/config`, `/api/agent-health`, `/api/logs`.

### UI
- **Stage:** `NuviOrb` + cinematic captions + error banner + controls (screen share, power, keyboard)
- **Sidebar:** tabs Chat / Settings / Memory (inline) + slide-over `MemoryDashboard`/`SettingsPanel` for advanced
- **Themes:** `src/index.css` CSS vars (`claude-code`/`midnight`/`light` + `data-theme-color` overlays) persisted as `nuvi.theme` / `nuvi.themeColor`
- Icons: `lucide-react` only, no emoji

## Code Style
- TypeScript strict, `tsc --noEmit` must pass
- `motion` for transitions, `lucide-react` for icons
- No emoji in code/UI
- Keep `DATA_DIR` isolation: Nuvi never reads Myraa paths

## Data Locations (Windows)
- Dev: `C:\dev\automations\agents\nuvi\memories.json` etc.
- Packaged: `%APPDATA%\nuvi\` (lowercase, `com.nuvi.desktop`)
- Logs: `%APPDATA%\nuvi\logs\` or `nuvi/logs/` in dev

## Troubleshooting
- `Backend bundle not found` → `npm run build`
- `NO_API_KEY` → add key in gate or `.env`
- Screen share `Not Supported` on desktop → fixed via `setDisplayMediaRequestHandler`; reload with `npm run app`
- `chunked_data_pipe ... Error -2` on WS close → harmless Chromium log
