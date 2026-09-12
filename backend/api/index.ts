/**
 * Vercel Serverless entry for NUVI backend.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

let appPromise: Promise<any> | null = null;
let initError: any = null;

async function getApp() {
  if (initError) throw initError;
  if (!appPromise) {
    process.env.VERCEL = "1";
    appPromise = (async () => {
      try {
        // Try multiple import paths to survive different Vercel build layouts:
        // - Local dev / bundled: ../server.js (compiled JS)
        // - Vercel TS runtime: ../server.ts (direct TS)
        let mod: any = null;
        try {
          mod = await import("../server.js");
        } catch (e1: any) {
          // Fallback: Vercel may keep the source as .ts without a pre-build
          try {
            mod = await import("../server.ts");
          } catch (e2: any) {
            // Last fallback: esbuild bundle at dist/server.cjs (CJS interop)
            try {
              const cjs = await import("../dist/server.cjs");
              mod = (cjs as any).default ?? cjs;
            } catch {}
            if (!mod?.createApp) throw e1;
          }
        }
        const createApp = mod.createApp ?? mod.default?.createApp;
        if (!createApp) throw new Error("createApp not found in server module");
        const { app } = await createApp();
        return app;
      } catch (e) {
        initError = e;
        console.error("[Vercel] createApp failed:", e);
        throw e;
      }
    })();
  }
  return appPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const app = await getApp();
    return (app as any)(req, res);
  } catch (e: any) {
    console.error("[Vercel] handler error:", e?.stack || e);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Function invocation failed",
        detail: e?.message || String(e),
        hint: "Check Vercel Function Logs. Ensure GEMINI_API_KEY is set in Vercel Env."
      });
    }
  }
}

export const config = {
  maxDuration: 30
};
