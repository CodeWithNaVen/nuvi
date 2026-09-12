/**
 * Vercel Serverless entry for NUVI backend.
 * Deployed as https://nuvi-server.vercel.app
 *
 * Vercel will import this file as a serverless function.
 * We lazily create the Express app via createApp() from server.ts.
 * WebSocket (/live) is not supported on Vercel serverless functions —
 * the frontend will fallback to REST or show a message; for full Live
 * support deploy with Vercel Fluid Compute or a long-running host.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

let appPromise: Promise<any> | null = null;

async function getApp() {
  if (!appPromise) {
    // Ensure VERCEL env is set before importing server.ts (it checks it)
    process.env.VERCEL = "1";
    const { createApp } = await import("../server");
    appPromise = createApp().then(({ app }) => app);
  }
  return appPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const app = await getApp();
  // Delegate to Express
  return (app as any)(req, res);
}
