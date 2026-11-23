/**
 * The browser talks to the local FharaRuntime. Vite has no server-side env
 * inlining, so the backend URL comes from a global set at bootstrap (or the
 * client falls back to its own default).
 */
export function publicFharaRuntimeUrl(): string | undefined {
  const globalUrl = (globalThis as any).__FHARA_BACKEND_URL__;
  if (typeof globalUrl === "string" && globalUrl) return globalUrl;
  return "http://127.0.0.1:8787";
}
