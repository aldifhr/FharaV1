import path from "node:path";
import type { WorkerApi } from "@/workerApi";
import { runRepoReadTool } from "@/tools/repoRead";
import { capToolOutput, type RepoToolResult } from "@/api/convex/lib/chat/repoTools";

/**
 * Grounded chat, worker side: claim one read-only repo tool call queued by
 * the chat action (apps/api/convex/repoTools.ts), run it inside that
 * project's workspace and write the capped result back. A project without
 * a workspace gets an error result, never the worker's own root.
 */
export interface RepoToolDeps {
  api: Pick<WorkerApi, "claimRepoToolCall" | "completeRepoToolCall">;
  workerId: string;
  workspaceRoot: string;
  log: (...args: unknown[]) => void;
  run?: (workspace: string, tool: string, args: Record<string, unknown>) => Promise<RepoToolResult>;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Claim and run at most one repo tool call. Returns whether one ran. */
export async function processNextRepoToolCall(deps: RepoToolDeps): Promise<boolean> {
  const claim = await deps.api.claimRepoToolCall({ workerId: deps.workerId });
  if (!claim) return false;
  let result: RepoToolResult;
  const args = parseArgs(claim.args);
  if (!claim.workspacePath) {
    result = { ok: false, text: "This project has no repository folder configured." };
  } else if (!args) {
    result = { ok: false, text: "Tool arguments must be a JSON object." };
  } else {
    const workspace = path.isAbsolute(claim.workspacePath)
      ? claim.workspacePath
      : path.resolve(deps.workspaceRoot, claim.workspacePath);
    result = await (deps.run ?? runRepoReadTool)(workspace, claim.tool, args);
  }
  deps.log(`repo tool ${claim.tool}: ${result.ok ? "ok" : "failed"}`);
  await deps.api.completeRepoToolCall({
    callId: claim.callId,
    workerId: deps.workerId,
    ok: result.ok,
    result: capToolOutput(result.text),
    files: result.files,
  });
  return true;
}
