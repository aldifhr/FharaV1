/**
 * Nuphos N10 (idea #15): the MCP servers a direct thread's OpenCode is
 * started with, declared on session/new|resume|load.
 *
 * - Rows come from the run context (global + project, enabled only); the
 *   thread's role filters them (`agentRoles`), the same as task runs.
 * - Local rows become ACP stdio servers: command, args with `{workspace}`
 *   and `{env:KEY}` filled, and the decrypted env.
 * - Remote rows become ACP http servers when the agent says it takes them
 *   (mcpCapabilities.http); the row's env is sent as its headers.
 * - Every decrypted value is registered with the L2 redactor
 *   (utils/redact.ts registerSecretValues, used by the N1 stream redactor),
 *   so an agent echoing a token never puts it in taskEvents or a hot row.
 *   Nothing here logs a value: names, counts and the hash only.
 *
 * The set hash (lib/mcpDeclaration.ts) ignores header and env values, so a
 * header-only or secret-only change keeps the live session; any other
 * change releases it between turns (`mcpRestartDue`), never mid-turn.
 * Pattern from Nuphos openab pool.rs `suspend_for_mcp_change` (MIT; no
 * code copied).
 */
import { mcpSetHashFor } from "@/api/convex/lib/mcpDeclaration";
import { mcpRoleAllowed } from "@/api/convex/lib/mcpPresets";
import { registerSecretValues } from "@/utils/redact";
import { decryptServerEnv, redactSecrets, resolveMcpSpawn } from "@/mcp/spawn";
import type { McpServerConfig } from "@/mcp/types";

type NameValue = { name: string; value: string };

/** One ACP `McpServer` (session/new|load|resume `mcpServers`). */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: NameValue[] }
  | { type: "http"; name: string; url: string; headers: NameValue[] };

export type DirectMcpSet = {
  servers: AcpMcpServer[];
  /** tasks.direct.mcpSetHash; "" when the role has no servers. */
  hash: string;
  /** Rows left out, with a reason safe to show (no values). */
  skipped: { name: string; reason: string }[];
};

export const EMPTY_MCP_SET: DirectMcpSet = { servers: [], hash: "", skipped: [] };

/** Build the declaration for a thread. Never throws: a row that can't be built is skipped. */
export async function buildDirectMcpSet(rows: readonly McpServerConfig[] | undefined, role: string | undefined, cwd: string): Promise<DirectMcpSet> {
  const list = (rows ?? []).filter((row) => row.enabled !== false && mcpRoleAllowed(row.agentRoles, role));
  const servers: AcpMcpServer[] = [];
  const skipped: DirectMcpSet["skipped"] = [];
  for (const row of list) {
    let secrets: string[] = [];
    try {
      if (row.type === "remote") {
        if (!row.url) continue;
        const env = await decryptServerEnv(row);
        secrets = Object.values(env);
        registerSecretValues(secrets);
        servers.push({ type: "http", name: row.name, url: row.url.trim(), headers: Object.entries(env).map(([name, value]) => ({ name, value })) });
      } else {
        if (!row.command) continue;
        const spec = await resolveMcpSpawn(row, cwd);
        secrets = spec.secretValues;
        registerSecretValues(Object.values(spec.env));
        servers.push({ name: row.name, command: spec.command, args: spec.args, env: Object.entries(spec.env).map(([name, value]) => ({ name, value })) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({ name: row.name, reason: redactSecrets(message, secrets).slice(0, 200) });
    }
  }
  return {
    servers,
    hash: mcpSetHashFor(
      list.map((row) => ({ ...row, _id: String(row._id) })),
      role
    ),
    skipped,
  };
}

/** The servers this agent can take: http only when it advertises mcpCapabilities.http. */
export function declarableServers(servers: readonly AcpMcpServer[], caps: { http?: boolean } | undefined): { declared: AcpMcpServer[]; dropped: string[] } {
  const declared: AcpMcpServer[] = [];
  const dropped: string[] = [];
  for (const server of servers) {
    if ("type" in server && server.type === "http" && !caps?.http) dropped.push(server.name);
    else declared.push(server);
  }
  return { declared, dropped };
}

/**
 * What the poll does about the MCP set: nothing, wait for the running turn
 * to end (a card wait counts as running), or release the session now so it
 * resumes with the new set.
 */
export function mcpRestartDue(input: { liveHash: string | undefined; wantHash: string | null | undefined; busy: boolean; closing: boolean }): "none" | "wait" | "release" {
  // An API-loop thread declares nothing (liveHash undefined); an older API sends no hash.
  if (input.liveHash === undefined || input.wantHash === undefined || input.wantHash === null) return "none";
  if (input.closing || input.wantHash === input.liveHash) return "none";
  return input.busy ? "wait" : "release";
}
