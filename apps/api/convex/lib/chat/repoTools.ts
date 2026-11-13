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

/**
 * Repo tool calls per reply (one Plan-mode loop: read until the model answers
 * without a call). After this many the model must answer, report what it did
 * not read, and the reply carries the Create task offer for the full job.
 */
export const MAX_REPO_TOOL_CALLS = 25;

/**
 * Wall-clock and size guards for one tool loop: 25 calls at up to a 20 s
 * worker wait each, plus ~300 KB of results, can outrun the Convex action
 * limit or the model's context. Past either guard the loop stops calling
 * tools and ends like a spent budget (read/unread list + Create task offer).
 */
export const TOOL_LOOP_MAX_MS = 6 * 60_000;
export const TOOL_LOOP_MAX_RESULT_CHARS = 120_000;

/**
 * Shared repo-tool budget for one chat turn: each agent may use up to
 * `perReply` calls, and all of them together (several @mentioned agents) at
 * most `total`.
 */
export function createRepoToolBudget(total: number = MAX_REPO_TOOL_CALLS * 2, perReply: number = MAX_REPO_TOOL_CALLS) {
  let used = 0;
  // One wall clock for the whole turn: several replies share the action's time.
  const deadline = Date.now() + TOOL_LOOP_MAX_MS;
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
    /** Epoch ms after which no reply in this turn calls a tool. */
    get deadline(): number {
      return deadline;
    },
  };
}

/**
 * Worker-side output caps (one place, so tests and prompts agree). A read
 * (header + notes + `readMaxBytes` of lines) always fits `resultMaxChars`,
 * which is also what the model is fed: the "lines X-Y" header describes
 * exactly what the model sees.
 */
export const REPO_TOOL_CAPS = {
  listMaxEntries: 200,
  grepMaxMatches: 40,
  grepMaxLineChars: 200,
  grepMaxFileBytes: 1_000_000,
  grepMaxFilesScanned: 4_000,
  readDefaultLines: 250,
  readMaxLines: 400,
  readMaxBytes: 11_000,
  /** Hard cap on any single tool result text, and on what the model is fed. */
  resultMaxChars: 12_000,
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
    case "search_past_work":
      return `search_past_work ${JSON.stringify(str(a.pattern) || str(a.query))}`;
    default:
      return call.tool;
  }
}

/** The user-role message that feeds one tool result back to the model. */
export function toolResultMessage(call: RepoToolCall, result: RepoToolResult, note = ""): string {
  const header = `[tool result: ${describeRepoToolCall(call)}${result.ok ? "" : " — failed"}]`;
  return `${header}\n${capToolOutput(result.text)}${note ? `\n${note}` : ""}`;
}

/** Fed back when one reply held several calls (and/or prose): only the first ran. */
export const ONE_CALL_PER_REPLY =
  "(Only your first tool call ran; anything else in that reply was discarded. Call one tool per reply and wait for its result before answering.)";

/** What a reply says when the request covers more than it could read (shared by the budget lines and the prompts). */
export const SCOPE_EXIT_LINE =
  "If the request covers more than you read, list what you read and what you did not, and say the Create task button under this reply runs the full job. Never ask the user to type \"lanjut\" or to continue.";

export const TOOL_BUDGET_EXHAUSTED = `Tool budget for this reply is used up. Answer the user now from the tool results above, without calling a tool. ${SCOPE_EXIT_LINE} Cite only files and file:line references that a tool result above shows.`;

/** Fed back when the model stopped on narration or a call with no budget left. */
export const FINAL_ANSWER_NOW = `Stop checking. Write your final answer to the user now, in their language, from the tool results above: no tool call, no JSON, and no line about what you will read or do next. ${SCOPE_EXIT_LINE}`;

/** Fed back once when a question about the repo got an answer before any read. */
export const READ_FIRST =
  "You answered without reading the repository. The snapshot shows only which files exist and their sizes, not their contents. Reply with ONLY one JSON tool call now to read the code your answer depends on.";

/** Fed back once when a reply only announced a check without making it. */
export const CALL_OR_ANSWER =
  "Your last reply only said what you would check. Either reply with ONLY the JSON tool call now, or write your final answer.";

/**
 * A reply that only narrates the next step ("Saya cek ulang tiap nama
 * secara terpisah.", "Let me check the schema.") instead of answering.
 * Night e2e R-a3: the tool loop ended on such a line, with no answer.
 */
const NARRATION =
  /^(?:(?:oke|ok|baik|sip|siap|alright|okay|sure)[,!.\s]+)?(?:saya|aku|gue|gw|kita|let me|let's|i'?ll|i will|i'?m going to|i am going to|now i|next i|sebentar|tunggu|mari)\b[^.!?\n]{0,160}\b(?:cek|check|periksa|lihat|baca|look|read|verify|verifikasi|search|cari|grep|telusuri|pastikan|inspect|membaca|memeriksa|mengecek|melihat)/i;
export function isNarrationOnly(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > 240 || t.split(/(?<=[.!?…:])\s+/).filter(Boolean).length > 2) return false;
  // Addressed to the user, not a plan: "Saya cek sendiri. @QA bisa bantu
  // kalau Anda minta." (an @mention pointer or a "kalau Anda / if you" offer).
  // Treating it as narration nudged twice and then dropped the whole reply.
  if (/(?:^|\s)@[A-Za-z]\w*|\b(?:kalau|jika|bila|kalo) (?:anda|kamu|mau)\b|\bif you\b/i.test(t)) return false;
  // A finding, not a plan: "Saya sudah cek: tidak ketemu", "I checked src/x.ts".
  if (/\b(?:sudah|telah|udah|tidak ketemu|nggak ketemu|ditemukan|ketemu|found|checked|i'?ve|have|has|hasilnya|result)\b|`|\w\.(?:ts|tsx|js|json|md)\b|:\d+/i.test(t)) return false;
  return NARRATION.test(t) || /(?:…|\.\.\.|:)\s*$/.test(t) && /\b(?:cek|check|periksa|lihat|look|verify)\b/i.test(t);
}

/**
 * Drop leading paragraphs that only narrate the next step ("Saya akan
 * membaca…", "Let me check…") when an answer follows them.
 */
export function stripLeadingNarration(text: string): string {
  const parts = text.split(/\n\s*\n/);
  let i = 0;
  while (i < parts.length - 1 && isNarrationOnly(parts[i])) i += 1;
  return i === 0 ? text : parts.slice(i).join("\n\n").trimStart();
}

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
  /** The question is about repo code/files: a first answer with no read gets one READ_FIRST nudge. */
  requireRead?: boolean;
  /** Epoch ms after which no tool runs (default: start + TOOL_LOOP_MAX_MS); pass a turn-wide one to share it. */
  deadline?: number;
  /** Tool-result chars fed back to the model before tools stop (default TOOL_LOOP_MAX_RESULT_CHARS). */
  maxResultChars?: number;
  /** Clock (tests). */
  now?: () => number;
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
  /** The loop ran out of repo calls, time or result size: the reply gets the Create task offer. */
  budgetHit: boolean;
  /** Set when a wall-clock or result-size guard stopped tool calls. */
  stopped?: "time" | "size";
}

/**
 * One read-only tool loop per reply (Plan mode): the model either replies
 * with one JSON tool call (run it, feed the result back, repeat) or with its
 * answer (done). After `maxCalls` tool calls the model gets one last step to
 * answer without tools. There is no auto-continue beyond this reply.
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
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + TOOL_LOOP_MAX_MS;
  const maxResultChars = options.maxResultChars ?? TOOL_LOOP_MAX_RESULT_CHARS;
  let resultChars = 0;
  let stopped: RepoToolLoopResult["stopped"];
  // Set when the model asks for a repo tool after the repo budget is used up
  // while local tools still have budget: the next step is the final one.
  let repoSpent = false;
  const done = (answer: string): RepoToolLoopResult => ({
    answer: stripLeadingNarration(answer),
    calls,
    results,
    checkedFiles: checked,
    repoCalls,
    budgetHit: stopped !== undefined || repoSpent || (maxCalls > 0 && repoCalls >= maxCalls),
    ...(stopped ? { stopped } : {}),
  });
  const steps = maxCalls + maxLocal;

  // The loop always ends on an answer: when the model stops on narration
  // ("Saya cek ulang…") or on a call it has no budget for, one more step
  // is forced with FINAL_ANSWER_NOW (and no tools).
  const forceFinal = async (): Promise<RepoToolLoopResult> => {
    messages.push({ role: "user", content: FINAL_ANSWER_NOW });
    const { content } = await options.step(messages);
    const prose = extractToolCalls(content).prose.trim();
    return done(isNarrationOnly(prose) ? "" : prose);
  };
  let nudged = false;
  let readNudged = !options.requireRead || maxCalls <= 0;
  for (let i = 0; i <= steps; i += 1) {
    // Guards (only for a loop that has tools): past the deadline or the result-size cap, no more calls.
    if (!stopped && steps > 0) stopped = now() >= deadline ? "time" : resultChars >= maxResultChars ? "size" : undefined;
    const exhausted = i === steps || repoSpent || stopped !== undefined || (repoCalls >= maxCalls && localCalls >= maxLocal);
    if (exhausted) messages.push({ role: "user", content: TOOL_BUDGET_EXHAUSTED });
    const { content } = await options.step(messages);
    // Lenient: one reply may hold several calls and/or prose. Only the
    // first call runs; prose written next to a call (before any result)
    // is discarded, and no call text ever reaches the answer.
    const found = extractToolCalls(content);
    if (exhausted) {
      const prose = found.prose.trim();
      if (found.calls.length > 0 || !prose || isNarrationOnly(prose)) return forceFinal();
      return done(found.prose);
    }
    if (found.calls.length === 0) {
      const prose = found.prose.trim();
      if (prose && !isNarrationOnly(prose) && !readNudged && repoCalls === 0) {
        // Read before claim: one nudge, does not use a step.
        readNudged = true;
        messages.push({ role: "assistant", content: prose });
        messages.push({ role: "user", content: READ_FIRST });
        i -= 1;
        continue;
      }
      if (!isNarrationOnly(prose) && prose) return done(found.prose);
      if (!nudged) {
        // One nudge: make the announced check, or answer. Does not use a step.
        nudged = true;
        messages.push({ role: "assistant", content: prose || "(empty reply)" });
        messages.push({ role: "user", content: CALL_OR_ANSWER });
        i -= 1;
        continue;
      }
      if (prose) messages.push({ role: "assistant", content: prose });
      return forceFinal();
    }
    const call: RepoToolCall = { tool: found.calls[0].tool, args: normalizeRepoToolArgs(found.calls[0].args) };
    // The model step itself can be slow: re-check the clock before any tool runs.
    if (now() >= deadline) {
      stopped = "time";
      continue;
    }
    if (isRepoToolName(call.tool) && maxCalls > 0 && repoCalls >= maxCalls) {
      repoSpent = true;
      continue;
    }
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
      text: capToolOutput(result.text),
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
    resultChars += fed.length;
    messages.push({ role: "user", content: fed });
  }
  return forceFinal();
}
