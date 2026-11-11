/**
 * O2: the orchestrator's System status lines in the task thread. Neutral
 * copy only: what happened, never an opinion, never an @name. The backend
 * dedupes identical lines per task (apps/api/convex/systemLines.ts).
 */
import type { AgentDefinition, ExecutionPlan } from "@/types";
import { roleLabel } from "@/api/convex/lib/roles";
import { ARCH_DECISION_KEY } from "@/api/convex/lib/architectureFlag";
import { resolveRoleKey } from "@/utils/rolePolicy";
import { GATES_SKIPPED_NOTE } from "@/orchestrator/responseOwner";
import type { RunnerDeps } from "./types";

/** Best effort: a System line never fails or blocks the run. */
export async function postSystemLine(
  deps: Pick<RunnerDeps, "api">,
  input: { taskId: string; projectId: string; content: string }
): Promise<void> {
  const api = deps.api as { appendSystemLine?: (args: { taskId: string; projectId: string; content: string }) => Promise<unknown> };
  if (typeof api.appendSystemLine !== "function") return;
  await api.appendSystemLine({ taskId: input.taskId, projectId: input.projectId, content: input.content }).catch(() => undefined);
}

/** "Frontend" for a fixed role (key, title or alias), else the role as written. */
export function agentRoleLabel(agent: Pick<AgentDefinition, "role" | "name"> | null | undefined): string {
  if (!agent) return "the team";
  const key = resolveRoleKey(agent.role ?? "");
  return key ? roleLabel(key) : (agent.role?.trim() || agent.name);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Planned 4 subtasks · architecture decision needed · QA and review skipped: no code changes". */
export function planSystemLine(plan: Pick<ExecutionPlan, "subtasks" | "gatesSkipped">, version: number): string {
  const parts = [`${version > 1 ? "Replanned" : "Planned"} ${plural(plan.subtasks.length, "subtask")}`];
  if (plan.subtasks.some((subtask) => subtask.key === ARCH_DECISION_KEY)) parts.push("architecture decision needed");
  if (plan.gatesSkipped) parts.push(GATES_SKIPPED_NOTE);
  return parts.join(" · ");
}

/** "Sent to Frontend: Build profile page". */
export function dispatchSystemLine(agent: Pick<AgentDefinition, "role" | "name"> | null | undefined, title: string): string {
  return `Sent to ${agentRoleLabel(agent)}: ${title}`;
}

/** "CTO decided: go" / "CTO decided: stop · waiting for you to resume or cancel". */
export function archVerdictSystemLine(verdict: "go" | "revise" | "stop", held: boolean): string {
  if (verdict === "stop") return held ? "CTO decided: stop · waiting for you to resume or cancel" : "CTO decided: stop";
  if (verdict === "revise") return "CTO decided: revise · replanning";
  return "CTO decided: go";
}
