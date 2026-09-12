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
        const { createApp } = await import("../server.js");
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
