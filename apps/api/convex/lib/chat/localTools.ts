/**
 * Local tools for a grounded chat reply: tools the Convex chat action runs
 * itself (no worker queue), next to the worker-served repo tools.
 *
 * - `load_skill` (Skill v2): the agent's own on-demand skills, then the
 *   shared library skills it was offered (body read via skillLibrary.body).
 * - `search_past_work` (D11): this chat's project's earlier tasks, task
 *   results and messages. The project is the chat's own scope, never an
 *   argument the model can set, and the result is fenced as untrusted.
 *
 * Each tool keeps its own cap; `maxLocalCalls` is their sum.
 */
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { createSkillLoader, wantsLoadSkillTool, type SkillLoader } from "../skillRuntime";
import { LOAD_SKILL_MAX_CALLS, LOAD_SKILL_TOOL } from "../skills";
import type { ChatAgent } from "./team";
import { PAST_WORK_MAX_CALLS, PAST_WORK_TOOL, formatPastWorkResult } from "../pastWork";
import type { RepoToolCall, RepoToolResult } from "./repoTools";

type LocalTool = (call: RepoToolCall) => RepoToolResult | Promise<RepoToolResult>;

/** Runs one past-work search for a fixed project (injectable for tests). */
export type PastWorkRunner = (args: { query: string; limit?: number }) => Promise<string>;

export function pastWorkRunner(ctx: Pick<ActionCtx, "runQuery">, projectId: Id<"projects">): PastWorkRunner {
  return async ({ query, limit }) =>
    formatPastWorkResult(await ctx.runQuery(internal.pastWork.search, { projectId, query, ...(limit !== undefined ? { limit } : {}) }));
}

/** The past-work tool with its own per-reply cap. */
export function pastWorkLocalTool(run: PastWorkRunner, maxCalls: number = PAST_WORK_MAX_CALLS): LocalTool {
  let used = 0;
  return async (call) => {
    if (used >= maxCalls) return { ok: false, text: `${PAST_WORK_TOOL} limit reached for this reply. Answer with what you have.` };
    used += 1;
    // The loop normalizes arguments (`query` → `pattern`, `limit` → `lines`); accept both spellings.
    const args = call.args ?? {};
    const query = [args.query, args.pattern].find((value): value is string => typeof value === "string") ?? "";
    const rawLimit = args.limit ?? args.lines;
    const limit = typeof rawLimit === "number" ? rawLimit : typeof rawLimit === "string" && rawLimit.trim() ? Number(rawLimit) : undefined;
    try {
      return { ok: true, text: await run({ query, ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}) }) };
    } catch {
      return { ok: false, text: `${PAST_WORK_TOOL} failed. Answer without it.` };
    }
  };
}

/**
 * The reply's load_skill loader, or undefined when the agent has nothing to
 * load: its own on_demand skills (bodies in context) and its library index
 * (bodies fetched per call; the query re-checks the agent may use them).
 */
export function chatSkillLoader(ctx: Pick<ActionCtx, "runQuery">, agent: ChatAgent): SkillLoader | undefined {
  if (!wantsLoadSkillTool(agent.onDemandSkills, "on_demand", agent.librarySkills)) return undefined;
  return createSkillLoader(agent.onDemandSkills, {
    maxCalls: LOAD_SKILL_MAX_CALLS,
    library: agent.librarySkills,
    fetchBody: (ref) =>
      ctx.runQuery(internal.skillLibrary.body, {
        agentId: agent._id as Id<"agents">,
        name: ref.name,
        ...(ref.version !== undefined ? { version: ref.version } : {}),
      }),
  });
}

/** Spread into runRepoToolLoop options: `localTools` + `maxLocalCalls` (or nothing). */
export function chatLocalTools(opts: {
  skillLoader?: SkillLoader;
  pastWork?: PastWorkRunner | null;
}): { localTools?: Record<string, LocalTool>; maxLocalCalls?: number } {
  const tools: Record<string, LocalTool> = {};
  let max = 0;
  const loader = opts.skillLoader;
  if (loader) {
    tools[LOAD_SKILL_TOOL] = async (call) => {
      const loaded = await loader.loadAsync(call.args?.name ?? call.args?.skill);
      return { ok: loaded.ok, text: loaded.text };
    };
    max += loader.maxCalls + 1;
  }
  if (opts.pastWork) {
    tools[PAST_WORK_TOOL] = pastWorkLocalTool(opts.pastWork);
    max += PAST_WORK_MAX_CALLS;
  }
  return max > 0 ? { localTools: tools, maxLocalCalls: max } : {};
}
