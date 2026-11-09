/**
 * Plan 009: MCP tool → action mapping and per-agent permission matrix.
 *
 * Two layers, deliberately:
 *  1. `filterToolsForAgent` decides which discovered tools the LLM may see.
 *  2. `authorizeToolCall` re-checks the same decision at call time — a
 *     tool that was filtered out must never execute, even if the model
 *     hallucinates its name or a stale prompt lists it.
 *
 * The matrix is fail-closed: an unknown tool name is denied, an unknown
 * role gets the most restrictive row, and the write knob defaults to
 * `false` (MCP is read-only for the LLM in this plan; `code_change` owns
 * writes through the approval-gated diff pipeline).
 */

import * as path from "node:path";
import { validateFilePath } from "@/governance/tools";
import { resolveWithinRootsAsync } from "@/tools/sandbox";
import { presetChecksPaths, presetToolAction } from "@/api/convex/lib/mcpPresets";
import type { McpToolAction, McpToolDefinition } from "./types";

/** Tool → action map for the reference filesystem server's tool surface. */
const TOOL_ACTIONS: Record<string, McpToolAction> = {
  read_file: "read",
  // Current @modelcontextprotocol/server-filesystem (2.x) names.
  read_text_file: "read",
  read_media_file: "read",
  list_directory_with_sizes: "list",
  read_multiple_files: "read",
  list_directory: "list",
  directory_tree: "list",
  get_file_info: "read",
  list_allowed_directories: "list",
  search_files: "read",
  glob_file_search: "read",
  grep: "read",
  write_file: "write",
  edit_file: "write",
  create_directory: "write",
  move_file: "move",
  delete_file: "delete",
};

export const REASON_TOOL_UNKNOWN = "mcp-tool-unknown";
export const REASON_TOOL_DENIED = "mcp-tool-denied";
export const REASON_PATH_INVALID = "mcp-path-invalid";
export const REASON_PATH_OUTSIDE = "mcp-path-outside-roots";
export const REASON_PATH_FORBIDDEN = "mcp-path-forbidden";
export const REASON_ARGS_INVALID = "mcp-args-invalid";

/**
 * Which tool table a server uses. Legacy rows (no preset) and the
 * filesystem preset use TOOL_ACTIONS plus path validation; the other
 * presets use their own table from lib/mcpPresets (fail closed: a tool the
 * table does not know is "unknown" and denied). `toolAllowlist` adds
 * read-level tool names for non-filesystem presets only.
 */
export interface ServerToolPolicy {
  preset?: string;
  toolAllowlist?: string[];
}

export function actionForTool(name: string, policy?: ServerToolPolicy): McpToolAction {
  if (policy && !presetChecksPaths(policy.preset)) {
    return presetToolAction(policy.preset, name, policy.toolAllowlist) ?? "unknown";
  }
  return TOOL_ACTIONS[name] ?? "unknown";
}

export type McpRoleKey = "developer" | "qa" | "researcher" | "orchestrator";

interface Permission {
  read: boolean;
  list: boolean;
  write: boolean;
  move: boolean;
  delete: boolean;
}

const ROLE_PERMISSIONS: Record<McpRoleKey, Permission> = {
  developer: { read: true, list: true, write: true, move: true, delete: false },
  qa: { read: true, list: true, write: false, move: false, delete: false },
  researcher: { read: true, list: true, write: false, move: false, delete: false },
  orchestrator: { read: true, list: true, write: false, move: false, delete: false },
};

const DEFAULT_PERMISSION: Permission = {
  read: true,
  list: true,
  write: false,
  move: false,
  delete: false,
};

/**
 * Map a free-form agent role to the matrix row. Recognised roles:
 * `developer` (write/edit/mkdir/move, never delete), `qa` (read/search,
 * no source edits), `researcher` (read/search only), `orchestrator`
 * (read as needed). Anything else — including a missing role — gets the
 * read-only default: unknown callers are not granted writes.
 */
export function permissionsForRole(role: string | undefined): Permission {
  if (!role) return DEFAULT_PERMISSION;
  const normalized = role.toLowerCase();
  // Concrete roles first: "QA Engineer" is QA, not a generic engineer.
  if (normalized.includes("qa") || normalized.includes("quality")) return ROLE_PERMISSIONS.qa;
  if (normalized.includes("research") || normalized.includes("audit")) return ROLE_PERMISSIONS.researcher;
  if (
    normalized.includes("orchestr") ||
    normalized === "cto" ||
    normalized.includes("architect")
  ) {
    return ROLE_PERMISSIONS.orchestrator;
  }
  // Fixed-team implementers are seeded as frontend/backend/devops (core M15):
  // they are developers for MCP write permission.
  if (
    normalized.includes("develop") ||
    normalized.includes("engineer") ||
    /^(frontend|backend|devops|dev ops|fullstack|full-stack)\b/.test(normalized)
  ) {
    return ROLE_PERMISSIONS.developer;
  }
  return DEFAULT_PERMISSION;
}

export interface AgentScope {
  role?: string;
  /** The agent's declared `supportedTools` scope (same semantics as the tool registry). */
  supportedTools?: string[];
  /** `mcpWriteTools` policy knob: write/move/delete are denied by default. */
  allowWrite?: boolean;
}

export function filterToolsForAgent(
  tools: McpToolDefinition[],
  scope: AgentScope,
  policy?: ServerToolPolicy
): McpToolDefinition[] {
  const permission = permissionsForRole(scope.role);
  const writeAllowed = scope.allowWrite === true;
  const supported = scope.supportedTools;
  return tools.filter((tool) => {
    const action = actionForTool(tool.name, policy);
    if (action === "unknown") return false;
    if (supported && supported.length > 0 && !supported.includes(tool.name)) return false;
    if (action === "read" || action === "list") return permission.read || permission.list;
    if (!writeAllowed) return false;
    if (action === "write") return permission.write;
    if (action === "move") return permission.move;
    if (action === "delete") return permission.delete;
    return false;
  });
}

export interface AuthorizeInput {
  tool: string;
  args: Record<string, unknown>;
  scope: AgentScope;
  /** Allowed roots: workspace + configured allowedDirectories. */
  allowedRoots: string[];
  /** The server's tool table (see ServerToolPolicy). Absent = filesystem. */
  policy?: ServerToolPolicy;
}

export type AuthorizeResult =
  | { ok: true; action: McpToolAction }
  | { ok: false; reason: string };

function actionAllowed(action: McpToolAction, scope: AgentScope): boolean {
  const permission = permissionsForRole(scope.role);
  const writeAllowed = scope.allowWrite === true;
  if (action === "read") return permission.read;
  if (action === "list") return permission.list;
  if (!writeAllowed) return false;
  if (action === "write") return permission.write;
  if (action === "move") return permission.move;
  if (action === "delete") return permission.delete;
  return false;
}

/**
 * Call-time authorization. Path arguments are validated against the
 * allowed root set (absolute-only, symlink-aware, protected basenames),
 * so a tool the model saw in the list can still be refused.
 */
export async function authorizeToolCall(input: AuthorizeInput): Promise<AuthorizeResult> {
  const action = actionForTool(input.tool, input.policy);
  if (action === "unknown") return { ok: false, reason: REASON_TOOL_UNKNOWN };
  if (!actionAllowed(action, input.scope)) return { ok: false, reason: REASON_TOOL_DENIED };
  // Path arguments of non-filesystem servers are not local paths (a repo
  // path for GitHub, a URL for fetch): root validation is filesystem-only.
  if (!presetChecksPaths(input.policy?.preset)) return { ok: true, action };

  for (const [, value] of collectPathArgs(input.args)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, reason: REASON_ARGS_INVALID };
    }
    if (!path.isAbsolute(value)) return { ok: false, reason: REASON_PATH_INVALID };
    if (value.length > 4_096) return { ok: false, reason: REASON_ARGS_INVALID };
    const resolved = await resolveWithinRootsAsync(input.allowedRoots, value);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason === "not-absolute" ? REASON_PATH_INVALID : REASON_PATH_OUTSIDE,
      };
    }
    const validation = validateFilePath(resolved.path);
    if (!validation.ok) return { ok: false, reason: REASON_PATH_FORBIDDEN };
  }
  return { ok: true, action };
}

/** Extract path-shaped arguments the reference server uses. */
function collectPathArgs(args: Record<string, unknown>): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const key of [
    "path",
    "srcPath",
    "destPath",
    "oldPath",
    "newPath",
    "source",
    "destination",
    "from",
    "to",
  ]) {
    const value = args[key];
    if (typeof value === "string") found.push([key, value]);
  }
  const paths = args.paths;
  if (Array.isArray(paths)) {
    for (const entry of paths) {
      if (typeof entry === "string") found.push(["paths", entry]);
    }
  }
  return found;
}

/**
 * Refuse paths that can never be safe to hand to a filesystem server:
 * the filesystem root and the system directories. Backend check, not
 * prompt text.
 */
export function isForbiddenRoot(root: string): boolean {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return (
    normalized === "/" ||
    /^\/(?:etc|proc|sys|dev|root|var\/run|boot|windows|program\ files(?: \(x86\))?|systemvolumeinformation)$/i.test(
      normalized
    ) ||
    /^[a-zA-Z]:[\\/]$/.test(root)
  );
}
