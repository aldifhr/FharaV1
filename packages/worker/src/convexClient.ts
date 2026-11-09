import { ConvexClient, ConvexHttpClient } from "convex/browser";

export function createConvexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL missing");
  const token = process.env.CONVEX_SERVICE_TOKEN;
  if (!token) throw new Error("CONVEX_SERVICE_TOKEN missing");
  return new ConvexHttpClient(url);
}

/**
 * Websocket client for the worker's wake-up subscription (onUpdate).
 * Mutations and actions stay on the HTTP client. Returns null when the
 * subscription is disabled (WORKER_SUBSCRIBE=0) or this Node has no global
 * WebSocket; the worker then runs on its poll alone.
 */
export function createConvexSubscriber(): ConvexClient | null {
  if (process.env.WORKER_SUBSCRIBE === "0") return null;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL;
  if (!url || typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "function") return null;
  return new ConvexClient(url, { unsavedChangesWarning: false });
}
