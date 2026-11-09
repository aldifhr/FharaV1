/**
 * Read-only repo tools for grounded chat replies: the tool contract shared
 * by the Convex chat action (which runs the LLM loop) and the worker (which
 * runs the tools against the project workspace on its host).
 *
 * Why the split: a Convex action cannot read the user's repository — on a
 * cloud deployment it runs elsewhere, and `projects.workspacePath` may even
 * be relative to the worker's workspace root. The worker already has the
 * repo and the sandbox guards, so each tool call is queued in
 * `repoToolCalls`, claimed by an online worker, and its capped result is
 * read back by the action. No worker online → the reply runs without tools.
 *
 * Pure: no Convex or Node APIs, so it is unit-testable and importable from
 * the worker (`@/api/convex/lib/chat/repoTools`).
 */
import { extractToolCalls, mayBeToolCall, normalizeRepoToolArgs } from "./toolCallText";

export { mayBeToolCall, normalizeRepoToolArgs };

/** Capability a worker advertises on heartbeat when it serves repo tool calls. */
export const REPO_TOOLS_CAPABILITY = "repoTools";

export const REPO_TOOL_NAMES = ["list_files", "grep", "read_file"] as const;
export type RepoToolName = (typeof REPO_TOOL_NAMES)[number];

/** Tool calls per reply; the model must answer after this many. */
export const MAX_REPO_TOOL_CALLS = 6;

/**
 * Tool calls across ALL agents answering one user message (the CTO plus its
 * handoffs, or several @mentioned agents), so three handoffs cannot run 18.
 */
export const MAX_REPO_TOOL_CALLS_PER_CHAT = 12;

/**
 * Shared repo-tool budget for one chat turn: each agent may use up to
 * `perReply` calls, and all of them together at most `total`.
 */
export function createRepoToolBudget(total: number = MAX_REPO_TOOL_CALLS_PER_CHAT, perReply: number = MAX_REPO_TOOL_CALLS) {
  let used = 0;
  return {
    /** Calls the next agent may make (0 = answer without tools). */
    capForNextReply(): number {
      return Math.max(0, Math.min(perReply, total - used));
    },
    spend(calls: number): void {
      used += Math.max(0, calls);
    },
    get used(): number {
      return used;
    },
    get total(): number {
      return total;
    },
  };
}

/** Worker-side output caps (one place, so tests and prompts agree). */
export const REPO_TOOL_CAPS = {
  listMaxEntries: 200,
  grepMaxMatches: 40,
  grepMaxLineChars: 200,
  grepMaxFileBytes: 1_000_000,
  grepMaxFilesScanned: 4_000,
  readDefaultLines: 200,
  readMaxLines: 400,
  readMaxBytes: 16_000,
  /** Hard cap on any single tool result text. */
  resultMaxChars: 12_000,
  /** Cap on the result fed back into the model prompt. */
  promptResultMaxChars: 8_000,
  patternMaxChars: 200,
} as const;

export interface RepoToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface RepoToolResult {
  ok: boolean;
  text: string;
  /** Repo-relative files this call read (read_file only). */
  files?: string[];
}

export function isRepoToolName(name: string): name is RepoToolName {
  return (REPO_TOOL_NAMES as readonly string[]).includes(name);
}

/** Clip `text` to `max` chars with a visible truncation marker. */
export function capToolOutput(text: string, max: number = REPO_TOOL_CAPS.resultMaxChars): string {
  if (text.length <= max) return text;
  const marker = `\n… [truncated: ${text.length - max} more chars]`;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/**
 * A model reply that is (only) one tool call: a JSON object with a string
 * `tool` (or `name` + `arguments`), optionally fenced or tagged. Prose that
 * merely contains JSON is an answer, not a call. Arguments are normalized
 * (aliases such as `maxLines` → `lines`). The loop itself uses the lenient
 * `extractToolCalls`, which also handles several calls plus prose.
 */
export function parseRepoToolCall(text: string): RepoToolCall | null {
  const { calls, prose, malformed } = extractToolCalls(text);
  if (calls.length !== 1 || prose || malformed) return null;
  return calls[0];
}

/** Short label for a call, e.g. `grep "foo" in src` (for the tool result header). */
export function describeRepoToolCall(call: RepoToolCall): string {
  const a = normalizeRepoToolArgs(call.args ?? {});
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (call.tool) {
    case "read_file":
      return `read_file ${str(a.path)}${a.start ? ` from line ${String(a.start)}` : ""}`;
    case "grep":
      return `grep ${JSON.stringify(str(a.pattern))}${str(a.path) ? ` in ${str(a.path)}` : ""}${str(a.glob) ? ` (${str(a.glob)})` : ""}`;
    case "list_files":
      return `list_files ${str(a.path) || "."}${str(a.glob) ? ` (${str(a.glob)})` : ""}`;
    case "load_skill":
      return `load_skill ${JSON.stringify(str(a.name))}`;
    default:
      return call.tool;
  }
}

/** The user-role message that feeds one tool result back to the model. */
export function toolResultMessage(call: RepoToolCall, result: RepoToolResult, note = ""): string {
  const header = `[tool result: ${describeRepoToolCall(call)}${result.ok ? "" : " — failed"}]`;
  return `${header}\n${capToolOutput(result.text, REPO_TOOL_CAPS.promptResultMaxChars)}${note ? `\n${note}` : ""}`;
}

/** Fed back when one reply held several calls (and/or prose): only the first ran. */
export const ONE_CALL_PER_REPLY =
  "(Only your first tool call ran; anything else in that reply was discarded. Call one tool per reply and wait for its result before answering.)";

export const TOOL_BUDGET_EXHAUSTED =
  "Tool budget for this reply is used up. Answer the user now from the tool results above, without calling a tool. For anything you did not check, say you have not checked it yet (Indonesian: \"belum saya cek\"). Cite only files and file:line references that a tool result above shows.";

export interface RepoToolLoopStep {
  content: string;
}

export interface RepoToolLoopOptions {
  /** The conversation sent to the model; tool turns are appended to a copy. */
  messages: Array<{ role: string; content: string }>;
  /** One LLM call. Returns the model's full reply text. */
  step: (messages: Array<{ role: string; content: string }>) => Promise<RepoToolLoopStep>;
  /** Runs one tool call (never throws; failures come back as ok:false). */
  callTool: (call: RepoToolCall) => Promise<RepoToolResult>;
  maxCalls?: number;
  /**
   * Tools that run in the caller (no worker queue), e.g. `load_skill` for an
   * on-demand agent. They have their own budget (`maxLocalCalls`) and do not
   * count against `maxCalls`.
   */
  localTools?: Record<string, (call: RepoToolCall) => RepoToolResult | Promise<RepoToolResult>>;
  maxLocalCalls?: number;
  onToolCall?: (call: RepoToolCall, result: RepoToolResult) => void | Promise<void>;
}

export interface RepoToolLoopResult {
  /** The answer with every tool-call text removed ("" when none came). */
  answer: string;
  calls: Array<{ call: RepoToolCall; ok: boolean }>;
  /** What each call returned, as the model saw it (for the post-answer reference check). */
  results: Array<{ label: string; text: string; files?: string[] }>;
  /** Files successfully read, in first-read order, de-duplicated. */
  checkedFiles: string[];
  /** Calls that went to repo tools (the shared chat budget counts only these). */
  repoCalls: number;
}

/**
 * Bounded tool loop: the model either replies with one JSON tool call (run
 * it, feed the result back, repeat) or with its answer (done). After
 * `maxCalls` tool calls the model gets one last step to answer without tools.
 */
export async function runRepoToolLoop(options: RepoToolLoopOptions): Promise<RepoToolLoopResult> {
  const maxCalls = options.maxCalls ?? MAX_REPO_TOOL_CALLS;
  const local = options.localTools ?? {};
  const localNames = Object.keys(local);
  const maxLocal = localNames.length ? Math.max(0, options.maxLocalCalls ?? 0) : 0;
  const messages = [...options.messages];
  const calls: RepoToolLoopResult["calls"] = [];
  const results: RepoToolLoopResult["results"] = [];
  const checked: string[] = [];
  let repoCalls = 0;
  let localCalls = 0;
  const done = (answer: string): RepoToolLoopResult => ({ answer, calls, results, checkedFiles: checked, repoCalls });
  const steps = maxCalls + maxLocal;

  for (let i = 0; i <= steps; i += 1) {
    const exhausted = i === steps || (repoCalls >= maxCalls && localCalls >= maxLocal);
    if (exhausted) messages.push({ role: "user", content: TOOL_BUDGET_EXHAUSTED });
    const { content } = await options.step(messages);
    // Lenient: one reply may hold several calls and/or prose. Only the
    // first call runs; prose written next to a call (before any result)
    // is discarded, and no call text ever reaches the answer.
    const found = extractToolCalls(content);
    if (found.calls.length === 0 || exhausted) return done(found.prose);
    const call: RepoToolCall = { tool: found.calls[0].tool, args: normalizeRepoToolArgs(found.calls[0].args) };
    let result: RepoToolResult;
    if (localNames.includes(call.tool)) {
      if (localCalls >= maxLocal) {
        result = { ok: false, text: `${call.tool} limit reached for this reply. Answer with what you have.` };
      } else {
        localCalls += 1;
        result = await local[call.tool](call);
      }
    } else if (isRepoToolName(call.tool) && repoCalls < maxCalls) {
      repoCalls += 1;
      result = await options.callTool(call);
    } else {
      const available = [...(maxCalls > 0 ? REPO_TOOL_NAMES : []), ...localNames];
      result = {
        ok: false,
        text:
          isRepoToolName(call.tool) && maxCalls > 0
            ? "Repo tool budget for this reply is used up. Answer from what you have."
            : `Tool "${call.tool}" is not available.${available.length ? ` Read-only tools: ${available.join(", ")}.` : ""} You cannot write files or run commands.`,
      };
    }
    calls.push({ call, ok: result.ok });
    if (result.ok) {
      for (const file of result.files ?? []) if (!checked.includes(file)) checked.push(file);
    }
    results.push({
      label: describeRepoToolCall(call),
      text: capToolOutput(result.text, REPO_TOOL_CAPS.promptResultMaxChars),
      files: result.ok ? result.files : undefined,
    });
    await options.onToolCall?.(call, result);
    const extra = found.calls.length > 1 || found.prose ? ONE_CALL_PER_REPLY : "";
    messages.push({ role: "assistant", content: JSON.stringify({ tool: call.tool, arguments: call.args }) });
    // A loaded skill is fed back whole (it has its own cap); repo results
    // keep the prompt cap.
    const fed = localNames.includes(call.tool)
      ? `[tool result: ${describeRepoToolCall(call)}${result.ok ? "" : " — failed"}]\n${result.text}${extra ? `\n${extra}` : ""}`
      : toolResultMessage(call, result, extra);
    messages.push({ role: "user", content: fed });
  }
  return done("");
}
