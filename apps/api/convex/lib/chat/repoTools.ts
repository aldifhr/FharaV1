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

export const REPO_TOOL_NAMES = ["list_files", "grep", "read_file"] as const;
export type RepoToolName = (typeof REPO_TOOL_NAMES)[number];

/** Tool calls per reply; the model must answer after this many. */
export const MAX_REPO_TOOL_CALLS = 6;

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
 * A model reply that is (only) a tool call: a single JSON object with a
 * string `tool`, optionally inside a ```json fence. Prose that merely
 * contains JSON is an answer, not a call.
 */
export function parseRepoToolCall(text: string): RepoToolCall | null {
  let body = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(body);
  if (fence) body = fence[1].trim();
  // Some models wrap calls in <tool_call>…</tool_call> (Hermes/Qwen style).
  const tagged = /^<((?:[a-z_]+_)?tool_call)\b[^>]*>([\s\S]*?)<\/\1>$/i.exec(body);
  if (tagged) body = tagged[2].trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const name = typeof parsed.tool === "string" ? parsed.tool : typeof parsed.name === "string" ? parsed.name : "";
    if (!name.trim()) return null;
    const rawArgs = parsed.arguments ?? parsed.args ?? {};
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    return { tool: name.trim(), args };
  } catch {
    return null;
  }
}

/**
 * While streaming: could this partial reply still turn out to be a tool
 * call? Such text is not shown in the bubble until it is known to be prose.
 */
export function mayBeToolCall(partial: string): boolean {
  const t = partial.trimStart();
  if (!t) return true;
  return t.startsWith("{") || t.startsWith("```") || /^<(?:[a-z_]+_)?tool/i.test(t);
}

/** Short label for a call, e.g. `grep "foo" in src` (for the tool result header). */
export function describeRepoToolCall(call: RepoToolCall): string {
  const a = call.args;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (call.tool) {
    case "read_file":
      return `read_file ${str(a.path)}${a.startLine ? ` from line ${String(a.startLine)}` : ""}`;
    case "grep":
      return `grep ${JSON.stringify(str(a.pattern))}${str(a.path) ? ` in ${str(a.path)}` : ""}${str(a.glob) ? ` (${str(a.glob)})` : ""}`;
    case "list_files":
      return `list_files ${str(a.path) || "."}${str(a.glob) ? ` (${str(a.glob)})` : ""}`;
    default:
      return call.tool;
  }
}

/** The user-role message that feeds one tool result back to the model. */
export function toolResultMessage(call: RepoToolCall, result: RepoToolResult): string {
  const header = `[tool result: ${describeRepoToolCall(call)}${result.ok ? "" : " — failed"}]`;
  return `${header}\n${capToolOutput(result.text, REPO_TOOL_CAPS.promptResultMaxChars)}`;
}

export const TOOL_BUDGET_EXHAUSTED =
  "Tool budget for this reply is used up. Answer the user now from the tool results above, without calling a tool. For anything you did not check, say you have not checked it yet (Indonesian: \"belum saya cek\").";

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
  onToolCall?: (call: RepoToolCall, result: RepoToolResult) => void | Promise<void>;
}

export interface RepoToolLoopResult {
  answer: string;
  calls: Array<{ call: RepoToolCall; ok: boolean }>;
  /** Files successfully read, in first-read order, de-duplicated. */
  checkedFiles: string[];
}

/**
 * Bounded tool loop: the model either replies with one JSON tool call (run
 * it, feed the result back, repeat) or with its answer (done). After
 * `maxCalls` tool calls the model gets one last step to answer without tools.
 */
export async function runRepoToolLoop(options: RepoToolLoopOptions): Promise<RepoToolLoopResult> {
  const maxCalls = options.maxCalls ?? MAX_REPO_TOOL_CALLS;
  const messages = [...options.messages];
  const calls: RepoToolLoopResult["calls"] = [];
  const checked: string[] = [];

  for (let i = 0; i <= maxCalls; i += 1) {
    const exhausted = i === maxCalls;
    if (exhausted) messages.push({ role: "user", content: TOOL_BUDGET_EXHAUSTED });
    const { content } = await options.step(messages);
    const call = parseRepoToolCall(content);
    if (!call) return { answer: content, calls, checkedFiles: checked };
    if (exhausted) break;
    const result = isRepoToolName(call.tool)
      ? await options.callTool(call)
      : {
          ok: false,
          text: `Tool "${call.tool}" is not available. Read-only tools: ${REPO_TOOL_NAMES.join(", ")}. You cannot write files or run commands.`,
        };
    calls.push({ call, ok: result.ok });
    if (result.ok) {
      for (const file of result.files ?? []) if (!checked.includes(file)) checked.push(file);
    }
    await options.onToolCall?.(call, result);
    messages.push({ role: "assistant", content: JSON.stringify({ tool: call.tool, arguments: call.args }) });
    messages.push({ role: "user", content: toolResultMessage(call, result) });
  }
  return { answer: "", calls, checkedFiles: checked };
}
