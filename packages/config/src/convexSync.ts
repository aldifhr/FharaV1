/**
 * The vars `npm run env:sync` (scripts/env.mjs CONVEX_KEYS) pushes from the
 * root .env to the Convex deployment. E2 keeps today's 18 names exactly
 * (a test pins env.mjs to this list).
 *
 * TODO B4 (D9): add the Convex-read vars that are missing here
 * (FHARA_WORKTREE_RETENTION_HOURS, FHARA_SNAPSHOT_RETENTION_DAYS,
 * CHAT_REPLY_STALE_MS, TASK_WATCHDOG_STUCK_MS, CONTEXT_SNAPSHOTS,
 * FHARA_GIT_AUTHOR_NAME/EMAIL) — a behaviour change, shipped on its own.
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
] as const;
