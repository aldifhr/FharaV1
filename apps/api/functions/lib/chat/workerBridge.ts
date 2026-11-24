/**
 * Worker-queue bridge for chat replies. Every path here talks to the
 * `internal.repoTools` queue: enqueue a read-only repo tool or a local
 * OpenCode LLM completion, poll for the worker's answer, and always remove
 * the queue row. The helpers never throw — a timeout/failure comes back as
 * `ok:false`, so a chat turn degrades to "not checked" instead of dying.
 */

import { internal } from "@fhara/runtime/api";
import type { ActionCtx } from "@fhara/runtime/functions";
import type { Id } from "@fhara/runtime/data";
import { completeWithAgent, type ChatLlmConfig } from "./llm";
import type { RepoToolCall, RepoToolResult } from "./repoTools";
import type { RepoToolsOffReason } from "../../repoTools";

/** How long one repo tool call may wait for a worker before it counts as not checked. */
const REPO_TOOL_WAIT_MS = 20_000;
/** A call no worker has claimed by then fails fast: no live worker serves the queue. */
const REPO_TOOL_CLAIM_WAIT_MS = 3_000;
const REPO_TOOL_POLL_MS = 250;
/** Plan 060: a chat completion on the worker's CLI may be slower than a file read. */
const CHAT_LLM_WAIT_MS = 180_000;
const CHAT_LLM_CLAIM_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Quiet Thinking-trace line for a CTO reply that runs without repo tools. */
export function repoToolsOffNote(reason: RepoToolsOffReason | "unclaimed" | "budget" | "error" | undefined): string {
  switch (reason) {
    case "no_workspace":
      return "Repo tools off: project folder not set";
    case "no_worker":
      return "Repo tools off: no online worker";
    case "worker_outdated":
      return "Repo tools off: online worker is outdated (restart it to serve repo tools)";
    case "unclaimed":
      return "Repo tools off: worker tidak merespons";
    case "budget":
      return "Repo tools off: this turn's shared repo tool budget is used up";
    default:
      return "Repo tools off: availability check failed";
  }
}

export const WORKER_UNRESPONSIVE =
  "worker tidak merespons: no worker picked up this tool call within 3s, so repo tools are off for the rest of this reply. Treat it as not checked.";

/**
 * Run one read-only repo tool through the worker queue (repoTools.ts):
 * enqueue, poll for the worker's answer, always delete the row. Never
 * throws; a timeout or failure comes back as ok:false. A call that no worker
 * claims within REPO_TOOL_CLAIM_WAIT_MS fails fast with `unclaimed`.
 */
export async function callRepoToolViaWorker(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  call: RepoToolCall
): Promise<RepoToolResult & { unclaimed?: boolean }> {
  let callId: Id<"repoToolCalls">;
  try {
    callId = await ctx.runMutation(internal.repoTools.enqueue, {
      projectId,
      tool: call.tool,
      args: JSON.stringify(call.args ?? {}),
    });
  } catch (error: any) {
    return { ok: false, text: `Tool unavailable (${error?.message ?? "enqueue failed"}); treat as not checked.` };
  }
  try {
    const startedAt = Date.now();
    const deadline = startedAt + REPO_TOOL_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(REPO_TOOL_POLL_MS);
      const row = await ctx.runQuery(internal.repoTools.get, { callId });
      if (!row) break;
      if (row.status === "done") return { ok: true, text: row.result ?? "", files: row.files ?? [] };
      if (row.status === "error") return { ok: false, text: row.error ?? "Tool failed." };
      if (row.status === "pending" && Date.now() - startedAt >= REPO_TOOL_CLAIM_WAIT_MS) {
        return { ok: false, text: WORKER_UNRESPONSIVE, unclaimed: true };
      }
    }
    return { ok: false, text: "No worker answered this tool call in time; treat it as not checked." };
  } finally {
    await ctx.runMutation(internal.repoTools.remove, { callId }).catch(() => undefined);
  }
}

/**
 * Plan 060: one LLM completion on the worker's local OpenCode CLI. Resolves
 * the model from the worker's FharaV2-style settings.json; the worker only
 * needs the project id to route the queue row, never a workspace path.
 */
export async function callChatLlmViaWorker(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  config: ChatLlmConfig,
  system: string,
  msgs: Array<{ role: string; content: string }>
): Promise<Awaited<ReturnType<typeof completeWithAgent>>> {
  const callId = await ctx.runMutation(internal.repoTools.enqueueChatLlm, {
    projectId,
    model: config.model,
    system,
    messages: JSON.stringify(msgs.slice(-12).map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 20_000) }))),
  });
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < CHAT_LLM_WAIT_MS) {
      await sleep(REPO_TOOL_POLL_MS);
      const row = await ctx.runQuery(internal.repoTools.get, { callId });
      if (!row) break;
      if (row.status === "done") {
        return { content: row.result ?? "", reasoning: "", reasoningDurationMs: Date.now() - startedAt };
      }
      if (row.status === "error") throw new Error(row.error || "OpenCode chat call failed.");
      if (row.status === "pending" && Date.now() - startedAt >= CHAT_LLM_CLAIM_WAIT_MS) {
        throw new Error("No worker claimed the OpenCode chat call. Start the worker and check its heartbeat.");
      }
    }
    throw new Error("The OpenCode chat call timed out.");
  } finally {
    await ctx.runMutation(internal.repoTools.remove, { callId }).catch(() => undefined);
  }
}

/** Repo tools are usable for this reply (workspace set + a repo-tool worker online). Never throws. */
export async function repoToolsAvailability(
  ctx: ActionCtx,
  projectId: Id<"projects">
): Promise<{ available: boolean; reason?: RepoToolsOffReason | "error" }> {
  try {
    return await ctx.runQuery(internal.repoTools.availability, { projectId });
  } catch {
    return { available: false, reason: "error" };
  }
}
