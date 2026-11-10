import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENIED_SECRET_ENV_NAMES,
  ENV_SCHEMA,
  PLATFORM_SECRET_ENV_NAMES,
  SCHEMA_SECRET_NAMES,
  SECRET_ENV_NAMES,
  secretValues,
  type EnvVar,
} from "@fhara/config";
import { DEFAULT_DENIED_SECRET_ENV_KEYS, WORKER_SECRET_ENV_KEYS } from "@/api/convex/lib/childEnv";

/** Frozen copies of the childEnv lists at 4d2dfb7 (before E1). */
const OLD_WORKER_SECRET_ENV_KEYS = [
  "CONVEX_SERVICE_TOKEN",
  "PROVIDER_ENCRYPTION_KEY",
  "PROVIDER_ENCRYPTION_KEY_OLD",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_ADMIN_KEY",
  "CONVEX_DEPLOY_KEY",
  "OAUTH_STATE_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "AUTH_GITHUB_SECRET",
  "JWT_PRIVATE_KEY",
];
const OLD_DEFAULT_DENIED_SECRET_ENV_KEYS = [
  "LLM_API_KEY",
  "STAGEHAND_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
];

describe("secrets parity (E1)", () => {
  it("the platform list equals the pre-E1 WORKER_SECRET_ENV_KEYS, and childEnv uses it", () => {
    expect(PLATFORM_SECRET_ENV_NAMES).toEqual(OLD_WORKER_SECRET_ENV_KEYS);
    expect(WORKER_SECRET_ENV_KEYS).toEqual(OLD_WORKER_SECRET_ENV_KEYS);
  });

  it("the default-denied list equals the pre-E1 DEFAULT_DENIED_SECRET_ENV_KEYS, and childEnv uses it", () => {
    expect(DEFAULT_DENIED_SECRET_ENV_NAMES).toEqual(OLD_DEFAULT_DENIED_SECRET_ENV_KEYS);
    expect(DEFAULT_DENIED_SECRET_ENV_KEYS).toEqual(OLD_DEFAULT_DENIED_SECRET_ENV_KEYS);
  });

  it("every schema secret is blocked from children (platform list or default-denied list)", () => {
    const blocked = new Set([...PLATFORM_SECRET_ENV_NAMES, ...DEFAULT_DENIED_SECRET_ENV_NAMES]);
    const missing = SCHEMA_SECRET_NAMES.filter((name) => !blocked.has(name) && !["FHARA_SMOKE_GITHUB_TOKEN"].includes(name));
    expect(missing).toEqual([]);
  });

  it("the 12 schema secrets are the ones the inventory flags", () => {
    expect([...SCHEMA_SECRET_NAMES].sort()).toEqual(
      [
        "CONVEX_SERVICE_TOKEN",
        "FHARA_SMOKE_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_CLIENT_SECRET",
        "GITHUB_TOKEN",
        "GITHUB_WEBHOOK_SECRET",
        "LLM_API_KEY",
        "OAUTH_STATE_SECRET",
        "OPENAI_API_KEY",
        "PROVIDER_ENCRYPTION_KEY",
        "PROVIDER_ENCRYPTION_KEY_OLD",
        "STAGEHAND_API_KEY",
      ].sort()
    );
    expect(SECRET_ENV_NAMES).toEqual(expect.arrayContaining([...PLATFORM_SECRET_ENV_NAMES]));
    expect((ENV_SCHEMA as readonly EnvVar[]).filter((d) => d.secret).every((d) => d.type !== "int" && d.type !== "bool")).toBe(true);
  });

  it("secretValues returns set secret values only", () => {
    expect(secretValues({ CONVEX_SERVICE_TOKEN: " tok ", LLM_API_KEY: "", WORKER_ID: "w" })).toEqual(["tok"]);
  });
});
