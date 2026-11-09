import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * SSRF guard for server-side fetches the caller points at a URL (Browser
 * Lab, release audit P0-6). A URL passes only when it is http(s) and every
 * address its host resolves to is a public unicast address: loopback,
 * private (RFC 1918 / ULA), link-local (incl. 169.254.169.254 metadata),
 * CGNAT, multicast, reserved and unspecified ranges are refused, as are
 * IPv4-mapped / NAT64 forms of them.
 *
 * Limitation: the check resolves DNS itself, then the browser resolves
 * again, so a DNS-rebinding host with a near-zero TTL can still race it.
 * Every request (including each redirect hop) is re-checked, which narrows
 * but does not close that window.
 */

const blocked = new BlockList();
// IPv4
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network, unspecified
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local + cloud metadata
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
blocked.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1
blocked.addSubnet("192.88.99.0", 24, "ipv4"); // 6to4 relay
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
blocked.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2
blocked.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
// IPv6
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6"); // ULA
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("fec0::", 10, "ipv6"); // site-local (deprecated)
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast
blocked.addSubnet("2001:db8::", 32, "ipv6"); // documentation
blocked.addSubnet("100::", 64, "ipv6"); // discard

/** Embedded IPv4 of ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96 (NAT64) forms. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all: refuse
}

export class UrlBlockedError extends Error {}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Throws UrlBlockedError unless `raw` is an http(s) URL whose host resolves
 * only to public addresses. Returns the normalised URL.
 */
export async function assertPublicHttpUrl(raw: string, resolve: Resolver = defaultResolver): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlBlockedError("Provide an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UrlBlockedError("Only http and https URLs are allowed");
  if (url.username || url.password) throw new UrlBlockedError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UrlBlockedError("URL has no host");
  const lowered = host.toLowerCase();
  if (lowered === "localhost" || lowered.endsWith(".localhost") || lowered.endsWith(".internal") || lowered.endsWith(".local")) {
    throw new UrlBlockedError("Local and internal hosts are not allowed");
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new UrlBlockedError(`Could not resolve ${host}`);
    }
  }
  if (addresses.length === 0) throw new UrlBlockedError(`Could not resolve ${host}`);
  if (addresses.some(isBlockedAddress)) {
    throw new UrlBlockedError("Private, loopback, link-local and metadata addresses are not allowed");
  }
  return url.toString();
}
