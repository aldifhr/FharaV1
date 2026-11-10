// O6 (plan 043): find this machine's Tailscale address so the web UI can be
// reached from the user's own devices over the tailnet only.
//
// The address detection follows recailai/jockey@c744935
// src-tauri/src/web_gateway/mod.rs:169-227 (`detect_network_ips`: ask the
// `tailscale ip -4` CLI first, then fall back to the interface list for a
// 100.x address). MIT, © 2026 JockeyUI Contributors (THIRD_PARTY_NOTICES.md).
// Changed by Fhara: Node's os.networkInterfaces() instead of ifconfig, the
// CGNAT range 100.64.0.0/10 is checked exactly, and no URL token: Fhara adds
// no login, the tailnet is the boundary.
import { execFileSync } from "node:child_process";
import os from "node:os";

/** FHARA_BIND_TAILSCALE=1|true|on|yes. */
export function wantsTailscale(env) {
  return ["1", "true", "on", "yes"].includes(String(env.FHARA_BIND_TAILSCALE ?? "").trim().toLowerCase());
}

/** 100.64.0.0/10 (Tailscale's CGNAT range). */
export function isTailscaleIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip ?? "").trim());
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 100 && b >= 64 && b <= 127;
}

/** First Tailscale IPv4 in an os.networkInterfaces() map (tailscale0 / utun names first). */
export function pickTailscaleIPv4(interfaces) {
  const names = Object.keys(interfaces ?? {}).sort((x, y) => rank(x) - rank(y));
  for (const name of names) {
    for (const addr of interfaces[name] ?? []) {
      const v4 = addr.family === "IPv4" || addr.family === 4;
      if (v4 && !addr.internal && isTailscaleIPv4(addr.address)) return addr.address;
    }
  }
  return null;
}
const rank = (name) => (/^tailscale/i.test(name) ? 0 : /^utun/i.test(name) ? 1 : 2);

/** `tailscale ip -4` output → the address, or null. */
export function parseTailscaleIpOutput(stdout) {
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (isTailscaleIPv4(line.trim())) return line.trim();
  }
  return null;
}

const CLI_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

/** The Tailscale IPv4 of this machine, or null (CLI first, then interfaces). */
export function detectTailscaleIPv4({ exec = execFileSync, interfaces = os.networkInterfaces() } = {}) {
  for (const bin of CLI_CANDIDATES) {
    try {
      const ip = parseTailscaleIpOutput(exec(bin, ["ip", "-4"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
      if (ip) return ip;
    } catch {
      // not installed here; try the next one
    }
  }
  return pickTailscaleIPv4(interfaces);
}

/** The MagicDNS name (machine.tailnet.ts.net), or null. Best effort. */
export function detectTailscaleDnsName({ exec = execFileSync } = {}) {
  for (const bin of CLI_CANDIDATES) {
    try {
      const status = JSON.parse(exec(bin, ["status", "--json"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
      const name = String(status?.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
      return /^[a-z0-9.-]+$/.test(name) && name ? name : null;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** The port Next will use: -p/--port flag, then PORT, then 3000. */
export function nextPort(args, env) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) return Number(args[i + 1]);
    const m = /^--port=(\d+)$/.exec(args[i]);
    if (m) return Number(m[1]);
  }
  const fromEnv = Number(env.PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 3000;
}

/** FHARA_ALLOWED_HOSTS with the tailnet names added (deduped). */
export function withAllowedHosts(current, extra) {
  const list = String(current ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (const h of extra) if (h && !list.includes(h)) list.push(h);
  return list.join(",");
}
