/**
 * Secret env names, one source for the redactor, the child-env block list
 * and the apiKeyEnv denylist. Members and order equal today's lists in
 * apps/api/convex/lib/childEnv.ts (E1 changes no behaviour).
 */
import { ENV_SCHEMA } from "./schema";
import type { EnvVar } from "./schema/types";

/** Every schema var flagged secret: true. */
export const SCHEMA_SECRET_NAMES: readonly string[] = (ENV_SCHEMA as readonly EnvVar[])
  .filter((def) => def.secret)
  .map((def) => def.name);

/** Control-plane secrets that are not Fhara config vars but must never reach a child. */
export const EXTRA_PLATFORM_SECRETS = [
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_ADMIN_KEY",
  "CONVEX_DEPLOY_KEY",
  "AUTH_GITHUB_SECRET",
  "JWT_PRIVATE_KEY",
] as const;

/**
 * Never forwarded to a child, not even through passthrough (childEnv
 * WORKER_SECRET_ENV_KEYS). Same members and order as before E1, plus
 * FHARA_MCP_TOKEN (G12a) and FHARA_MCP_WEBHOOK_SECRET (G12b) at the end.
 */
export const PLATFORM_SECRET_ENV_NAMES: readonly string[] = [
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
  // GOAT G12a: the Fhara MCP bearer token. A child agent never inherits it;
  // G12b hands it out on purpose where a run may call back.
  "FHARA_MCP_TOKEN",
  // GOAT G12b: the completion webhook's signing key.
  "FHARA_MCP_WEBHOOK_SECRET",
];

/** Provider keys and tokens outside the schema that the child env drops by default. */
export const KNOWN_PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

/** Names that would let a child escape the scrubbed env (not secrets, but denied the same way). */
export const CHILD_ENV_ESCAPE_NAMES = ["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"] as const;

/**
 * Dropped from the parent env by default; an operator may opt in through
 * passthrough (childEnv DEFAULT_DENIED_SECRET_ENV_KEYS). Same members and
 * order as before E1.
 */
export const DEFAULT_DENIED_SECRET_ENV_NAMES: readonly string[] = [
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

/** Every secret name Fhara knows: schema secrets, platform extras and provider keys. */
export const SECRET_ENV_NAMES: readonly string[] = Array.from(
  new Set<string>([...SCHEMA_SECRET_NAMES, ...EXTRA_PLATFORM_SECRETS, ...KNOWN_PROVIDER_KEYS])
);

/** Current values of every known secret in an env (for value-based redaction). */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) out.push(value);
  }
  return out;
}
