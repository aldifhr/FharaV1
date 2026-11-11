import { clampPastWorkLimit, formatPastWorkResult, PAST_WORK_TOOL, type PastWorkSearchResult } from "@/api/convex/lib/pastWork";

export const REASON_FILE_ESCAPES_WORKSPACE = "file-escapes-workspace";
export const REASON_FILE_PATH_FORBIDDEN = "file-path-forbidden";
export const REASON_COMMAND_NOT_ALLOWLISTED = "command-not-allowlisted";
export const REASON_COMMAND_CONTROL_CHARS = "command-control-chars";
export const REASON_NETWORK_PRIVATE_TARGET = "network-private-target";
export const REASON_NETWORK_URL_INVALID = "network-url-invalid";
export const REASON_SECRET_EXPOSURE = "secret-exposure-risk";
export const REASON_TOOL_UNKNOWN = "tool-unknown";
export const REASON_TOOL_ARGS_INVALID = "tool-args-invalid";
export const REASON_PAST_WORK_NO_PROJECT = "past-work-no-project";
export const REASON_PAST_WORK_FAILED = "past-work-failed";

export interface AuditInput {
  taskId?: string;
  projectId?: string;
  executionId?: string;
  workerId?: string;
  actor: string;
  tool: string;
  action: string;
  decision: "allowed" | "denied" | "pending" | "recorded";
  target?: string;
  details?: unknown;
  createdAt: number;
}

export interface ToolContext {
  workspaceRoot: string;
  actor: string;
  taskId?: string;
  projectId?: string;
  executionId?: string;
  workerId?: string;
  audit?: (entry: AuditInput) => Promise<void> | void;
  /** Agent role ("researcher", "cto", "frontend", …) — the permission broker reads this. */
  agentRole?: string;
  /** D11: runs a past-work search for a project (the worker binds it to the Convex API). */
  searchPastWork?: PastWorkSearchFn;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  reason?: string;
  data?: T;
}

export type FileToolName = "read_file" | "write_file" | "delete_file";
export type CommandToolName = "run_command";
export type GitHubToolName =
  | "github_list_repos"
  | "github_get_repo"
  | "github_list_issues"
  | "github_create_issue"
  | "github_list_prs"
  | "github_get_pr"
  | "github_create_pr"
  | "github_review_pr"
  | "github_search_code"
  | "github_get_file"
  | "github_create_file"
  | "github_update_file";

export interface FileToolArgs {
  path: string;
  content?: string;
}

export interface CommandToolArgs {
  command: string;
  args: string[];
  timeoutMs?: number;
  url?: string;
}

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

const SENSITIVE_PATTERNS = [
  /^sk-[A-Za-z0-9_-]{8,}$/i,
  /^ghp_[A-Za-z0-9_]{8,}$/i,
  /^github_pat_[A-Za-z0-9_]{8,}$/i,
  /^xox[bpas]-[A-Za-z0-9-]{8,}$/i,
  /^AKIA[A-Z0-9]{16}$/i,
  /^-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i,
];

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.map(redact);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(key, entry);
    }
    return result;
  }
  if (typeof value === "string" && looksSensitive(value)) {
    return "[REDACTED]";
  }
  return value;
}

function redactValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) {
    if (value === undefined || value === null || value === "") return value;
    return "[REDACTED]";
  }
  return redact(value);
}

function isSensitiveKey(key: string): boolean {
  return /(api[-_]?key|secret|password|passwd|pwd|token|authorization|auth|credential)/i.test(key);
}

function looksSensitive(value: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value));
}

export function maskSecrets(value: unknown): unknown {
  return redact(value);
}

export function maskStringSecrets(value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, "gi"), "[REDACTED]");
  }
  return result;
}

export function redactAuditDetails(details: unknown): unknown {
  if (details === undefined || details === null) return details;
  const masked = redact(details);
  if (typeof masked === "object") {
    const record = masked as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [key] of Object.entries(record)) {
      if (key === "content" || key === "newContent" || key === "oldContent" || key === "diff" || key === "output") {
        continue;
      }
      safe[key] = record[key];
    }
    return safe;
  }
  return masked;
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "[::]" ||
    host === "::1" ||
    host === "::"
  ) {
    return true;
  }
  if (/^(127|10|0)\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe8[0-9a-f]:/i.test(host)) return true;
  if (/^fe9[0-9a-f]:/i.test(host)) return true;
  if (/^fea[0-9a-f]:/i.test(host)) return true;
  if (/^feb[0-9a-f]:/i.test(host)) return true;
  if (host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.") || host.startsWith("::ffff:192.168.")) return true;
  return false;
}

export function isAllowedEgressUrl(url: string, allowPrivate = false): { ok: true; url: string } | { ok: false; reason: typeof REASON_NETWORK_URL_INVALID | typeof REASON_NETWORK_PRIVATE_TARGET } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: REASON_NETWORK_URL_INVALID };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: REASON_NETWORK_URL_INVALID };
  }
  if (!allowPrivate && isPrivateHostname(parsed.hostname)) {
    return { ok: false, reason: REASON_NETWORK_PRIVATE_TARGET };
  }
  return { ok: true, url: parsed.toString() };
}

export function validateFilePath(filePath: string): { ok: true } | { ok: false; reason: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  if (SENSITIVE_BASENAMES.has(last) || /(^|\/)\.env(\.|$)/i.test(normalized)) {
    return { ok: false, reason: REASON_FILE_PATH_FORBIDDEN };
  }
  if (/(^|\/)\.git(\/|$)/i.test(normalized) || /(^|\/)node_modules(\/|$)/i.test(normalized)) {
    return { ok: false, reason: REASON_FILE_PATH_FORBIDDEN };
  }
  // SSH / crypto material (Plan 009): no .ssh/.gnupg directories and no
  // PEM key files — protects native tools and MCP tool calls alike.
  if (/(^|\/)\.(?:ssh|gnupg)(\/|$)/i.test(normalized)) {
    return { ok: false, reason: REASON_FILE_PATH_FORBIDDEN };
  }
  if (/\.pem$/i.test(last) || segments.some((segment) => ["id_rsa", "id_ed25519", "id_ecdsa"].includes(segment))) {
    return { ok: false, reason: REASON_FILE_PATH_FORBIDDEN };
  }
  return { ok: true };
}

export function validateCommand(command: string): { ok: true } | { ok: false; reason: string } {
  if (!command.trim()) return { ok: false, reason: REASON_TOOL_ARGS_INVALID };
  if (/[\u0000-\u001f]/.test(command)) return { ok: false, reason: REASON_COMMAND_CONTROL_CHARS };
  return { ok: true };
}

export async function audit(
  context: ToolContext,
  entry: Omit<AuditInput, "createdAt" | "workerId" | "taskId" | "projectId" | "executionId" | "actor"> & { preRedactDetails?: unknown; actor?: string }
): Promise<void> {
  const action = entry.action;
  const actor = entry.actor ?? context.actor;
  const auditEntry: AuditInput = {
    taskId: context.taskId,
    projectId: context.projectId,
    executionId: context.executionId,
    workerId: context.workerId,
    actor,
    tool: entry.tool,
    action,
    decision: entry.decision,
    target: entry.target ? maskStringSecrets(entry.target) : undefined,
    details: redactAuditDetails(entry.preRedactDetails ?? entry.details),
    createdAt: Date.now(),
  };
  if (!context.audit) return;
  await context.audit(auditEntry);
}

export async function runGovernedFileTool(
  context: ToolContext,
  tool: FileToolName,
  args: FileToolArgs
): Promise<ToolResult> {
  const action = tool === "write_file" ? "write" : tool === "delete_file" ? "delete" : "read";
  if (tool !== "read_file" && tool !== "write_file" && tool !== "delete_file") {
    await audit(context, { tool, action, decision: "denied", target: args.path, details: { reason: REASON_TOOL_UNKNOWN } });
    return { ok: false, reason: REASON_TOOL_UNKNOWN };
  }
  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    return { ok: false, reason: REASON_TOOL_ARGS_INVALID };
  }
  const validation = validateFilePath(args.path);
  if (!validation.ok) {
    await audit(context, { tool, action, decision: "denied", target: args.path, details: { reason: validation.reason } });
    return { ok: false, reason: validation.reason };
  }
  await audit(context, {
    tool,
    action,
    decision: "allowed",
    target: args.path,
    details: { dryRun: action === "read" ? false : true },
  });
  return { ok: true, reason: "dry-run" };
}

export async function runGovernedCommandTool(
  context: ToolContext,
  args: CommandToolArgs,
  policy: { allowPrivateEgress?: boolean } = {}
): Promise<ToolResult> {
  const cmdValidation = validateCommand(args.command);
  if (!cmdValidation.ok) {
    await audit(context, { tool: "run_command", action: "run", decision: "denied", target: args.command, details: { reason: cmdValidation.reason } });
    return { ok: false, reason: cmdValidation.reason };
  }
  if (args.url) {
    const egress = isAllowedEgressUrl(args.url, policy.allowPrivateEgress ?? false);
    if (!egress.ok) {
      await audit(context, { tool: "run_command", action: "run", decision: "denied", target: args.url, details: { reason: egress.reason } });
      return { ok: false, reason: egress.reason };
    }
  }
  await audit(context, {
    tool: "run_command",
    action: "run",
    decision: "allowed",
    target: args.command,
    details: { args: args.args, dryRun: true },
  });
  return { ok: true, reason: "dry-run" };
}

export interface GitHubToolArgs {
  owner?: string;
  repo?: string;
  path?: string;
  query?: string;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  pullNumber?: number;
  sha?: string;
  ref?: string;
  branch?: string;
  labels?: string[];
  review?: { body?: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" };
  state?: "open" | "closed" | "all";
}

export async function runGovernedGitHubTool(
  context: ToolContext,
  tool: GitHubToolName,
  args: GitHubToolArgs
): Promise<ToolResult> {
  const actionMap: Record<GitHubToolName, string> = {
    github_list_repos: "list_repos",
    github_get_repo: "get_repo",
    github_list_issues: "list_issues",
    github_create_issue: "create_issue",
    github_list_prs: "list_prs",
    github_get_pr: "get_pr",
    github_create_pr: "create_pr",
    github_review_pr: "review_pr",
    github_search_code: "search_code",
    github_get_file: "get_file",
    github_create_file: "create_file",
    github_update_file: "update_file",
  };

  const action = actionMap[tool];
  const target = args.repo ? `${args.owner}/${args.repo}` : undefined;

  // Log the tool call
  await audit(context, {
    tool: "github",
    action,
    decision: "allowed",
    target,
    details: {
      tool,
      args: {
        owner: args.owner,
        repo: args.repo,
        path: args.path,
        title: args.title,
        pullNumber: args.pullNumber,
      },
    },
  });

  return { ok: true };
}

/** D11: one past-work search, always for the given project. */
export type PastWorkSearchFn = (input: {
  projectId: string;
  query: string;
  limit?: number;
  excludeTaskId?: string;
}) => Promise<PastWorkSearchResult>;

export interface PastWorkToolArgs {
  query?: unknown;
  limit?: unknown;
}

/**
 * D11 `search_past_work`: earlier tasks, task results and messages of the
 * caller's project. The project comes from the tool context, never from the
 * arguments, so a model cannot reach another project's work; the result is
 * fenced as untrusted text and ends with a cap note when the limit was hit.
 */
export async function runGovernedPastWorkSearch(
  context: ToolContext,
  args: PastWorkToolArgs,
  search: PastWorkSearchFn | undefined = context.searchPastWork
): Promise<ToolResult<string>> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const target = maskStringSecrets(query.slice(0, 200));
  if (!context.projectId || !search) {
    await audit(context, { tool: PAST_WORK_TOOL, action: "search", decision: "denied", target, details: { reason: REASON_PAST_WORK_NO_PROJECT } });
    return { ok: false, reason: REASON_PAST_WORK_NO_PROJECT };
  }
  if (!query) return { ok: false, reason: REASON_TOOL_ARGS_INVALID };
  const limit = clampPastWorkLimit(args.limit);
  await audit(context, { tool: PAST_WORK_TOOL, action: "search", decision: "allowed", target, details: { limit } });
  try {
    const result = await search({
      projectId: context.projectId,
      query,
      limit,
      ...(context.taskId ? { excludeTaskId: context.taskId } : {}),
    });
    return { ok: true, data: maskStringSecrets(formatPastWorkResult(result)) };
  } catch {
    return { ok: false, reason: REASON_PAST_WORK_FAILED };
  }
}
