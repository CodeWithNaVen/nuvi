/**
 * NUVI — Frontend config for backend URL.
 *
 * Supports split Vercel deployments:
 *  - https://nuviai.vercel.app (frontend)
 *  - https://nuvi-server.vercel.app (backend + agents + WS)
 *
 * VITE_BACKEND_URL is injected at build time via Vite. Falls back to
 * same-origin (empty string) for local dev / Electron (localhost:3000).
 */

function cleanUrl(v: string | undefined): string {
  if (!v) return "";
  // Strip surrounding quotes if user pasted "https://..." with quotes
  let s = v.trim().replace(/^["']|["']$/g, "").trim().replace(/\/$/, "");
  return s;
}
export const BACKEND_URL: string = (() => {
  // Vite exposes env via import.meta.env — must be VITE_ prefix to be inlined at build time
  const viteUrl = cleanUrl((import.meta as any)?.env?.VITE_BACKEND_URL as string | undefined);
  if (viteUrl) return viteUrl;
  // Aliases commonly set on backend but mistakenly expected on frontend
  const alt1 = cleanUrl((import.meta as any)?.env?.VITE_SERVER_URL as string | undefined);
  if (alt1) return alt1;
  const alt2 = cleanUrl((import.meta as any)?.env?.NUVI_SERVER_URL as string | undefined);
  if (alt2) return alt2;
  // Same-origin fallback (Electron / local dev where frontend and backend share origin,
  // or when frontend rewrite proxies /api to the backend deployment)
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
