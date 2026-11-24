import type { EnvVar } from "./types";

// FharaRuntime readers; E2 moves them onto cenv() and re-verifies each dialect.
export const GITHUB_VARS = [
  {
    name: "GITHUB_WEBHOOK_SECRET",
    type: "string",
    parse: "trimOr",
    runtimes: ["runtime"],
    group: "github",
    doc: "Fallback webhook secret; without one webhooks answer 401.",
    secret: true,
  },
  {
    name: "APP_ORIGIN",
    type: "url",
    parse: "nullish",
    runtimes: ["runtime"],
    group: "github",
    doc: "Web app origin.",
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
    runtimes: ["runtime"],
    group: "usage",
    doc: "Weekly token budget for the usage meter; unset = meter off.",
  },
] as const satisfies readonly EnvVar[];
