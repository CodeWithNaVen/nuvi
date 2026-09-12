/**
 * NUVI — Frontend config for backend URL.
 *
 * Supports split Vercel deployments:
 *  - https://nuvi.vercel.app (frontend)
 *  - https://nuvi-server.vercel.app (backend + agents + WS)
 *
 * VITE_BACKEND_URL is injected at build time via Vite. Falls back to
 * same-origin (empty string) for local dev / Electron (localhost:3000).
 */

export const BACKEND_URL: string = (() => {
  // Vite exposes env via import.meta.env
  const viteUrl = (import.meta as any)?.env?.VITE_BACKEND_URL as string | undefined;
  if (viteUrl && viteUrl.trim()) {
    return viteUrl.trim().replace(/\/$/, "");
  }
  // Allow NUVI_SERVER_URL as alias (non-VITE prefix for backend parity)
  const alt = (import.meta as any)?.env?.VITE_SERVER_URL as string | undefined;
  if (alt && alt.trim()) return alt.trim().replace(/\/$/, "");
  // Same-origin fallback (Electron / local dev where frontend and backend share origin)
  return "";
})();

export const FRONTEND_URL: string =
  ((import.meta as any)?.env?.VITE_FRONTEND_URL as string | undefined)?.trim().replace(/\/$/, "") || "";

/** Build an API URL: if BACKEND_URL set, prefix it, otherwise same-origin. */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return BACKEND_URL ? `${BACKEND_URL}${p}` : p;
}

/** Build a WebSocket URL for /live. */
export function wsUrl(path: string = "/live"): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (BACKEND_URL) {
    // Convert https:// -> wss:// and http:// -> ws://
    const wsBase = BACKEND_URL.replace(/^http/, "ws");
    return `${wsBase}${p}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${p}`;
}
