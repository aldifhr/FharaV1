import { isIP } from "node:net";
import { getDomain, parse } from "tldts";

/**
 * Outbound-URL guard.
 *
 * Kept in its own module (no Stagehand import) so tools that only need to
 * validate a URL — the browser client and the Agent Reach tool — can share
 * one implementation without pulling the browser runtime into every import.
 *
 * Guard against fetching internal/metadata endpoints through the browser.
 * `tldts` owns the domain grammar (public suffix, hostname syntax) instead
 * of a regex; IP literals are classified with `node:net` + an explicit
 * private-CIDR check (tldts does not classify private IPs). Literal +
 * hostname blocks stay for the well-known loopback and cloud-metadata
 * names. ponytail: no DNS-resolution validation yet — this blocks
 * names/IPs, not DNS rebinding to private targets.
 */
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.google", "instance-data"]);

function isPrivateIp(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (kind === 6) {
    const lower = host.toLowerCase();
    return lower === "::1" || lower === "::" || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("fc") || lower.startsWith("fd");
  }
  return false;
}

/** True when the hostname is loopback, private, metadata, or syntactically invalid. */
export function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || METADATA_HOSTS.has(host)) return true;
  if (isIP(host)) return isPrivateIp(host);
  if (parse(host).hostname === null) return true;
  if (!host.includes(".")) return true;
  return getDomain(host) === null;
}

/** Registrable domain (`"sub.example.co.uk"` → `"example.co.uk"`); falls back to the host. */
export function extractDomain(rawHost: string): string {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  return getDomain(host) ?? host;
}

export function assertUrlAllowed(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`Blocked internal URL: ${url.host}`);
  }
  return url;
}
