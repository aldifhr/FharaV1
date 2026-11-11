/**
 * Goal mode for direct threads (DeepSeek Harness D8): the user's side.
 * `directThreads.setGoal / pauseGoal / clearGoal` and `/goal` sent in the
 * thread (directThreads.send) all land here. The worker runs the rounds
 * (packages/worker/src/direct/goal.ts) and reports through its lease-fenced
 * state patch (lib/directPatch.ts).
 *
 * A set or resumed goal wakes a thread that waits for the user (status
 * `queued`), unless automation is held (GOAT G3): goal rounds are Fhara
 * acting on its own, so they wait for the hold to lift and the next message.
 */
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { assertProjectAccess } from "./authz";
import { isAutomationHeld } from "./automationHold";
import { appendTaskEvent } from "./taskEvents";
import { patchTask } from "./threadIndex";
import { parseSlash } from "./slashCommands";
import {
  GOAL_DEFAULT_ROUNDS,
  GOAL_MAX_ROUNDS,
  GOAL_OBJECTIVE_MAX,
  goalWantsWorker,
  parseGoalArgs,
  type DirectGoal,
  type GoalCommand,
} from "./directGoalSchema";

const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);

export const GOAL_USAGE = "Usage: /goal <objective> [rounds] | pause | resume | clear";

export const setGoalArgs = { taskId: v.id("tasks"), objective: v.optional(v.string()), maxRounds: v.optional(v.number()) };
export const goalTaskArgs = { taskId: v.id("tasks") };

type DirectTask = Doc<"tasks"> & { direct: NonNullable<Doc<"tasks">["direct"]> };

async function loadGoalThread(ctx: MutationCtx, taskId: Id<"tasks">): Promise<DirectTask> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error("Task not found");
  if (task.mode !== "direct" || !task.direct) throw new Error("Not a direct thread");
  await assertProjectAccess(ctx, task.projectId);
  if (TERMINAL.has(task.status)) throw new Error(`This thread is ${task.status}`);
  return task as DirectTask;
}

export function clampRounds(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return GOAL_DEFAULT_ROUNDS;
  return Math.max(1, Math.min(GOAL_MAX_ROUNDS, Math.floor(n)));
}

/** The goal after one user command (pure; throws on a command that does not apply). */
export function nextUserGoal(cur: DirectGoal | undefined, cmd: GoalCommand, now: number): DirectGoal | undefined {
  if (cmd.action === "set") {
    const objective = cmd.objective.trim().slice(0, GOAL_OBJECTIVE_MAX);
    if (!objective) throw new Error("A goal needs an objective");
    return { id: `goal-${now.toString(36)}`, objective, maxRounds: clampRounds(cmd.maxRounds), round: 0, phase: "active", rev: 1, setAt: now, updatedAt: now };
  }
  if (!cur) throw new Error("This thread has no goal");
  if (cmd.action === "clear") return undefined;
  const from = cmd.action === "pause" ? "active" : "paused";
  if (cur.phase !== from) throw new Error(`The goal is ${cur.phase}; only ${from === "active" ? "an active" : "a paused"} goal can be ${cmd.action}d`);
  return { ...cur, phase: cmd.action === "pause" ? "paused" : "active", rev: cur.rev + 1, updatedAt: now };
}

/** Apply one goal command; returns the goal.updated event it wrote. */
export async function applyGoalCommand(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  cmd: GoalCommand,
  clientId?: string
): Promise<{ eventId: Id<"taskEvents">; goal: DirectGoal | null; deduped?: boolean }> {
  const task = await loadGoalThread(ctx, taskId);
  // `/goal` sent twice with the same clientId applies once.
  const eventKey = clientId ? `goal.command:${clientId.slice(0, 100)}` : undefined;
  if (eventKey) {
    const dup = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_event_key", (q) => q.eq("taskId", task._id).eq("eventKey", eventKey))
      .first();
    if (dup) return { eventId: dup._id, goal: task.direct.goal ?? null, deduped: true };
  }
  const now = Date.now();
  const cur = task.direct.goal;
  const goal = nextUserGoal(cur, cmd, now);
  const held = await isAutomationHeld(ctx);
  const wake = goalWantsWorker(goal, held) && (task.status === "waiting_input" || task.status === "paused");
  await patchTask(ctx, task._id, { direct: { ...task.direct, goal }, updatedAt: now, ...(wake ? { status: "queued" as const } : {}) });
  const eventId = await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "goal.updated",
    ...(eventKey ? { eventKey } : {}),
    payload: {
      action: cmd.action,
      by: "user",
      ...(goal ? { goalId: goal.id, phase: goal.phase, round: goal.round, maxRounds: goal.maxRounds } : { goalId: cur?.id }),
      ...(cmd.action === "set" && goal ? { objective: goal.objective } : {}),
      ...(held && goal?.phase === "active" ? { held: true } : {}),
    },
    level: "info",
  });
  return { eventId, goal: goal ?? null };
}

/** `/goal …` typed in a direct thread: the command, "invalid" for a bare `/goal`, or null when the text is not one. */
export function goalCommandOf(text: string): GoalCommand | "invalid" | null {
  const parsed = parseSlash(text);
  if (!parsed || parsed.name !== "goal") return null;
  return parseGoalArgs(parsed.args) ?? "invalid";
}

export const setGoalHandler = (ctx: MutationCtx, args: { taskId: Id<"tasks">; objective?: string; maxRounds?: number }) =>
  applyGoalCommand(
    ctx,
    args.taskId,
    args.objective?.trim() ? { action: "set", objective: args.objective, maxRounds: clampRounds(args.maxRounds) } : { action: "resume" }
  );
export const pauseGoalHandler = (ctx: MutationCtx, args: { taskId: Id<"tasks"> }) => applyGoalCommand(ctx, args.taskId, { action: "pause" });
export const clearGoalHandler = (ctx: MutationCtx, args: { taskId: Id<"tasks"> }) => applyGoalCommand(ctx, args.taskId, { action: "clear" });
