/**
 * Plan L5: post-task memory reconciliation → suggestions the user accepts.
 *
 * Skip rules, compact inputs, tags and the "best-effort, idempotent per
 * run" contract are adapted from agent-os
 * `backend/execution/memory_reconciliation.py` (`_is_read_only_run`,
 * `_is_failed_noisy_run`, `_parse_decision`, TAG_*;
 * https://github.com/earthwalker17/agent-os, commit 59833d3), Copyright
 * agent-os contributors, Apache License 2.0. Changes: ported to TypeScript;
 * the output is add/update/forget PROPOSALS stored in `memorySuggestions`
 * instead of markdown writes; the read-only rule is stricter (a finished
 * task that changed no file and hit no blocker is skipped whatever its
 * summary says); every input and output string is secret-masked; the one
 * LLM call sits behind the task's pre-call budget gate. See
 * THIRD_PARTY_NOTICES.md.
 *
 * Cadence (one review per finished task, a per-task marker so a review never
 * re-reads what it already reviewed) follows the idea of OpenBot's memory
 * review; no OpenBot code or text is used (PolyForm Noncommercial).
 *
 * Contract:
 *  - never throws and never changes the task's terminal status;
 *  - at most one LLM call per task, zero on skipped tasks;
 *  - idempotent per task (backend marker `memoryReconciliations`);
 *  - nothing reaches a prompt until the user accepts a suggestion.
 */
import { runLlmCallWithFallback, usageMetaFor, type FallbackHandle, type LlmConcurrencyGate } from "@/effects/llmCall";
import { providerHealth } from "@/llm/health";
import { withSnapshotScope } from "@/llm/snapshots";
import type { TaskLlmResolver } from "@/llm/resolver";
import {
  MEMORY_RECONCILE_MAX,
  MEMORY_RECONCILE_SYSTEM_PROMPT,
  buildMemoryReconcilePrompt,
  type ReconcileMemoryNote,
  type ReconcileTaskSummary,
} from "@/prompts/memoryReconcile";
import type { AgentDefinition } from "@/types";
import type { TokenUsageFn } from "@/types/llm";
import { redactText } from "@/utils/redact";
import type { RunnerDeps } from "./types";

export const TAG = {
  suggested: "suggested",
  alreadyReconciled: "skipped_already_reconciled",
  readOnly: "skipped_read_only",
  failedNoisy: "skipped_failed_noisy",
  disabled: "skipped_disabled",
  noChain: "skipped_no_llm",
  budget: "skipped_budget",
  judgeNoUpdate: "skipped_judge_no_update",
  noValid: "skipped_no_valid_suggestions",
  error: "error",
} as const;
export type ReconcileTag = (typeof TAG)[keyof typeof TAG];

export type MemorySuggestion = {
  op: "add" | "update" | "forget";
  memoryId?: string;
  scope: "shared" | "project";
  title: string;
  content: string;
  reason?: string;
};

export interface ReconcileInput {
  deps: RunnerDeps;
  taskId: string;
  projectId: string;
  task: ReconcileTaskSummary;
  /** The agent whose LLM chain pays for the call (the CTO when present). */
  agent: AgentDefinition | null;
  llmResolver?: TaskLlmResolver;
  assertBudgetForCall?: () => void;
  llmTaskGate?: LlmConcurrencyGate;
  onTokenUsage?: TokenUsageFn;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  /** Test seam: replaces the provider call. */
  ask?: (system: string, user: string) => Promise<string>;
}

export type ReconcileOutcome = { tag: ReconcileTag; reason: string; suggestions: number };

/** agent-os `_is_read_only_run`, stricter: done + no files + no blockers. */
export function isReadOnlyTask(task: ReconcileTaskSummary): boolean {
  return task.status === "done" && task.filesChanged.length === 0 && task.blockers.length === 0;
}

/** agent-os `_is_failed_noisy_run`: failed, nothing changed, nothing informative. */
export function isFailedNoisyTask(task: ReconcileTaskSummary): boolean {
  if (task.status !== "failed") return false;
  if (task.filesChanged.length > 0) return false;
  const longestBlocker = Math.max(0, ...task.blockers.map((b) => b.length));
  if (longestBlocker >= 60) return false;
  return task.summary.trim().length < 60;
}

function stripFence(text: string): string {
  const t = text.trim();
  const first = t.indexOf("```");
  const last = t.lastIndexOf("```");
  if (first === -1 || first === last) return t;
  const inner = t.slice(first, last);
  const nl = inner.indexOf("\n");
  return nl === -1 ? "" : inner.slice(nl + 1).trim();
}

/**
 * Parse the reviewer's JSON (agent-os `_parse_decision` shape). Unknown ops,
 * empty content, update/forget without a known memory id are dropped;
 * everything is secret-masked; at most MEMORY_RECONCILE_MAX survive. Null on
 * malformed JSON.
 */
export function parseSuggestions(
  raw: string,
  knownIds: ReadonlySet<string>
): { shouldUpdate: boolean; reason: string; suggestions: MemorySuggestion[] } | null {
  const text = stripFence(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const reason = typeof obj.reason === "string" ? redactText(obj.reason.trim()).slice(0, 300) : "";
  const list = Array.isArray(obj.suggestions) ? obj.suggestions : Array.isArray(obj.updates) ? obj.updates : [];
  const suggestions: MemorySuggestion[] = [];
  for (const entry of list) {
    if (suggestions.length >= MEMORY_RECONCILE_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const op = String(e.op ?? "add").trim().toLowerCase();
    if (op !== "add" && op !== "update" && op !== "forget") continue;
    const memoryId = String(e.memory_id ?? e.memoryId ?? "").trim();
    if (op !== "add" && !knownIds.has(memoryId)) continue;
    const scope = String(e.scope ?? "project").trim().toLowerCase() === "shared" ? "shared" : "project";
    const title = redactText(String(e.title ?? "").trim()).slice(0, 120);
    const content = redactText(String(e.content ?? "").trim()).slice(0, 4000);
    if (!title) continue;
    if (op !== "forget" && !content) continue;
    const why = typeof e.reason === "string" && e.reason.trim() ? redactText(e.reason.trim()).slice(0, 300) : undefined;
    suggestions.push({ op, ...(op !== "add" ? { memoryId } : {}), scope, title, content: content || title, ...(why ? { reason: why } : {}) });
  }
  const shouldUpdate = Boolean(obj.should_update ?? obj.shouldUpdate) && suggestions.length > 0;
  return { shouldUpdate, reason, suggestions: shouldUpdate ? suggestions : [] };
}

/** Mask every string of the task summary before it leaves the worker. */
export function maskTaskSummary(task: ReconcileTaskSummary): ReconcileTaskSummary {
  return {
    ...task,
    title: redactText(task.title),
    request: redactText(task.request),
    summary: redactText(task.summary),
    filesChanged: task.filesChanged.map((f) => redactText(f)),
    blockers: task.blockers.map((b) => redactText(b)),
  };
}

export async function reconcileTaskMemory(input: ReconcileInput): Promise<ReconcileOutcome> {
  const { deps } = input;
  const api = deps.api;
  const finish = async (tag: ReconcileTag, reason: string, suggestions: MemorySuggestion[] = [], mark = true) => {
    let inserted = 0;
    if (mark && typeof api.recordMemorySuggestions === "function") {
      const res = await api
        .recordMemorySuggestions({ taskId: input.taskId as never, tag, reason: reason.slice(0, 300), suggestions })
        .catch(() => null);
      inserted = res?.inserted ?? 0;
    }
    await api
      .logEvent?.({
        taskId: input.taskId as never,
        projectId: input.projectId as never,
        type: "memory.reconciled",
        payload: { tag, reason: reason.slice(0, 300), suggestions: inserted },
        level: tag === TAG.error ? "warn" : "info",
      })
      ?.catch(() => undefined);
    return { tag, reason, suggestions: inserted };
  };
  try {
    const env = input.env ?? process.env;
    if (typeof api.getMemoryReconcileContext !== "function" || typeof api.recordMemorySuggestions !== "function") {
      return { tag: TAG.disabled, reason: "backend has no memory suggestions", suggestions: 0 };
    }
    if (env.FHARA_MEMORY_SUGGESTIONS === "0") return { tag: TAG.disabled, reason: "disabled", suggestions: 0 };
    const context = await api.getMemoryReconcileContext({ taskId: input.taskId as never });
    if (!context) return { tag: TAG.error, reason: "task not found", suggestions: 0 };
    if (context.reconciled) return { tag: TAG.alreadyReconciled, reason: "already reconciled", suggestions: 0 };
    if (isReadOnlyTask(input.task)) return await finish(TAG.readOnly, "no files changed and no blockers");
    if (isFailedNoisyTask(input.task)) return await finish(TAG.failedNoisy, "failed with nothing actionable");
    if (input.signal?.aborted) return { tag: TAG.error, reason: "aborted", suggestions: 0 };

    let handles: FallbackHandle[] = [];
    if (!input.ask) {
      if (!input.agent || !input.llmResolver) return await finish(TAG.noChain, "no LLM chain");
      handles = input.llmResolver.handlesFor(input.agent, { callRole: "memory" });
      if (handles.length === 0) return await finish(TAG.noChain, "no LLM chain");
    }
    try {
      // Every LLM call behind the budget gate: before the request, never after.
      input.assertBudgetForCall?.();
    } catch (error) {
      return await finish(TAG.budget, `budget: ${error instanceof Error ? error.message : String(error)}`);
    }

    const notes: ReconcileMemoryNote[] = context.memories.map((m) => ({
      ...m,
      title: redactText(m.title),
      content: redactText(m.content),
    }));
    const user = buildMemoryReconcilePrompt(maskTaskSummary(input.task), notes);
    let reply: string;
    if (input.ask) {
      reply = await input.ask(MEMORY_RECONCILE_SYSTEM_PROMPT, user);
    } else {
      const agent = input.agent!;
      const { result, servedBy } = await withSnapshotScope(
        { callRole: "memory", agentId: agent._id, agentRole: agent.role, taskId: input.taskId, projectId: input.projectId },
        () =>
          runLlmCallWithFallback(
            handles,
            [
              { role: "system" as const, content: MEMORY_RECONCILE_SYSTEM_PROMPT },
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
    const decision = parseSuggestions(reply, new Set(notes.map((n) => n.id)));
    if (!decision) return await finish(TAG.error, "reply was not valid JSON");
    if (!decision.shouldUpdate) {
      return await finish(decision.suggestions.length === 0 && /"should_update"\s*:\s*true/i.test(reply) ? TAG.noValid : TAG.judgeNoUpdate, decision.reason || "no durable knowledge");
    }
    return await finish(TAG.suggested, decision.reason || "suggested", decision.suggestions);
  } catch (error) {
    // Best-effort: an LLM or backend failure never touches the task.
    return await finish(TAG.error, (error instanceof Error ? error.message : String(error)).slice(0, 300)).catch(() => ({
      tag: TAG.error,
      reason: "error",
      suggestions: 0,
    }));
  }
}

/** Compact outcome summary from the run state (no raw outputs, bounded). */
export function summarizeRun(state: {
  priorOutputs: Map<string, string>;
  deliveredOutputs?: Map<string, string>;
}): string {
  const source = state.deliveredOutputs && state.deliveredOutputs.size > 0 ? state.deliveredOutputs : state.priorOutputs;
  const lines: string[] = [];
  for (const [key, output] of source) {
    const first = (output ?? "").replace(/\r\n/g, "\n").split("\n").find((l) => l.trim())?.trim() ?? "";
    if (first) lines.push(`${key}: ${first.slice(0, 300)}`);
  }
  return lines.slice(-8).join("\n");
}
