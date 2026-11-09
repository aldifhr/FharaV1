import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { getViewerId } from "./authz";

/**
 * Config audit trail. Every user-facing configuration write (agents,
 * projects, LLM providers/models, integrations, MCP servers, roles,
 * approvals) records one `audit` row through this helper so the Audit log
 * page can show who changed what and when.
 *
 * Details carry FIELD NAMES ONLY (`{ changed: ["name", "apiKey"] }`),
 * never values: prompts can be long and keys/tokens are secrets. Targets
 * are human labels (agent name, provider name, model id), never
 * credentials.
 */
export type AuditDecision = "allowed" | "denied" | "pending" | "recorded";

export async function recordAudit(
  ctx: MutationCtx,
  entry: {
    action: string;
    actor?: string;
    tool?: string;
    target?: string;
    details?: Record<string, unknown>;
    decision?: AuditDecision;
    projectId?: Id<"projects">;
    taskId?: Id<"tasks">;
  }
): Promise<void> {
  const actor = entry.actor ?? (await getViewerId(ctx)) ?? "user";
  await ctx.db.insert("audit", {
    actor,
    tool: entry.tool ?? "config",
    action: entry.action,
    decision: entry.decision ?? "recorded",
    ...(entry.target ? { target: entry.target.slice(0, 200) } : {}),
    ...(entry.details ? { details: entry.details } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    createdAt: Date.now(),
  });
}

const IGNORED_FIELDS = new Set(["updatedAt", "createdAt", "token"]);

/**
 * Names of the fields a patch actually changes on `before`. Undefined
 * patch entries count only when they clear an existing value. Values are
 * compared but never returned.
 */
export function changedFields(
  before: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>
): string[] {
  const out: string[] = [];
  for (const [key, next] of Object.entries(patch)) {
    if (IGNORED_FIELDS.has(key)) continue;
    const prev = before ? before[key] : undefined;
    if (next === undefined && prev === undefined) continue;
    if (JSON.stringify(prev) !== JSON.stringify(next)) out.push(key);
  }
  return out.sort();
}

/** Names of the fields a create call set (values never recorded). */
export function setFields(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .filter(([key, value]) => value !== undefined && !IGNORED_FIELDS.has(key))
    .map(([key]) => key)
    .sort();
}
