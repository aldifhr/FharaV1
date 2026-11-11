import { afterEach, describe, expect, it } from "vitest";
import { schemaDefault, setEnvIssueSink } from "@fhara/config";
import { chatReplyStaleMs, DEFAULT_CHAT_REPLY_STALE_MS, MIN_CHAT_REPLY_STALE_MS } from "@/api/convex/lib/chat/replyLifecycle";
import { taskStuckMs, DEFAULT_TASK_STUCK_MS, MIN_TASK_STUCK_MS } from "@/api/convex/lib/taskWatchdog";
import { worktreeRetentionMs, DEFAULT_WORKTREE_RETENTION_HOURS } from "@/api/convex/lib/worktreeRetention";
import { fixMaxAttempts } from "@/api/convex/lib/prFeedback";
import { contextSnapshotsEnabled } from "@/api/convex/lib/contextSnapshot";
import { appOrigin, oauthStateSecret } from "@/api/convex/lib/oauthState";
import { getGlobalLLMConfig } from "@/api/convex/lib/llmConfig";
import * as path from "node:path";
import { b2Bool, b5GlobalLLMConfig } from "./legacyEnv";
import { resolveRepoPath } from "@/api/convex/lib/workspacePath";

/**
 * E2 parity: the Convex env readers moved onto @fhara/config/convex return
 * exactly what the pre-E2 code returned (frozen copies below, from 69dd058).
 */
type Env = Record<string, string | undefined>;

const RAW: readonly (string | undefined)[] = [
  undefined, "", " ", "0", "-5", "1", "0.5", "3", "7.9", "20", "21", "72", "720", "721", "abc", "10s", "1e3",
  "60000", "299999", "300000", "659999", "660000", "900000", "86400001", "Infinity", "NaN", "true", "false",
  "off", "no", "yes", " 1 ", "OFF",
];

// ── frozen pre-E2 copies ────────────────────────────────────────────────
function oldChatReplyStaleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 15 * 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 15 * 60_000;
  return Math.max(11 * 60_000, Math.floor(parsed));
}
function oldTaskStuckMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30 * 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 30 * 60_000;
  if (parsed <= 0) return 0;
  return Math.max(5 * 60_000, Math.floor(parsed));
}
function oldWorktreeRetentionMs(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  const hours = Number.isFinite(parsed) ? Math.min(720, Math.max(1, Math.floor(parsed))) : 72;
  return hours * 60 * 60 * 1000;
}
function oldFixMaxAttempts(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return 3;
  return Math.max(0, Math.min(20, Math.floor(n)));
}
// B2: the bool oracle follows the unified dialect.
function oldContextSnapshotsEnabled(env: Env): boolean {
  return b2Bool(env.CONTEXT_SNAPSHOTS, true);
}
function oldOauthStateSecret(env: Env): string | null {
  return env.OAUTH_STATE_SECRET?.trim() || env.PROVIDER_ENCRYPTION_KEY?.trim() || null;
}
function oldAppOrigin(env: Env): string {
  for (const raw of [env.APP_ORIGIN, env.GITHUB_OAUTH_CALLBACK_URL]) {
    if (!raw?.trim()) continue;
    try {
      const url = new URL(raw.trim());
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // next
    }
  }
  return "http://localhost:3000";
}
// B5: Convex and the worker share one fallback (openai-compatible → OpenAI defaults).
const oldGlobalLLMConfig = b5GlobalLLMConfig;

const NAMES = [
  "CHAT_REPLY_STALE_MS",
  "TASK_WATCHDOG_STUCK_MS",
  "FHARA_WORKTREE_RETENTION_HOURS",
  "FHARA_PR_FIX_MAX_ATTEMPTS",
  "CONTEXT_SNAPSHOTS",
  "OAUTH_STATE_SECRET",
  "PROVIDER_ENCRYPTION_KEY",
  "APP_ORIGIN",
  "GITHUB_OAUTH_CALLBACK_URL",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_BASE_URL",
  "LLM_OPENAI_BASE_URL",
  "LLM_ANTHROPIC_BASE_URL",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "WORKSPACE_ROOT",
];

function withProcessEnv<T>(env: Env, fn: () => T): T {
  const saved: Env = {};
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

afterEach(() => setEnvIssueSink(null));

describe("Convex reader parity (E2)", () => {
  it("pure readers equal the pre-E2 copies, explicit raw and from process.env", () => {
    setEnvIssueSink(() => {});
    const cases: Array<[string, (raw?: string) => unknown, (raw: string | undefined) => unknown]> = [
      ["CHAT_REPLY_STALE_MS", chatReplyStaleMs, oldChatReplyStaleMs],
      ["TASK_WATCHDOG_STUCK_MS", taskStuckMs, oldTaskStuckMs],
      ["FHARA_WORKTREE_RETENTION_HOURS", worktreeRetentionMs, oldWorktreeRetentionMs],
      ["FHARA_PR_FIX_MAX_ATTEMPTS", fixMaxAttempts, oldFixMaxAttempts],
    ];
    for (const [name, now, before] of cases) {
      for (const raw of RAW) {
        expect({ name, raw, v: now(raw) }).toEqual({ name, raw, v: before(raw) });
        withProcessEnv({ [name]: raw }, () => expect({ name, raw, env: now() }).toEqual({ name, raw, env: before(raw) }));
      }
    }
  });

  it("env-record readers equal the pre-E2 copies", () => {
    setEnvIssueSink(() => {});
    for (const raw of RAW) {
      expect(contextSnapshotsEnabled({ CONTEXT_SNAPSHOTS: raw })).toBe(oldContextSnapshotsEnabled({ CONTEXT_SNAPSHOTS: raw }));
      for (const other of [undefined, "", " k ", "key"]) {
        const env = { OAUTH_STATE_SECRET: raw, PROVIDER_ENCRYPTION_KEY: other };
        withProcessEnv(env, () => expect(oauthStateSecret()).toBe(oldOauthStateSecret(env)));
      }
      const ws = { WORKSPACE_ROOT: raw };
      const envRoot = ws.WORKSPACE_ROOT;
      const old = envRoot && envRoot.trim() ? path.resolve("/c", envRoot.trim(), "proj") : path.resolve("/c", "proj");
      expect(resolveRepoPath("proj", { cwd: "/c", env: ws })).toBe(old);
    }
    for (const app of [undefined, "", "  ", "nope", "ftp://x", "https://a.example/x", " http://b.local:3000/y "]) {
      for (const cb of [undefined, "", "http://c.local/cb", "garbage"]) {
        const env = { APP_ORIGIN: app, GITHUB_OAUTH_CALLBACK_URL: cb };
        withProcessEnv(env, () => expect(appOrigin()).toBe(oldAppOrigin(env)));
      }
    }
  });

  it("the Convex LLM fallback is the shared one (B5)", () => {
    const providers = [undefined, "", "anthropic", "OpenAI", "openai-compatible", "x"];
    for (const LLM_PROVIDER of providers) {
      for (const extra of [{}, { LLM_BASE_URL: "b" }, { LLM_OPENAI_BASE_URL: "o", LLM_ANTHROPIC_BASE_URL: "a" }, { LLM_MODEL: "" }, { OPENAI_API_KEY: "k" }, { LLM_API_KEY: "", OPENAI_API_KEY: "k" }]) {
        const env = { LLM_PROVIDER, ...extra };
        withProcessEnv(env, () => expect(getGlobalLLMConfig()).toEqual(oldGlobalLLMConfig(env)));
      }
    }
  });

  it("exported constants still equal the schema defaults", () => {
    expect(schemaDefault("CHAT_REPLY_STALE_MS")).toBe(DEFAULT_CHAT_REPLY_STALE_MS);
    expect(MIN_CHAT_REPLY_STALE_MS).toBe(11 * 60_000);
    expect(schemaDefault("TASK_WATCHDOG_STUCK_MS")).toBe(DEFAULT_TASK_STUCK_MS);
    expect(MIN_TASK_STUCK_MS).toBe(5 * 60_000);
    expect(schemaDefault("FHARA_WORKTREE_RETENTION_HOURS")).toBe(DEFAULT_WORKTREE_RETENTION_HOURS);
    expect(schemaDefault("FHARA_PR_FIX_MAX_ATTEMPTS")).toBe(3);
  });
});
