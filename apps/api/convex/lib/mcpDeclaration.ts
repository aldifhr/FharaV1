/**
 * Nuphos N10 (idea #15): which MCP servers a direct thread's agent is
 * started with, as a stable identity and a short hash.
 *
 * The rule follows Nuphos `mcp_declaration_changed` (openab pool.rs, MIT;
 * pattern only, no code copied): headers carry credentials, so they never
 * count as a change. Fhara extends that to the env of a local server: its
 * values are secrets and are left out; only the key NAMES count. So a
 * rotated token (secret-only) or a new header value (header-only) keeps the
 * live session, while adding, removing, renaming or re-pointing a server
 * (command, args template, URL, env key set, enabled, role allowlist)
 * changes the hash and the worker releases the session between turns.
 *
 * Args are hashed as stored: `{env:KEY}` and `{workspace}` tokens are not
 * filled, so no secret reaches the identity or the hash.
 *
 * Pure: shared by the Convex poll (directThreads.poll) and the worker
 * (direct/mcpDeclare.ts), so both sides compute the same hash.
 */
import { mcpRoleAllowed } from "./mcpPresets";

export type McpDeclarationRow = {
  _id: string;
  name: string;
  type: string;
  url?: string;
  command?: string;
  args?: string;
  enabled?: boolean;
  agentRoles?: string[];
  envKeys?: string[];
};

export type McpIdentity =
  | { id: string; name: string; transport: "stdio"; command: string; args: string; envKeys: string[] }
  | { id: string; name: string; transport: "http"; url: string };

/** The rows a role's direct thread declares, as identities (no secrets), in a stable order. */
export function mcpIdentities(rows: readonly McpDeclarationRow[], role: string | undefined): McpIdentity[] {
  const out: McpIdentity[] = [];
  for (const row of rows) {
    if (row.enabled === false) continue;
    if (!mcpRoleAllowed(row.agentRoles, role)) continue;
    const id = String(row._id);
    if (row.type === "remote") {
      if (row.url) out.push({ id, name: row.name, transport: "http", url: row.url.trim() });
      continue;
    }
    if (!row.command) continue;
    out.push({
      id,
      name: row.name,
      transport: "stdio",
      command: row.command,
      args: row.args ?? "",
      envKeys: [...new Set(row.envKeys ?? [])].sort(),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Two FNV-1a 32-bit passes (different seeds) over the identity JSON, as 16 hex chars ("" for no servers). */
export function mcpSetHash(identities: readonly McpIdentity[]): string {
  if (!identities.length) return "";
  const text = JSON.stringify(identities);
  const pass = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return pass(0x811c9dc5) + pass(0x050c5d1f);
}

/** The hash a direct thread for `role` should be running with now. */
export function mcpSetHashFor(rows: readonly McpDeclarationRow[], role: string | undefined): string {
  return mcpSetHash(mcpIdentities(rows, role));
}

/** Effort values are free-form (the agent advertises its own); this bounds them. */
export const DIRECT_EFFORT_MAX = 32;
export function normalizeDirectEffort(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v || v === "default") return null;
  if (v.length > DIRECT_EFFORT_MAX || !/^[a-z0-9_-]+$/.test(v)) throw new Error("Effort must be a short word such as low, medium or high.");
  return v;
}
