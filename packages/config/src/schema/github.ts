import type { EnvVar } from "./types";

// Convex readers; E2 moves them onto cenv() and re-verifies each dialect.
export const GITHUB_VARS = [
  {
    name: "GITHUB_CLIENT_ID",
    type: "string",
    parse: "nullish",
    default: "",
    runtimes: ["convex", "scripts"],
    group: "github",
    doc: "GitHub OAuth app client id.",
  },
  {
    name: "GITHUB_CLIENT_SECRET",
    type: "string",
    parse: "nullish",
    default: "",
    runtimes: ["convex", "scripts"],
    group: "github",
    doc: "GitHub OAuth app client secret.",
    secret: true,
  },
  {
    name: "GITHUB_OAUTH_CALLBACK_URL",
    type: "url",
    parse: "nullish",
    runtimes: ["convex"],
    group: "github",
    doc: "OAuth callback URL (default http://localhost:3000/api/integrations/github/callback).",
  },
  {
    name: "GITHUB_WEBHOOK_SECRET",
    type: "string",
    parse: "trimOr",
    runtimes: ["convex"],
    group: "github",
    doc: "Fallback webhook secret; without one webhooks answer 401.",
    secret: true,
  },
  {
    name: "OAUTH_STATE_SECRET",
    type: "string",
    parse: "trimOr",
    runtimes: ["convex"],
    group: "github",
    doc: "HMAC secret for OAuth state; falls back to PROVIDER_ENCRYPTION_KEY.",
    secret: true,
  },
  {
    name: "APP_ORIGIN",
    type: "url",
    parse: "nullish",
    runtimes: ["convex"],
    group: "github",
    doc: "Web app origin; defaults to the origin of GITHUB_OAUTH_CALLBACK_URL.",
  },
] as const satisfies readonly EnvVar[];

export const USAGE_VARS = [
  {
    name: "MOAGENT_WEEKLY_TOKEN_BUDGET",
    type: "int",
    parse: "atLeast",
    positive: true,
    floor: true,
    default: 0,
    runtimes: ["convex"],
    group: "usage",
    doc: "Weekly token budget for the usage meter; unset = meter off.",
  },
] as const satisfies readonly EnvVar[];
