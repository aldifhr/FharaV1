/**
 * The pool and routing hint a new task is stored with (tasks.createFromCommand).
 * Every creation path lands here, the web Create task button and "/task"
 * included, so an offer task can never run with a one-agent pool again
 * (P1a): the pool comes from lib/chat/taskAssignees.ts (CTO + owners +
 * Reviewer + QA, or no narrowing). Re-resolving a pool a chat path already
 * resolved gives the same pool.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { projectTeamIds } from "./projectTeam";
import { readRoutingHint, type RoutingHint } from "./routingHint";
import { hintForCommand, resolveTaskAssignees, routedOwners } from "./chat/taskAssignees";

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
  // A typed command (chat "/task", the web /task, the TaskBoard box) with nothing else to go on is routed like
  // chat routes it; "/research …" and other slash markers keep their own routing.
  const derive = !given && !input.offer && !input.requested?.length && !input.command.trim().startsWith("/");
  const routed = derive ? routedOwners(input.command, team) : undefined;
  const routingHint = given ?? (derive ? hintForCommand(input.command, team, { routed }) : undefined);
  const pool = resolveTaskAssignees({
    team,
    mentionedIds: (input.requested ?? []).map(String),
    offerAssigneeId: input.offer?.assigneeAgentId,
    hint: routingHint,
    routed: routed?.owners,
  });
  // Requested ids outside the enabled team were validated by the caller; keep them (a disabled assignee stays visible).
  const extra = (input.requested ?? []).filter((id) => !pool.some((a) => a._id === String(id)));
  const assignedAgentIds = pool.length ? [...pool.map((a) => a._id as Id<"agents">), ...extra] : input.requested;
  return { ...(assignedAgentIds?.length ? { assignedAgentIds } : {}), ...(routingHint ? { routingHint } : {}) };
}
