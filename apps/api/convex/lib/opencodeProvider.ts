/**
 * Plan 038: OpenCode as a provider in Settings → LLM & Models.
 *
 * The OpenCode CLI is not an HTTP provider: it runs on the worker machine
 * with its own credentials and its own tools. It is stored as a special
 * `llmProviders` row (`provider: "opencode"`, no base URL, no key) so its
 * models take positions in the same ordered model list as the HTTP models.
 *
 * Semantics of an OpenCode entry in the order:
 *  - tasks/subtasks (the worker): selected by the order (fallback or round
 *    robin) = the subtask runs on the native OpenCode runtime with that
 *    model. When the CLI is not detected, the provider is disabled, or the
 *    task has no worktree isolation, the worker skips the entry and takes
 *    the next one.
 *  - chat and every other backend LLM call: OpenCode entries are skipped,
 *    because the backend cannot run the CLI.
 *
 * Pure module (no Convex import): the backend pool loader, backend chat and
 * the worker resolver share it.
 */

/** `llmProviders.provider` (and `presetId`) of the OpenCode row. */
export const OPENCODE_PROVIDER = "opencode";

/** Display name of the OpenCode row. */
export const OPENCODE_PROVIDER_NAME = "OpenCode";

/**
 * Install hint shown when the CLI is not detected. Taken from the repo
 * README (the integration targets opencode-ai 1.x, `opencode run`).
 */
export const OPENCODE_INSTALL_COMMAND = "npm i -g opencode-ai";

/** True for the OpenCode row (never an HTTP connection). */
export function isOpencodeConnection(connection: { provider?: string | null } | null | undefined): boolean {
  return (connection?.provider ?? "").trim().toLowerCase() === OPENCODE_PROVIDER;
}

// ── Plan 066: the native-CLI provider family ────────────────────────────

/**
 * The native-CLI pseudo-providers: task-execution CLIs that run on the
 * worker machine with their own credentials. They share the OpenCode row
 * semantics — entries run tasks only, chat never sees them — while only
 * `opencode` routes tasks today (plan 066: Codex and Claude Code are
 * registry/UI siblings until the per-model routing plan lands).
 */
export const CLI_PROVIDERS = ["opencode", "codex", "claude-code"] as const;
export type NativeCli = (typeof CLI_PROVIDERS)[number];

export const CLI_PROVIDER_NAME: Record<NativeCli, string> = {
  opencode: OPENCODE_PROVIDER_NAME,
  codex: "Codex",
  "claude-code": "Claude Code",
};

/** True for any native-CLI row (never an HTTP connection). */
export function isNativeCliConnection(connection: { provider?: string | null } | null | undefined): boolean {
  return nativeCliOf(connection) !== null;
}

/** Which CLI a row belongs to, or null for an HTTP connection. */
export function nativeCliOf(connection: { provider?: string | null } | null | undefined): NativeCli | null {
  const provider = (connection?.provider ?? "").trim().toLowerCase();
  return (CLI_PROVIDERS as readonly string[]).includes(provider) ? (provider as NativeCli) : null;
}

/** Drop every native-CLI row from a pool (every caller that sends HTTP requests). */
export function withoutNativeCli<C extends { provider?: string | null }>(pool: readonly C[]): C[] {
  return pool.filter((connection) => !isNativeCliConnection(connection));
}

/**
 * A valid model id for one CLI row. OpenCode wants `provider/model`;
 * Codex and Claude Code take bare ids (any non-empty trimmed string —
 * custom proxies may serve arbitrary ids).
 */
export function isNativeCliModelId(cli: NativeCli, modelId: string): boolean {
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  if (cli === "opencode") return isOpencodeModelId(trimmed);
  return true;
}

/** A valid OpenCode model id: `provider/model`, no whitespace. */
export function isOpencodeModelId(modelId: string): boolean {
  return /^[A-Za-z0-9._-]+\/[^\s]+$/.test(modelId.trim());
}
