/**
 * Origin / Host guard for the web server's `/api/*` routes (release audit
 * P0-4).
 *
 * Fhara is single-user and local. The API routes have no session, so the
 * only thing standing between them and the rest of the world is:
 *
 *  1. The server binds to 127.0.0.1 by default (see scripts/next.mjs).
 *  2. Every `/api/*` request must carry a `Host` header we expect. This
 *     defeats DNS rebinding (an attacker domain resolving to 127.0.0.1).
 *  3. Every mutating request (anything but GET/HEAD/OPTIONS) must be
 *     same-origin. A cross-site `fetch`/form POST always carries an `Origin`
 *     header (or, in older browsers, `Sec-Fetch-Site`), so a page the user
 *     happens to visit cannot drive `localhost:3000/api/*`.
 *
 * Allowed hosts: localhost, 127.0.0.1 and [::1] on any port, plus whatever
 * FHARA_ALLOWED_HOSTS lists (comma-separated `host` or `host:port`). Set it
 * when you deliberately serve the UI on a LAN address or a domain.
 *
 * The module is pure (no Next imports) so the same checks run in
 * `proxy.ts`, inside the route handlers, and in the unit tests.
 */

export type GuardInput = {
  method: string;
  headers: { get(name: string): string | null };
};

export type GuardResult = { ok: true } | { ok: false; status: number; reason: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Split `host[:port]` (IPv6 hosts in brackets) into lower-case parts. */
export function splitHostHeader(value: string): { hostname: string; port: string } | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const v6 = /^(\[[0-9a-f:.]+\])(?::(\d+))?$/.exec(trimmed);
  if (v6) return { hostname: v6[1], port: v6[2] ?? "" };
  const plain = /^([a-z0-9.-]+)(?::(\d+))?$/.exec(trimmed);
  if (!plain) return null;
  return { hostname: plain[1], port: plain[2] ?? "" };
}

function extraAllowedHosts(env: Record<string, string | undefined>): string[] {
  return (env.FHARA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedHost(hostHeader: string | null, env: Record<string, string | undefined> = process.env): boolean {
  if (!hostHeader) return false;
  const parts = splitHostHeader(hostHeader);
  if (!parts) return false;
  if (LOOPBACK_HOSTNAMES.has(parts.hostname)) return true;
  const full = parts.port ? `${parts.hostname}:${parts.port}` : parts.hostname;
  return extraAllowedHosts(env).some((allowed) => allowed === full || allowed === parts.hostname);
}

/** Loopback aliases on the same port are the same server. */
function sameServer(a: { hostname: string; port: string }, b: { hostname: string; port: string }): boolean {
  if (a.port !== b.port) return false;
  if (a.hostname === b.hostname) return true;
  return LOOPBACK_HOSTNAMES.has(a.hostname) && LOOPBACK_HOSTNAMES.has(b.hostname);
}

function originParts(origin: string): { hostname: string; port: string } | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port || "";
    return splitHostHeader(port ? `${url.hostname}:${port}` : url.hostname);
  } catch {
    return null;
  }
}

/** Normalise a missing default port so `Host: x` matches `Origin: http://x:80`. */
function withDefaultPort(p: { hostname: string; port: string }, fallback: string) {
  return { hostname: p.hostname, port: p.port || fallback };
}

/**
 * True when the request's `Origin` names the server it was sent to.
 * `strict` additionally requires the header to be present (used for the
 * local-MCP opt-in, which must come from the Fhara UI itself).
 */
export function isSameOrigin(input: GuardInput, strict = false): boolean {
  const host = input.headers.get("host");
  const hostParts = host ? splitHostHeader(host) : null;
  if (!hostParts) return false;
  const origin = input.headers.get("origin");
  if (!origin || origin === "null") {
    if (origin === "null") return false;
    if (strict) return false;
    // No Origin: not a cross-site browser request unless Fetch Metadata says so.
    const site = input.headers.get("sec-fetch-site");
    return !site || site === "same-origin" || site === "none";
  }
  const parts = originParts(origin);
  if (!parts) return false;
  const scheme = origin.toLowerCase().startsWith("https:") ? "443" : "80";
  if (!sameServer(withDefaultPort(parts, scheme), withDefaultPort(hostParts, scheme))) return false;
  const site = input.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

export function checkApiRequest(input: GuardInput, env: Record<string, string | undefined> = process.env): GuardResult {
  if (!isAllowedHost(input.headers.get("host"), env)) {
    return {
      ok: false,
      status: 403,
      reason: "Host not allowed. Add it to FHARA_ALLOWED_HOSTS if you serve Fhara on this address.",
    };
  }
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  if (!isSameOrigin(input)) {
    return { ok: false, status: 403, reason: "Cross-origin request rejected." };
  }
  return { ok: true };
}
