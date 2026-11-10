/**
 * Plan 036: the `web_reach` host tool for read-only agents.
 *
 * The tool wraps the Agent Reach CLI (see `tools/agentReach.ts`) and gives
 * research / audit agents a way to search the public web and read public
 * platform content (V2EX, YouTube, GitHub, Bilibili) during a subtask.
 *
 * Governance:
 *  - The agent must declare `web_reach` in its `supportedTools`; without
 *    that the tool is not offered and not callable.
 *  - Only the channels and actions in the allowlist table are reachable, so
 *    the tool can never write, post, comment, like, message or log in.
 *  - Every call is time-boxed, aborted with the task, and reported as an
 *    event with the channel/action only (never the payload).
 */

import {
  AGENT_REACH_CHANNELS,
  buildAgentReachArgs,
  formatAgentReachResult,
  runAgentReach,
  type AgentReachExec,
} from "@/tools/agentReach";
import { maskStringSecrets } from "@/governance/tools";

export const WEB_REACH_TOOL_NAME = "web_reach";

export interface WebReachConfig {
  /** The Agent Reach binary. */
  command: string;
  /** Wall-clock limit per call. */
  timeoutMs: number;
  /** Cap on the returned items per call. */
  maxItems: number;
  /** Bound on the tool-loop rounds per subtask. */
  maxIterations: number;
  /** Test seam: the process runner for the CLI. */
  execFile?: AgentReachExec;
}

/** The tool as the model sees it (name, description, argument schema). */
export const WEB_REACH_TOOL = {
  name: WEB_REACH_TOOL_NAME,
  description: [
    "Read public web content through Agent Reach (read-only).",
    "Search the web, read a public page as text, or read public platform content.",
    `Channels: ${Object.entries(AGENT_REACH_CHANNELS)
      .map(([channel, actions]) => `${channel} (${actions.map((a) => a.name).join(", ")})`)
      .join("; ")}.`,
    "It never writes, posts or logs in.",
  ].join(" "),
  inputSchema: {
    type: "object",
    required: ["channel", "action"],
    properties: {
      channel: {
        type: "string",
        enum: Object.keys(AGENT_REACH_CHANNELS),
        description: "The platform to read from.",
      },
      action: {
        type: "string",
        description: "The action to run (per channel: search, read, hot, node, user, subtitle).",
      },
      query: {
        type: "string",
        description: "The search query, URL, node name or handle. Required by the actions that take one.",
      },
      limit: {
        type: "number",
        description: "How many results to fetch (1-20). Only for actions that accept it.",
      },
    },
  } as Record<string, unknown>,
};

/** True when the agent declared the tool in its `supportedTools` scope. */
export function agentAllowsWebReach(supportedTools: readonly string[] | undefined): boolean {
  return Array.isArray(supportedTools) && supportedTools.includes(WEB_REACH_TOOL_NAME);
}

export interface WebReachCallOutcome {
  ok: boolean;
  text: string;
  isError: boolean;
}

/**
 * Execute one `web_reach` call.
 *
 * The arguments come from the model, so every one of them is validated
 * before the CLI is spawned. A refusal is reported back as a tool error the
 * model can correct, never as a crash.
 */
export async function runWebReachTool(
  args: Record<string, unknown>,
  options: { config: WebReachConfig; signal?: AbortSignal }
): Promise<WebReachCallOutcome> {
  const channel = typeof args.channel === "string" ? args.channel : "";
  const action = typeof args.action === "string" ? args.action : "";
  const query = typeof args.query === "string" ? args.query : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  const built = buildAgentReachArgs({ channel, action, query, limit });
  if (!built.ok) {
    return { ok: false, text: built.reason, isError: true };
  }

  const result = await runAgentReach(
    { channel, action, query, limit },
    {
      command: options.config.command,
      timeoutMs: options.config.timeoutMs,
      maxItems: options.config.maxItems,
      signal: options.signal,
      execFile: options.config.execFile,
    }
  );
  const text = maskStringSecrets(formatAgentReachResult(result));
  return { ok: result.ok, text, isError: !result.ok };
}
