import { promises as fs } from "node:fs";
import path from "node:path";
import { splitHostHeader, type GuardInput } from "./requestGuard";
import { isInside } from "./projectFilesPolicy";

/**
 * Policy for /api/open-in: open a project folder or a task worktree in a
 * local editor or file manager. Pure node code (no Next imports) so it is
 * unit-tested directly.
 *
 *  - Loopback only. The Host must be a loopback name (FHARA_ALLOWED_HOSTS is
 *    ignored here: a LAN address must never start programs on this machine),
 *    the Origin must name the same loopback server, and a forwarding header
 *    that names any other client is refused.
 *  - A fixed launcher allowlist. The request picks a launcher id, never a
 *    command; the command runs through execFile with no shell.
 *  - The folder is resolved server-side (project workspace or the task's
 *    worktree) and must realpath() under a known root.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const NOT_LOOPBACK = "Open in is only available from this computer (loopback).";
const CROSS_ORIGIN = "Cross-origin request rejected.";

function isLoopbackAddress(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^"|"$/g, "").replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "localhost") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(v.replace(/^::ffff:/, ""));
}

export type LoopbackVerdict = { ok: true } | { ok: false; reason: string };

export function checkLoopbackRequest(input: GuardInput): LoopbackVerdict {
  const host = input.headers.get("host");
  const hostParts = host ? splitHostHeader(host) : null;
  if (!hostParts || !LOOPBACK_HOSTS.has(hostParts.hostname)) return { ok: false, reason: NOT_LOOPBACK };
  // Every hop a proxy recorded must be this machine too.
  for (const name of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
    const raw = input.headers.get(name);
    if (raw === null) continue;
    const addresses =
      name === "forwarded"
        ? [...raw.matchAll(/for=("?)([^;,"]+)\1/gi)].map((m) => m[2].replace(/^(\[[^\]]+\]):\d+$/, "$1").replace(/^([\d.]+):\d+$/, "$1"))
        : raw.split(",");
    if (addresses.length === 0 || addresses.some((a) => !isLoopbackAddress(a))) return { ok: false, reason: NOT_LOOPBACK };
  }
  const origin = input.headers.get("origin");
  if (!origin) return { ok: false, reason: CROSS_ORIGIN };
  let originHost: { hostname: string; port: string } | null = null;
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" || url.protocol === "https:") {
      originHost = splitHostHeader(url.port ? `${url.hostname}:${url.port}` : url.hostname);
    }
  } catch {
    originHost = null;
  }
  if (!originHost || !LOOPBACK_HOSTS.has(originHost.hostname) || originHost.port !== hostParts.port) {
    return { ok: false, reason: CROSS_ORIGIN };
  }
  const site = input.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return { ok: false, reason: CROSS_ORIGIN };
  return { ok: true };
}

export type LauncherId = "vscode" | "cursor" | "files";

export const LAUNCHERS: Record<LauncherId, { label: string }> = {
  vscode: { label: "VS Code" },
  cursor: { label: "Cursor" },
  files: { label: "File manager" },
};

export function isLauncherId(value: unknown): value is LauncherId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LAUNCHERS, value);
}

/** The program and arguments for a launcher; the (absolute) folder is the only argument. */
export function launcherCommand(
  id: LauncherId,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  switch (id) {
    case "vscode":
      return { file: platform === "win32" ? "code.cmd" : "code", args: [folder] };
    case "cursor":
      return { file: platform === "win32" ? "cursor.cmd" : "cursor", args: [folder] };
    case "files":
      if (platform === "darwin") return { file: "open", args: [folder] };
      if (platform === "win32") return { file: "explorer.exe", args: [folder] };
      return { file: "xdg-open", args: [folder] };
  }
}

export class OpenInPolicyError extends Error {}

/**
 * Real path of `candidate` when it is a directory inside one of `roots`
 * (each realpath'd here). Throws OpenInPolicyError otherwise.
 */
export async function resolveOpenTarget(candidate: string, roots: string[]): Promise<string> {
  if (!candidate || candidate.includes("\0") || !path.isAbsolute(candidate)) {
    throw new OpenInPolicyError("Invalid folder");
  }
  const realRoots: string[] = [];
  for (const root of roots) {
    if (!root || !path.isAbsolute(root)) continue;
    try {
      realRoots.push(await fs.realpath(root));
    } catch {
      // A root that does not exist cannot contain anything.
    }
  }
  if (realRoots.length === 0) throw new OpenInPolicyError("No known project folder");
  let real: string;
  try {
    real = await fs.realpath(path.resolve(candidate));
  } catch {
    throw new OpenInPolicyError("Folder not found");
  }
  if (!realRoots.some((root) => isInside(root, real))) throw new OpenInPolicyError("Folder is outside the project");
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new OpenInPolicyError("Not a folder");
  return real;
}
