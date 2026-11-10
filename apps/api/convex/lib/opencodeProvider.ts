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

/** Drop the OpenCode row from a pool (every caller that sends HTTP requests). */
export function withoutOpencode<C extends { provider?: string | null }>(pool: readonly C[]): C[] {
  return pool.filter((connection) => !isOpencodeConnection(connection));
}

/** A valid OpenCode model id: `provider/model`, no whitespace. */
export function isOpencodeModelId(modelId: string): boolean {
  return /^[A-Za-z0-9._-]+\/[^\s]+$/.test(modelId.trim());
}
