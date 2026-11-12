/**
 * Where the Convex backend runs, from its deployment URL. Pure (no node
 * imports): shared by the dev-fixtures guard and the worker's isolation
 * choice (ORCHESTRATOR_WORKTREE_ISOLATION=auto).
 *
 * - local:       a loopback host (localhost, 127.x, ::1, *.localhost).
 * - self_hosted: any other host that is not *.convex.cloud / *.convex.site.
 * - cloud:       a Convex cloud deployment; its Node actions cannot see the worker's disk.
 * - unknown:     no URL, or one that does not parse.
 */
export type BackendLocality = "local" | "self_hosted" | "cloud" | "unknown";

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|[\w.-]+\.localhost)$/i;
const CONVEX_CLOUD = /\.convex\.(?:cloud|site)$/i;

export function backendLocality(url: string | undefined | null): BackendLocality {
  const raw = url?.trim();
  if (!raw) return "unknown";
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return "unknown";
  }
  if (LOOPBACK.test(host)) return "local";
  return CONVEX_CLOUD.test(host) ? "cloud" : "self_hosted";
}
