import { wenv } from "@fhara/config/worker";
import { FharaRuntimeClient, FharaRuntimeHttpClient } from "@fhara/runtime/browser";

export function createFharaRuntimeClient(): FharaRuntimeHttpClient {
  const url = wenv("FHARA_BACKEND_URL"); // legacy alias FHARA_BACKEND_URL
  if (!url) throw new Error("FHARA_BACKEND_URL missing");
  const token = wenv("FHARA_SERVICE_TOKEN");
  if (!token) throw new Error("FHARA_SERVICE_TOKEN missing");
  return new FharaRuntimeHttpClient(url);
}

/**
 * Websocket client for the worker's wake-up subscription (onUpdate).
 * Mutations and actions stay on the HTTP client. Returns null when the
 * subscription is disabled (WORKER_SUBSCRIBE=0) or this Node has no global
 * WebSocket; the worker then runs on its poll alone.
 */
export function createFharaRuntimeSubscriber(): FharaRuntimeClient | null {
  if (!wenv("WORKER_SUBSCRIBE")) return null;
  const url = wenv("FHARA_BACKEND_URL");
  if (!url || typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "function") return null;
  return new FharaRuntimeClient(url, { unsavedChangesWarning: false });
}
