/**
 * The pool and routing hint a new task is stored with (tasks.createFromCommand).
 * Every creation path lands here, the web Create task button and "/task"
 * included, so an offer task can never run with a one-agent pool again
 * (P1a): the pool comes from lib/chat/taskAssignees.ts (CTO + owners +
 * Reviewer + QA, or no narrowing). Re-resolving a pool a chat path already
 * resolved gives the same pool.
 */
import type { Doc, Id } from "@fhara/runtime/data";
import type { QueryCtx } from "@fhara/runtime/functions";
import { projectTeamIds } from "./projectTeam";
import { readRoutingHint, type RoutingHint } from "./routingHint";
import { resolveTaskAssignees } from "./chat/taskAssignees";

export async function resolveNewTaskRouting(
  ctx: Pick<QueryCtx, "db">,
  project: Doc<"projects">,
  input: {
    command: string;
    requested?: Id<"agents">[];
    hint?: RoutingHint;
    offer?: { assigneeAgentId?: string; hint?: unknown } | null;
  }
): Promise<{ assignedAgentIds?: Id<"agents">[]; routingHint?: RoutingHint }> {
  const ids = await projectTeamIds(ctx, project);
  const team = (await Promise.all(ids.map((id) => ctx.db.get(id))))
    .filter((a): a is Doc<"agents"> => Boolean(a) && a!.isEnabled !== false)
    .map((a) => ({ _id: String(a._id), name: a.name, role: a.role }));
  const given = input.hint ?? readRoutingHint(input.offer?.hint) ?? undefined;
  // No word-based inference here: a task without a chat classification keeps
  // the whole team as its pool and carries no guessed role/domain hint.
  const routingHint = given ?? undefined;
  const pool = resolveTaskAssignees({
    team,
    mentionedIds: (input.requested ?? []).map(String),
    offerAssigneeId: input.offer?.assigneeAgentId,
    hint: routingHint,
  });
  // Requested ids outside the enabled team were validated by the caller; keep them (a disabled assignee stays visible).
  const extra = (input.requested ?? []).filter((id) => !pool.some((a) => a._id === String(id)));
  const assignedAgentIds = pool.length ? [...pool.map((a) => a._id as Id<"agents">), ...extra] : input.requested;
  return { ...(assignedAgentIds?.length ? { assignedAgentIds } : {}), ...(routingHint ? { routingHint } : {}) };
}
