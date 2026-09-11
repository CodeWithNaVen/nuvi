# Nuvi — Jarvis-like Agentic Desktop Assistant

Clean rebrand of Myraa AI as **Nuvi**, using the same proven tech stack with a refined, production-grade UI.

## Tech Stack
- **Frontend**: React 19 + Vite 6 + Tailwind CSS 4 + motion + lucide-react
- **Backend**: Node.js + Express + ws (WebSocket) + @google/genai (Gemini 3.1 Flash Live)
- **Desktop Agent**: Python FastAPI (52 tools) — apps, files, system, browser automation, screen reading
- **Packaging**: Electron 43

## Quick Start
```bash
npm install
# Set your Gemini key (or paste in-app on first launch)
copy .env.example .env
# Edit .env and set GEMINI_API_KEY

npm run dev          # dev server on http://localhost:3000
npm run build        # production build -> dist/
npm run electron     # build + launch Electron
```

## Branding
- Product name: **Nuvi**
- Env prefix: `NUVI_*` (`NUVI_DATA_DIR`, `NUVI_AGENT_EXE`, `NUVI_PYTHON`)
- Data dir: `%APPDATA%/Nuvi` when packaged, otherwise project root
- All user-facing strings, logs, and API messages use "Nuvi"

## UI Layout
Derived from `frontend_reference/` (clean two-panel: stage + sidebar).
- Left **Stage**: reactive orb, cinematic captions, connection controls
- Right **Sidebar**: Chat / Settings / Memory tabs
- No emojis — only `lucide-react` icons

## Desktop Control
The Python agent at `desktop_agent/` provides 52 tools (open app, file ops, volume, screenshot OCR, Playwright browser, etc.).
The Node backend auto-spawns it or connects to `http://127.0.0.1:8765`.

## Environment Variables
See `.env.example`.

## License
MIT


Commands:
```bash
    pip install -r desktop_agent/requirements.txt

    python -m unicorn desktop_agent.main:app --host 127.0.0.1 --port 8765
    #or
    python -m desktop_agent.main

    npm run dev

    npm run electron
 opencode -s ses_f74f2c4c3ffeDHNPP0JFSzmRAG
```