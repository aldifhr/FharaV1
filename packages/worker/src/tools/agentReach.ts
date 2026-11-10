import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { assertUrlAllowed } from "@/tools/urlGuard";

const execFileAsync = promisify(execFile);

/**
 * Agent Reach — read-only public-web access for Fhara's agents.
 *
 * Agent Reach (`https://github.com/Panniantong/Agent-Reach`) is a CLI that
 * reads public platform content (web, V2EX, YouTube, GitHub, Bilibili) and
 * prints one JSON object per call. Fhara shells out to it instead of
 * re-implementing the per-platform scrapers.
 *
 * Safety model:
 *  - The channel/action pair comes from a fixed enum table, never from the
 *    model's free text. There is no write, post, comment, like, message or
 *    login action in the table, so the tool is read-only by construction.
 *  - The argument is validated (length, no control characters, no leading
 *    `-` so it can never be read as a flag) and URL arguments go through the
 *    shared `assertUrlAllowed` guard (loopback / private / metadata hosts
 *    are refused).
 *  - The binary is spawned without a shell, with the scrubbed child env, a
 *    timeout and the task's abort signal.
 *  - The `raw` field of the upstream payload is dropped: it can be tens of
 *    kilobytes of platform-internal JSON that the model never needs.
 */

export interface AgentReachAction {
  /** The action name Agent Reach expects (`search`, `read`, ...). */
  name: string;
  /** Whether the action takes one positional argument. */
  takesArgument: boolean;
  /** Whether the action accepts `--limit`. */
  takesLimit: boolean;
  /** One-line help for the tool catalog. */
  help: string;
}

/**
 * The public channels. Channels that need a logged-in browser session
 * (twitter, reddit, xiaohongshu, linkedin, boss, …) are deliberately absent:
 * the worker machine must not hold platform sessions or cookies.
 */
export const AGENT_REACH_CHANNELS: Record<string, AgentReachAction[]> = {
  web: [
    { name: "search", takesArgument: true, takesLimit: true, help: "Search the public web." },
    { name: "read", takesArgument: true, takesLimit: false, help: "Read a public page as clean text." },
  ],
  v2ex: [
    { name: "hot", takesArgument: false, takesLimit: true, help: "Today's hot V2EX topics." },
    { name: "node", takesArgument: true, takesLimit: true, help: "Latest topics in a V2EX node." },
    { name: "read", takesArgument: true, takesLimit: false, help: "Read a V2EX topic and its replies." },
    { name: "user", takesArgument: true, takesLimit: false, help: "Read a V2EX member profile." },
  ],
  youtube: [
    { name: "search", takesArgument: true, takesLimit: true, help: "Search YouTube videos." },
    { name: "read", takesArgument: true, takesLimit: false, help: "Read a YouTube video's metadata." },
    { name: "subtitle", takesArgument: true, takesLimit: false, help: "Read a YouTube video's subtitles." },
  ],
  github: [
    { name: "search", takesArgument: true, takesLimit: true, help: "Search public GitHub repositories." },
    { name: "read", takesArgument: true, takesLimit: false, help: "Read a repository, issue or PR." },
  ],
  bilibili: [
    { name: "search", takesArgument: true, takesLimit: true, help: "Search Bilibili videos." },
    { name: "read", takesArgument: true, takesLimit: false, help: "Read a Bilibili video." },
    { name: "hot", takesArgument: false, takesLimit: true, help: "Trending Bilibili videos." },
  ],
};

export const AGENT_REACH_CHANNEL_NAMES = Object.keys(AGENT_REACH_CHANNELS);

export interface AgentReachRequest {
  channel: string;
  action: string;
  /** The positional argument (query, URL, username, node name). */
  query?: string;
  /** Result cap (1..20); only meaningful for actions that accept `--limit`. */
  limit?: number;
}

export type AgentReachArgsResult =
  | { ok: true; args: string[] }
  | { ok: false; reason: string };

/** Longest argument the tool accepts (a URL, a query, a handle). */
export const AGENT_REACH_MAX_QUERY_CHARS = 500;
/** Upper bound of the `--limit` value. */
export const AGENT_REACH_MAX_LIMIT = 20;

/** Control characters (including newlines) are never valid in an argument. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function actionFor(channel: string, action: string): AgentReachAction | undefined {
  const actions = AGENT_REACH_CHANNELS[channel];
  if (!actions) return undefined;
  return actions.find((entry) => entry.name === action);
}

/**
 * Build the exact argv for one Agent Reach call.
 *
 * Returns the reason instead of throwing: the tool call fails with a
 * readable message the model can correct, and the subtask keeps running.
 */
export function buildAgentReachArgs(request: AgentReachRequest): AgentReachArgsResult {
  const channel = (request.channel ?? "").trim().toLowerCase();
  const action = (request.action ?? "").trim().toLowerCase();
  if (!channel || !action) return { ok: false, reason: "channel and action are required" };
  if (!AGENT_REACH_CHANNELS[channel]) {
    return { ok: false, reason: `Channel "${channel}" is not allowed (allowed: ${AGENT_REACH_CHANNEL_NAMES.join(", ")})` };
  }
  const spec = actionFor(channel, action);
  if (!spec) {
    const allowed = AGENT_REACH_CHANNELS[channel].map((entry) => entry.name).join(", ");
    return { ok: false, reason: `Action "${action}" is not allowed for channel "${channel}" (allowed: ${allowed})` };
  }

  const args: string[] = [channel, action];
  const query = (request.query ?? "").trim();
  if (spec.takesArgument) {
    if (!query) return { ok: false, reason: `Action "${channel} ${action}" needs an argument (query, URL or handle)` };
    if (query.length > AGENT_REACH_MAX_QUERY_CHARS) {
      return { ok: false, reason: `The argument is too long (max ${AGENT_REACH_MAX_QUERY_CHARS} characters)` };
    }
    if (CONTROL_CHARS.test(query)) return { ok: false, reason: "The argument contains control characters" };
    if (query.startsWith("-")) return { ok: false, reason: "The argument may not start with '-'" };
    // URL arguments go through the shared outbound guard: a loopback,
    // private or metadata host is refused before the CLI ever sees it.
    if (/^https?:\/\//i.test(query)) {
      try {
        assertUrlAllowed(query);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "Blocked URL" };
      }
    }
    args.push(query);
  } else if (query) {
    return { ok: false, reason: `Action "${channel} ${action}" takes no argument` };
  }

  if (request.limit !== undefined) {
    if (!spec.takesLimit) return { ok: false, reason: `Action "${channel} ${action}" does not accept a limit` };
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > AGENT_REACH_MAX_LIMIT) {
      return { ok: false, reason: `limit must be an integer between 1 and ${AGENT_REACH_MAX_LIMIT}` };
    }
    args.push("--limit", String(request.limit));
  }

  return { ok: true, args };
}

export interface AgentReachItem {
  title?: string;
  url?: string;
  author?: string;
  published_at?: string;
  text?: string;
}

export interface AgentReachResult {
  ok: boolean;
  items: AgentReachItem[];
  /** Upstream error code (`NEED_SETUP`, `RATE_LIMITED`, ...) when the call failed. */
  errorCode?: string;
  errorMessage?: string;
  /** Upstream hint for the model (e.g. "install the channel first"). */
  hint?: string;
  /** True when the failure is ours (binary missing, timeout, bad args). */
  local?: boolean;
}

interface AgentReachEnvelope {
  ok?: boolean;
  items?: unknown;
  error?: { code?: string; message?: string; hint?: string } | null;
}

function normalizeItems(raw: unknown): AgentReachItem[] {
  if (!Array.isArray(raw)) return [];
  const items: AgentReachItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    items.push({
      title: typeof value.title === "string" ? value.title : undefined,
      url: typeof value.url === "string" ? value.url : undefined,
      author: typeof value.author === "string" ? value.author : undefined,
      published_at: typeof value.published_at === "string" ? value.published_at : undefined,
      text: typeof value.text === "string" ? value.text : undefined,
    });
  }
  return items;
}

export interface AgentReachOptions {
  /** The binary to run (default `agent-reach`). */
  command?: string;
  /** Wall-clock limit for one call. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cap on the returned items. */
  maxItems?: number;
  /** Test seam: the process runner (the CLI is spawned without a shell). */
  execFile?: AgentReachExec;
}

/** How one Agent Reach process is run (test seam). */
export type AgentReachExec = (
  file: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;

const AGENT_REACH_DEFAULT_COMMAND = "agent-reach";
const AGENT_REACH_DEFAULT_TIMEOUT_MS = 60_000;

/** The default runner: `execFile`, no shell, scrubbed child env. */
const defaultExec: AgentReachExec = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: options.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env: buildChildEnv(),
    signal: options.signal,
  });
  return { stdout, stderr };
};

/**
 * Run one Agent Reach call and parse its JSON envelope.
 *
 * Never throws: a missing binary, a timeout or a malformed payload becomes
 * an error result the caller reports to the model.
 */
export async function runAgentReach(
  request: AgentReachRequest,
  options: AgentReachOptions = {}
): Promise<AgentReachResult> {
  const built = buildAgentReachArgs(request);
  if (!built.ok) return { ok: false, items: [], errorCode: "BAD_INPUT", errorMessage: built.reason, local: true };

  const command = options.command?.trim() || AGENT_REACH_DEFAULT_COMMAND;
  const timeoutMs = options.timeoutMs ?? AGENT_REACH_DEFAULT_TIMEOUT_MS;
  const exec = options.execFile ?? defaultExec;
  try {
    const { stdout } = await exec(command, built.args, { timeoutMs, signal: options.signal });
    let envelope: AgentReachEnvelope | null = null;
    try {
      envelope = JSON.parse(stdout) as AgentReachEnvelope;
    } catch {
      return {
        ok: false,
        items: [],
        errorCode: "BAD_OUTPUT",
        errorMessage: "Agent Reach did not return JSON",
        local: true,
      };
    }
    if (!envelope || envelope.ok !== true) {
      return {
        ok: false,
        items: normalizeItems(envelope?.items),
        errorCode: envelope?.error?.code ?? "UPSTREAM_BROKEN",
        errorMessage: envelope?.error?.message ?? "Agent Reach reported a failure",
        hint: envelope?.error?.hint,
      };
    }
    const items = normalizeItems(envelope.items);
    const maxItems = options.maxItems ?? AGENT_REACH_MAX_LIMIT;
    return { ok: true, items: items.slice(0, Math.max(1, maxItems)) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (options.signal?.aborted) {
      return { ok: false, items: [], errorCode: "CANCELLED", errorMessage: "The call was cancelled", local: true };
    }
    if (err?.code === "ENOENT") {
      return {
        ok: false,
        items: [],
        errorCode: "NOT_INSTALLED",
        errorMessage: `Agent Reach is not installed on this worker machine (${command} not found)`,
        hint: "Install it with: uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip",
        local: true,
      };
    }
    if (err?.code === "ETIMEDOUT" || (err as { killed?: boolean })?.killed) {
      return {
        ok: false,
        items: [],
        errorCode: "TIMEOUT",
        errorMessage: `Agent Reach did not answer within ${timeoutMs} ms`,
        local: true,
      };
    }
    return {
      ok: false,
      items: [],
      errorCode: "UPSTREAM_BROKEN",
      errorMessage: err?.message ?? "Agent Reach failed",
      local: true,
    };
  }
}

/** Render a result as the compact text the model reads. */
export function formatAgentReachResult(result: AgentReachResult): string {
  if (!result.ok) {
    const hint = result.hint ? ` (${result.hint})` : "";
    return `Agent Reach failed [${result.errorCode ?? "ERROR"}]: ${result.errorMessage ?? "unknown error"}${hint}`;
  }
  if (result.items.length === 0) return "Agent Reach returned no results.";
  return result.items
    .map((item, index) => {
      const head = [item.title, item.url].filter(Boolean).join(" — ");
      const meta = [item.author, item.published_at].filter(Boolean).join(", ");
      const text = (item.text ?? "").trim();
      return [`${index + 1}. ${head}`, meta ? `   ${meta}` : "", text ? `   ${text.slice(0, 1200)}` : ""]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
