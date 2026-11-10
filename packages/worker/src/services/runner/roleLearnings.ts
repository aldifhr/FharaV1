/**
 * Role memory: after a task, each role that finished work in it writes its
 * own notes for the project by itself (no approval).
 *
 * Cost: at most ONE small LLM call per role per task (not per subtask): the
 * role's completed subtasks of the task are batched into one bounded prompt
 * (≤ ~3.8k chars in, a short JSON array out), on the role's own LLM chain,
 * behind the task's pre-call budget gate. Roles with no completed output,
 * projects with "Role memory" off and FHARA_ROLE_MEMORY=0 cost nothing.
 *
 * Contract:
 *  - never throws and never changes the task's status;
 *  - every input string is secret-masked before the call and every learning
 *    again in the worker (redactText) and the backend (redactSecrets);
 *  - written UNPINNED as scope "agent" + projectId + agentId, source
 *    "agent"; the backend dedupes and caps per role per project.
 */
import { wenv } from "@fhara/config/worker";
import { runLlmCallWithFallback, usageMetaFor, type LlmConcurrencyGate } from "@/effects/llmCall";
import { providerHealth } from "@/llm/health";
import { withSnapshotScope } from "@/llm/snapshots";
import type { TaskLlmResolver } from "@/llm/resolver";
import { looksLikeRawDiff, parseLearnings, type RoleLearning } from "@/api/convex/lib/roleMemory";
import { buildRoleLearningsPrompt, roleLearningsSystemPrompt, type RoleWorkItem } from "@/prompts/roleLearnings";
import type { AgentDefinition } from "@/types";
import type { TokenUsageFn } from "@/types/llm";
import { redactText } from "@/utils/redact";
import type { RunnerDeps } from "./types";

export type RoleSubtask = {
  key: string;
  title: string;
  status: string;
  assignedAgentId?: string;
  output?: string;
};

export interface RoleLearningsInput {
  deps: RunnerDeps;
  taskId: string;
  projectId: string;
  /** The project row; `roleMemoryDisabled: true` turns writing off. */
  project: { roleMemoryDisabled?: boolean };
  task: { title: string; request: string; status: "done" | "failed" };
  agents: AgentDefinition[];
  subtasks: RoleSubtask[];
  /** Fallback outputs by subtask key when the row has none (run state). */
  outputs?: Map<string, string>;
  llmResolver?: TaskLlmResolver;
  assertBudgetForCall?: () => void;
  llmTaskGate?: LlmConcurrencyGate;
  onTokenUsage?: TokenUsageFn;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  /** Test seam: replaces the provider call. */
  ask?: (agent: AgentDefinition, system: string, user: string) => Promise<string>;
}

export type RoleLearningsOutcome = {
  skipped?: "disabled" | "no_backend" | "aborted";
  roles: Array<{ agentId: string; role: string; tag: string; learnings: number; inserted: number; updated: number }>;
};

/** Short or empty outputs teach nothing worth a call. */
const MIN_OUTPUT_CHARS = 80;

/** A subtask output as prompt input: masked, diffs replaced by a marker. */
export function maskWorkOutput(output: string): string {
  const masked = redactText(output ?? "");
  return looksLikeRawDiff(masked) ? "(diff omitted)" : masked;
}

/** Completed subtask work per assigned agent, in subtask order. */
export function groupWorkByAgent(subtasks: RoleSubtask[], outputs?: Map<string, string>): Map<string, RoleWorkItem[]> {
  const byAgent = new Map<string, RoleWorkItem[]>();
  for (const subtask of subtasks) {
    if (subtask.status !== "completed" || !subtask.assignedAgentId) continue;
    const output = (subtask.output ?? outputs?.get(subtask.key) ?? "").trim();
    if (output.length < MIN_OUTPUT_CHARS) continue;
    const list = byAgent.get(subtask.assignedAgentId) ?? [];
    list.push({ title: redactText(subtask.title), output: maskWorkOutput(output) });
    byAgent.set(subtask.assignedAgentId, list);
  }
  return byAgent;
}

export async function collectRoleLearnings(input: RoleLearningsInput): Promise<RoleLearningsOutcome> {
  const { deps } = input;
  const api = deps.api;
  const outcome: RoleLearningsOutcome = { roles: [] };
  try {
    const env = input.env;
    if (input.project.roleMemoryDisabled || !wenv("FHARA_ROLE_MEMORY", env)) return { ...outcome, skipped: "disabled" };
    if (typeof api.recordRoleLearnings !== "function") return { ...outcome, skipped: "no_backend" };
    const work = groupWorkByAgent(input.subtasks, input.outputs);
    for (const [agentId, items] of work) {
      if (input.signal?.aborted) return { ...outcome, skipped: "aborted" };
      const agent = input.agents.find((candidate) => candidate._id === agentId);
      if (!agent) continue;
      const entry = { agentId, role: agent.role, tag: "", learnings: 0, inserted: 0, updated: 0 };
      outcome.roles.push(entry);
      try {
        let handles: ReturnType<TaskLlmResolver["handlesFor"]> = [];
        if (!input.ask) {
          handles = input.llmResolver?.handlesFor(agent, { callRole: "memory" }) ?? [];
          if (handles.length === 0) {
            entry.tag = "skipped_no_llm";
            continue;
          }
        }
        try {
          // Budget gate BEFORE the request, never after.
          input.assertBudgetForCall?.();
        } catch {
          entry.tag = "skipped_budget";
          break;
        }
        const system = roleLearningsSystemPrompt(agent.role);
        const user = buildRoleLearningsPrompt({
          taskTitle: redactText(input.task.title),
          request: redactText(input.task.request),
          status: input.task.status,
          work: items,
        });
        let reply: string;
        if (input.ask) {
          reply = await input.ask(agent, system, user);
        } else {
          const { result, servedBy } = await withSnapshotScope(
            { callRole: "memory", agentId: agent._id, agentRole: agent.role, taskId: input.taskId, projectId: input.projectId },
            () =>
              runLlmCallWithFallback(
                handles,
                [
                  { role: "system" as const, content: system },
                  { role: "user" as const, content: user },
                ],
                { health: providerHealth, signal: input.signal, taskGate: input.llmTaskGate }
              )
          );
          if (input.onTokenUsage) {
            await input.onTokenUsage(
              result.inputTokens ?? 0,
              result.outputTokens ?? 0,
              servedBy.config.model,
              agent.name,
              agent._id,
              usageMetaFor(servedBy, result, "memory")
            );
          }
          reply = result.content;
        }
        const learnings: RoleLearning[] | null = parseLearnings(reply);
        if (!learnings) {
          entry.tag = "error_invalid_json";
          continue;
        }
        const clean = learnings
          .map((l) => ({ title: redactText(l.title), content: redactText(l.content), kind: l.kind }))
          .filter((l) => l.title && l.content);
        entry.learnings = clean.length;
        if (!clean.length) {
          entry.tag = "nothing_learned";
          continue;
        }
        const res = await api.recordRoleLearnings({
          projectId: input.projectId as never,
          agentId: agentId as never,
          taskId: input.taskId as never,
          learnings: clean,
        });
        entry.inserted = res?.inserted ?? 0;
        entry.updated = res?.updated ?? 0;
        entry.tag = res?.applied ? "written" : `skipped_${res?.reason ?? "backend"}`;
        if (res && !res.applied && res.reason === "disabled") break;
      } catch (error) {
        entry.tag = `error: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
      }
    }
    if (outcome.roles.length) {
      await api
        .logEvent?.({
          taskId: input.taskId as never,
          projectId: input.projectId as never,
          type: "memory.role_learnings",
          payload: { roles: outcome.roles.map(({ role, tag, inserted, updated }) => ({ role, tag, inserted, updated })) },
          level: "info",
        })
        ?.catch(() => undefined);
    }
    return outcome;
  } catch {
    return outcome;
  }
}
