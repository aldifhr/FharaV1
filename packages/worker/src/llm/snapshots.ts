/**
 * Context Snapshot capture for worker LLM calls.
 *
 * The runner sets a scope (task, subtask, execution, agent, call role) with
 * withSnapshotScope; every call through runLlmCallWithFallback (and the
 * read-only streaming path) then records one snapshot through the sink the
 * worker entrypoint installs (WorkerApi.recordContextSnapshot).
 *
 * Recording is best effort and fire-and-forget: it never delays or fails
 * the call. Redaction runs twice — the worker's whole-value
 * maskStringSecrets, then the shared unanchored redactSecrets — before
 * anything leaves the process. CONTEXT_SNAPSHOTS=0 turns it off.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  buildContextSnapshot,
  contextSnapshotsEnabled,
  type CallRole,
  type SnapshotBody,
  type SnapshotMeta,
} from "@/api/convex/lib/contextSnapshot";
import { maskStringSecrets } from "@/governance/tools";
import type { LLMMessage, LLMResult } from "@/types/llm";

export interface SnapshotScope {
  projectId?: string;
  taskId?: string;
  subtaskKey?: string;
  executionId?: string;
  agentId?: string;
  agentRole?: string;
  callRole?: CallRole;
}

export interface SnapshotRecord {
  projectId?: string;
  taskId?: string;
  subtaskKey?: string;
  executionId?: string;
  agentId?: string;
  agentRole?: string;
  source: "worker";
  meta: SnapshotMeta;
  body: SnapshotBody;
}

export type SnapshotSink = (record: SnapshotRecord) => Promise<unknown>;

const storage = new AsyncLocalStorage<SnapshotScope>();
let sink: SnapshotSink | null = null;
const pending = new Set<Promise<unknown>>();

/** Installed once by the worker entrypoint; tests install their own. */
export function setSnapshotSink(next: SnapshotSink | null): void {
  sink = next;
}

export function currentSnapshotScope(): SnapshotScope {
  return storage.getStore() ?? {};
}

/** Run `fn` with `patch` merged over the current scope. */
export function withSnapshotScope<T>(patch: SnapshotScope, fn: () => T): T {
  const merged: SnapshotScope = { ...currentSnapshotScope() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return storage.run(merged, fn);
}

/** Await in-flight snapshot writes (tests, graceful shutdown). */
export async function flushSnapshots(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

export function recordLlmSnapshot(call: {
  messages: LLMMessage[];
  result?: LLMResult;
  error?: unknown;
  model?: string;
  provider?: string;
  durationMs: number;
}): void {
  if (!sink || !contextSnapshotsEnabled()) return;
  const scope = currentSnapshotScope();
  // Only task-scoped calls are recorded (a stray call has nowhere to live).
  if (!scope.taskId && !scope.projectId) return;
  let record: SnapshotRecord;
  try {
    const { meta, body } = buildContextSnapshot({
      callRole: scope.callRole ?? "executor",
      messages: call.messages,
      response: call.result?.content,
      error:
        call.error === undefined ? undefined : call.error instanceof Error ? call.error.message : String(call.error),
      model: call.model,
      provider: call.provider,
      inputTokens: call.result?.inputTokens,
      outputTokens: call.result?.outputTokens,
      usageEstimated: call.result?.usageEstimated,
      durationMs: call.durationMs,
      extraRedact: maskStringSecrets,
    });
    record = {
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.taskId ? { taskId: scope.taskId } : {}),
      ...(scope.subtaskKey ? { subtaskKey: scope.subtaskKey } : {}),
      ...(scope.executionId ? { executionId: scope.executionId } : {}),
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.agentRole ? { agentRole: scope.agentRole } : {}),
      source: "worker",
      meta,
      body,
    };
  } catch {
    return;
  }
  const write = sink(record)
    .catch(() => undefined)
    .finally(() => pending.delete(write));
  pending.add(write);
}
