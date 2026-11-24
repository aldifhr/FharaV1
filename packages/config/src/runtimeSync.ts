/**
 * The vars `npm run env:sync` (scripts/env.mjs FHARA_KEYS, through the
 * manifest) pushes from the root .env to the FharaRuntime deployment.
 * B4 (D9) added the seven FharaRuntime-read vars that setting in .env used to
 * leave without effect (from FHARA_WORKTREE_RETENTION_HOURS on).
 * FHARA_NOT_SYNCED lists every other var FharaRuntime reads, with the reason.
 */
export const FHARA_SYNC_KEYS = [
  "FHARA_SERVICE_TOKEN",
  "PROVIDER_ENCRYPTION_KEY",
  "PROVIDER_ENCRYPTION_KEY_OLD",
  "GITHUB_WEBHOOK_SECRET",
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

/** FharaRuntime-read vars deliberately left out of env:sync, each with its reason. */
export const FHARA_NOT_SYNCED: Readonly<Record<string, string>> = {
  FHARA_SITE_URL: "a FharaRuntime system var, set by the deployment itself",
  FHARA_AUTO_MERGE_MAX_LINES: "a Settings knob read by FharaRuntime; the stored value is the normal path",
  FHARA_AUTO_MERGE_SENSITIVE: "a Settings knob read by FharaRuntime; the stored value is the normal path",
  FHARA_AUTO_MERGE_METHOD: "a Settings knob read by FharaRuntime; the stored value is the normal path",
  FHARA_CHILD_ENV_PASSTHROUGH: "names worker-machine vars; a FharaRuntime node action has its own env",
  WORKSPACE_ROOT: "a path on the worker machine; the worker sends its absolute root with each FharaRuntime call that needs it",
  FHARA_BACKEND_URL: "a FharaRuntime system var, set by the deployment itself (the fixtures guard reads it)",
  FHARA_FIXTURES: "dev-only opt-in for fixtures:seed / fixtures:wipe on a non-local deployment; set it by hand with npx runtime env set",
};
