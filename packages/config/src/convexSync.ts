/**
 * The vars `npm run env:sync` (scripts/env.mjs CONVEX_KEYS, through the
 * manifest) pushes from the root .env to the Convex deployment.
 * B4 (D9) added the seven Convex-read vars that setting in .env used to
 * leave without effect (from FHARA_WORKTREE_RETENTION_HOURS on).
 * CONVEX_NOT_SYNCED lists every other var Convex reads, with the reason.
 */
export const CONVEX_SYNC_KEYS = [
  "CONVEX_SERVICE_TOKEN",
  "PROVIDER_ENCRYPTION_KEY",
  "PROVIDER_ENCRYPTION_KEY_OLD",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_BASE_URL",
  "LLM_OPENAI_BASE_URL",
  "LLM_ANTHROPIC_BASE_URL",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_OAUTH_CALLBACK_URL",
  "GITHUB_WEBHOOK_SECRET",
  "OAUTH_STATE_SECRET",
  "APP_ORIGIN",
  "MOAGENT_WEEKLY_TOKEN_BUDGET",
  "FHARA_PR_FIX_MAX_ATTEMPTS",
  // B4
  "FHARA_WORKTREE_RETENTION_HOURS",
  "FHARA_SNAPSHOT_RETENTION_DAYS",
  "CHAT_REPLY_STALE_MS",
  "CHAT_LLM_IDLE_TIMEOUT_MS",
  "CHAT_LLM_STREAM_MAX_MS",
  "TASK_WATCHDOG_STUCK_MS",
  "CONTEXT_SNAPSHOTS",
  "FHARA_GIT_AUTHOR_NAME",
  "FHARA_GIT_AUTHOR_EMAIL",
  // L4: the per-role model override, read by chat and the Reviewer as well as the worker.
  "FHARA_LLM_ROLE_OVERRIDE",
] as const;

/** Convex-read vars deliberately left out of env:sync, each with its reason. */
export const CONVEX_NOT_SYNCED: Readonly<Record<string, string>> = {
  CONVEX_SITE_URL: "a Convex system var, set by the deployment itself",
  FHARA_AUTO_MERGE_MAX_LINES: "a Settings knob read by Convex; the stored value is the normal path",
  FHARA_AUTO_MERGE_SENSITIVE: "a Settings knob read by Convex; the stored value is the normal path",
  FHARA_AUTO_MERGE_METHOD: "a Settings knob read by Convex; the stored value is the normal path",
  FHARA_CHILD_ENV_PASSTHROUGH: "names worker-machine vars; a Convex node action has its own env",
  WORKSPACE_ROOT: "a path on the worker machine; the worker sends its absolute root with each Convex call that needs it",
  CONVEX_CLOUD_URL: "a Convex system var, set by the deployment itself (the fixtures guard reads it)",
  FHARA_FIXTURES: "dev-only opt-in for fixtures:seed / fixtures:wipe on a non-local deployment; set it by hand with npx convex env set",
};
