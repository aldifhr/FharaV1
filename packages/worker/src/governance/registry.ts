/**
 * Plan 006 Phase 5 — dynamic tool discovery registry.
 *
 * Built from the existing governed tools in `governance/tools.ts`.
 * `tool_search` / `tool_describe` / `tool_call` all enforce the calling
 * agent's `supportedTools` as the search scope; `audit` is invoked for
 * every call, secret-shaped args are redacted, and the sandbox / argv
 * allowlist rules from `tools.ts` are reused unchanged.
 */
import {
  audit,
  maskSecrets,
  maskStringSecrets,
  runGovernedFileTool,
  runGovernedCommandTool,
  runGovernedGitHubTool,
  validateFilePath,
  validateCommand,
  type ToolContext,
  type ToolResult,
  REASON_TOOL_UNKNOWN,
  REASON_TOOL_ARGS_INVALID,
} from "./tools";

export interface ToolDefinition {
  name: string;
  description: string;
  args: string[]; // arg names, for describe
  execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Permission matrix per role family (least privilege):
 *  - write-capable tools require a matching capability — read-only roles
 *    (researcher/support) are refused at the broker even if an
 *    agent declares the tool, and every denial is audited.
 */
const ROLE_DENIED_TOOLS: Array<{ pattern: RegExp; denied: string[] }> = [
  { pattern: /^researcher$/i, denied: ["write_file", "run_command"] },
  // Plan 022: the reviewer is strictly read-only (it judges diffs; the
  // runtime verification loop runs the commands). Before this rule a
  // reviewer that declared write_file/run_command reached them.
  { pattern: /^reviewer$/i, denied: ["write_file", "run_command"] },
];

const TOOL_REGISTRY: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file inside the workspace (sandbox-checked).",
    args: ["path"],
    execute: async (ctx, args) => {
      const path = args.path as string;
      if (typeof path !== "string" || !path) return { ok: false, reason: REASON_TOOL_ARGS_INVALID };
      return runGovernedFileTool(ctx, "read_file", { path });
    },
  },
  {
    name: "write_file",
    description: "Stage a write inside the workspace (sandbox-checked).",
    args: ["path", "content"],
    execute: async (ctx, args) => {
      const path = args.path as string;
      if (typeof path !== "string" || !path) return { ok: false, reason: REASON_TOOL_ARGS_INVALID };
      return runGovernedFileTool(ctx, "write_file", { path, content: args.content as string });
    },
  },
  {
    name: "run_command",
    description: "Run an exact-allowlisted command (sandbox argv).",
    args: ["command", "args"],
    execute: async (ctx, args) => {
      const command = args.command as string;
      if (typeof command !== "string" || !command) return { ok: false, reason: REASON_TOOL_ARGS_INVALID };
      return runGovernedCommandTool(ctx, { command, args: (args.args as string[]) ?? [] });
    },
  },
  {
    name: "github_list_repos",
    description: "List GitHub repositories for a user/org.",
    args: ["owner"],
    execute: async (ctx, args) =>
      runGovernedGitHubTool(ctx, "github_list_repos", { owner: args.owner as string }),
  },
  {
    name: "github_get_file",
    description: "Get a file from a GitHub repo.",
    args: ["owner", "repo", "path"],
    execute: async (ctx, args) =>
      runGovernedGitHubTool(ctx, "github_get_file", {
        owner: args.owner as string,
        repo: args.repo as string,
        path: args.path as string,
      }),
  },
];

const byName = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));

export function tool_search(input: { supportedTools?: string[]; query: string }): ToolDefinition[] {
  const q = input.query.toLowerCase();
  const allowed = input.supportedTools;
  return TOOL_REGISTRY.filter((t) => {
    if (allowed && allowed.length > 0 && !allowed.includes(t.name)) return false;
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  });
}

export function tool_describe(input: {
  supportedTools?: string[];
  name: string;
}): ToolDefinition | { ok: false; reason: string } {
  const def = byName.get(input.name);
  if (!def) return { ok: false, reason: REASON_TOOL_UNKNOWN };
  if (input.supportedTools && input.supportedTools.length > 0 && !input.supportedTools.includes(def.name)) {
    return { ok: false, reason: REASON_TOOL_UNKNOWN };
  }
  return def;
}

export async function tool_call(input: {
  ctx: ToolContext;
  supportedTools?: string[];
  name: string;
  args: Record<string, unknown>;
}): Promise<ToolResult> {
  // Unknown tool refused.
  const def = byName.get(input.name);
  const denied = async (reason: string, target?: string) => {
    await audit(input.ctx, {
      tool: input.name,
      action: "call",
      decision: "denied",
      target: maskStringSecrets(target ?? input.name),
      details: { reason, args: maskSecrets(input.args) },
    });
    return { ok: false, reason };
  };
  if (!def) return denied(REASON_TOOL_UNKNOWN);
  // Role matrix denial (least privilege), enforced at the broker layer.
  const roleName = input.ctx.agentRole ?? "";
  const matrixDenial = ROLE_DENIED_TOOLS.find(
    (rule) => rule.pattern.test(roleName) && rule.denied.includes(def.name)
  );
  if (matrixDenial) {
    return denied(`denied:${roleName ? `${roleName}:` : ""}${def.name}:read-only-role`);
  }
  // Search scope enforced.
  if (
    input.supportedTools &&
    input.supportedTools.length > 0 &&
    !input.supportedTools.includes(def.name)
  ) {
    return denied(REASON_TOOL_UNKNOWN);
  }
  // Sandbox escape refused.
  if (input.name === "read_file" || input.name === "write_file") {
    const path = input.args.path as string;
    const v = validateFilePath(path ?? "");
    if (!v.ok) return denied(v.reason, path);
  }
  // Exact-argv allowlist: prefix / chaining attacks refused.
  if (input.name === "run_command") {
    const cmd = input.args.command as string;
    if (typeof cmd !== "string" || cmd.includes(";") || cmd.includes("&") || cmd.includes("|")) {
      return denied("command-not-allowlisted", cmd);
    }
    const v = validateCommand(cmd ?? "");
    if (!v.ok) return denied(v.reason, cmd);
  }
  // Secret-shaped args redacted.
  const maskedArgs = maskSecrets(input.args) as Record<string, unknown>;
  await audit(input.ctx, {
    tool: input.name,
    action: "call",
    decision: "allowed",
    target: input.name,
    details: { args: maskedArgs },
  });
  // Delegate to the governed implementation (it audits again; harmless).
  return def.execute(input.ctx, maskedArgs as Record<string, unknown>);
}
