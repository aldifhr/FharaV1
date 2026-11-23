/**
 * Plan 066: native CLI model sources shown in Settings > LLM & Models.
 * These CLIs use their own task credentials and are excluded from chat pools.
 * Codex models come from its local account-aware app-server catalog; these
 * presets are the fallback until the worker reports. Claude Code keeps
 * suggestions plus free-typed ids because it does not expose a model catalog.
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
  opencode: null,
  codex: CODEX_MODEL_PRESETS,
  "claude-code": CLAUDE_MODEL_PRESETS,
};
