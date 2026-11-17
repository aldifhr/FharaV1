/**
 * Plan 066: the native-CLI model sources shown in Settings → LLM & Models.
 * These CLIs run tasks with their own credentials (never chat), so their
 * entries are excluded from every chat pool by the backend family check.
 * The catalogs are preset suggestions plus free-typed ids — the CLIs have
 * no model-list commands, and custom proxies may serve arbitrary ids.
 */

export type TaskCli = "opencode" | "codex" | "claude-code";

export const TASK_CLI_LABEL: Record<TaskCli, string> = {
  opencode: "OpenCode",
  codex: "Codex",
  "claude-code": "Claude Code",
};

export const CODEX_MODEL_PRESETS = ["gpt-5.1-codex", "gpt-5-codex", "gpt-5.1", "o4-mini"];
export const CLAUDE_MODEL_PRESETS = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"];

export const CLI_MODEL_PRESETS: Record<TaskCli, string[] | null> = {
  opencode: null, // real catalog from the worker's `opencode models`.
  codex: CODEX_MODEL_PRESETS,
  "claude-code": CLAUDE_MODEL_PRESETS,
};
