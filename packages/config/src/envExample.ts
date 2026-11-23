/**
 * The root .env.example and apps/api/.env.example, rendered from the schema
 * (`npm run env:example`; a guard test fails when a committed copy is stale).
 * Defaults, options, secret flags and the FharaRuntime sync list come from the
 * schema, so the docs cannot drift from the code again.
 */
import { FHARA_NOT_SYNCED, FHARA_SYNC_KEYS } from "./runtimeSync";
import { ENV_SCHEMA } from "./schema";
import type { EnvGroup, EnvVar, Runtime } from "./schema/types";

interface Section {
  group: EnvGroup;
  title: string;
  intro?: readonly string[];
}

/** Section order and the prose that is about a group rather than one var. */
export const ENV_SECTIONS: readonly Section[] = [
  {
    group: "core",
    title: "Required",
    intro: ["The FharaRuntime deployment and the service token the worker, FharaRuntime and the web server share."],
  },
  {
    group: "llm",
    title: "LLM fallback",
    intro: [
      "Optional when a provider is configured in Settings → LLM. Used by the worker and by",
      "FharaRuntime (chat, prompt enhance) when no provider row applies.",
    ],
  },
  {
    group: "github",
    title: "GitHub OAuth and webhooks (FharaRuntime)",
    intro: [
      "GitHub OAuth app for push / draft PRs, the signed OAuth state, and the fallback",
      "webhook secret (per-project secrets from Integrations win; none = webhooks 401).",
      "The GitHub token is stored encrypted, so connecting GitHub needs PROVIDER_ENCRYPTION_KEY.",
    ],
  },
  { group: "usage", title: "Usage meter (FharaRuntime)" },
  {
    group: "web",
    title: "Web server exposure",
    intro: [
      "The web UI's /api routes have no login. `npm run dev` / `start` bind to 127.0.0.1, and",
      "/api/* only answers requests whose Host is localhost/127.0.0.1/[::1] and (for writes)",
      "whose Origin is the UI itself.",
    ],
  },
  { group: "worker", title: "Worker process" },
  {
    group: "policy",
    title: "Task limits and orchestration (worker)",
    intro: [
      "With ORCHESTRATOR_WORKTREE_ISOLATION on, up to ORCHESTRATOR_PARALLEL_DEFAULT non-conflicting",
      "subtasks run side by side; without it the default is 1. auto (the default) turns it on per task",
      "when the project is a clean git checkout with a commit and the backend shares the worker's disk;",
      "otherwise the task runs one step at a time. Agent Reach (read-only public web):",
      "  uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip",
    ],
  },
  {
    group: "exec",
    title: "Execution runtime (OpenCode) and child processes",
    intro: [
      "OpenCode CLI: npm i -g opencode-ai. Child processes (OpenCode, run_command, QA dev servers,",
      "verification, MCP stdio servers, git) get an allowlisted env only (PATH, HOME, LANG/LC_*, TERM,",
      "TMPDIR, NODE_ENV, CI, proxy/CA vars); worker secrets are never forwarded.",
    ],
  },
  { group: "git", title: "Source control, pull requests and auto-merge" },
  {
    group: "qa",
    title: "Browser QA",
    intro: ["Install Chromium once: cd packages/worker && npx playwright install chromium"],
  },
  { group: "snapshots", title: "Context snapshots" },
  { group: "threads", title: "Chat and task watchdogs (FharaRuntime)" },
  { group: "workspace", title: "Workspaces" },
  { group: "electron", title: "Electron shell (npm run electron:dev)" },
  { group: "scripts", title: "Scripts (supervise, smoke:push, catalog:build)" },
];

/** FharaRuntime CLI target vars: not Fhara config, read by `npx runtime` from apps/api/.env.local or the env. */
export const FHARA_CLI_TARGET_VARS = ["FHARA_DEPLOYMENT", "FHARA_BACKEND_URL", "FHARA_ADMIN_KEY"] as const;

const RUNTIME_LABEL: Record<Runtime, string> = {
  worker: "worker",
  runtime: "FharaRuntime",
  runtimeNode: "FharaRuntime",
  webServer: "web",
  webClient: "web",
  electron: "electron",
  scripts: "scripts",
};

const GENERATE: Readonly<Record<string, string>> = {
  FHARA_SERVICE_TOKEN: "openssl rand -hex 32",
  OAUTH_STATE_SECRET: "openssl rand -hex 32",
  GITHUB_WEBHOOK_SECRET: "openssl rand -hex 32",
};

const isFharaRuntime = (r: Runtime) => r === "runtime" || r === "runtimeNode";

function readers(def: EnvVar): string {
  return [...new Set(def.runtimes.map((r) => RUNTIME_LABEL[r]))].join(", ");
}

/** The value written after `NAME=`. Bools as 1/0, derived or non-finite defaults blank. */
export function exampleValue(def: EnvVar): string {
  if (def.type === "tristate") return def.exampleValue ?? "";
  if (!("default" in def)) return "";
  const value = def.default as unknown;
  if (value === undefined || typeof value === "function") return "";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value);
}

function notes(def: EnvVar, sync: ReadonlySet<string>): string[] {
  const out: string[] = [`read by: ${readers(def)}`];
  if ("options" in def && def.type === "enum") out.push(`one of: ${def.options.join(" | ")}`);
  if (def.knob) out.push("also set in Settings (overrides this file)");
  if (sync.has(def.name)) out.push("synced to FharaRuntime by npm run dev");
  else if (def.runtimes.some(isFharaRuntime) && !def.runtimeSystem) {
    out.push(`not synced to FharaRuntime: ${FHARA_NOT_SYNCED[def.name] ?? "set it with npx runtime env set"}`);
  }
  if (def.runtimeSystem) out.push("set by FharaRuntime itself; on the web side derived from FHARA_BACKEND_URL");
  if (def.aliases?.length) out.push(`legacy name${def.aliases.length > 1 ? "s" : ""} ${def.aliases.join(", ")} still read`);
  if (def.secret) out.push(GENERATE[def.name] ? `secret, generate: ${GENERATE[def.name]}` : "secret");
  if (def.type === "base64key32") out.push("base64 of 32 bytes: openssl rand -base64 32");
  return out;
}

function isRequired(def: EnvVar): boolean {
  return Boolean(def.required?.length);
}

const HEADER = [
  "# Fhara — one .env for the whole repo. Copy this file to .env in the repo root:",
  "#   cp .env.example .env   then run `npm run doctor`.",
  "#",
  "# - worker: loads the root .env at startup.",
  "# - web: vite.config.mts loads it (apps/web/.env.local still works as an override).",
  "# - FharaRuntime functions cannot read files: `npm run dev` (or `npm run env:sync`) copies the",
  "#   keys marked \"synced to FharaRuntime\" to the deployment env, only when a value changed.",
  "# - The FharaRuntime CLI target (FHARA_DEPLOYMENT / FHARA_SELF_HOSTED_*) lives in",
  "#   apps/api/.env.local; see apps/api/.env.example.",
  "#",
  "# GENERATED from packages/config/src/schema by `npm run env:example`; edit the schema,",
  "# not this file. Commented lines show the default; uncommented lines must be filled in.",
];

function sectionRule(title: string): string {
  const head = `# --- ${title} `;
  return head + "-".repeat(Math.max(3, 78 - head.length));
}

export function renderEnvExample(): string {
  const sync = new Set<string>(FHARA_SYNC_KEYS);
  const all = ENV_SCHEMA as readonly EnvVar[];
  const lines: string[] = [...HEADER];
  for (const section of ENV_SECTIONS) {
    const vars = all.filter((def) => def.group === section.group && !def.deprecated);
    if (vars.length === 0) continue;
    lines.push("", sectionRule(section.title));
    for (const line of section.intro ?? []) lines.push(`# ${line}`);
    for (const def of vars) {
      lines.push("", `# ${def.doc}`, `#   (${notes(def, sync).join("; ")})`);
      lines.push(isRequired(def) ? `${def.name}=` : `# ${def.name}=${exampleValue(def)}`);
    }
  }
  const legacy = all.filter((def) => def.deprecated);
  if (legacy.length) {
    lines.push("", sectionRule("Legacy names (still read, do not use in new setups)"));
    for (const def of legacy) lines.push(`# ${def.name}: ${def.deprecated}`);
  }
  const missing = all.filter((def) => !ENV_SECTIONS.some((s) => s.group === def.group));
  if (missing.length) throw new Error(`.env.example: no section for ${missing.map((d) => d.group).join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export function renderApiEnvExample(): string {
  return [
    "# FharaRuntime CLI target — copy to apps/api/.env.local (the FharaRuntime CLI reads it from this folder).",
    "# Everything else lives in the root .env (see ../../.env.example); `npm run dev` / `npm run",
    "# env:sync` copies the keys FharaRuntime functions read to the deployment env.",
    "#",
    "# GENERATED by `npm run env:example` (packages/config/src/envExample.ts).",
    "",
    "# FharaRuntime cloud: `npx runtime dev` writes FHARA_DEPLOYMENT (and FHARA_BACKEND_URL) here.",
    "# FHARA_DEPLOYMENT=",
    "",
    "# Self-hosted / local backend instead:",
    "# FHARA_BACKEND_URL=http://127.0.0.1:3210",
    "# FHARA_ADMIN_KEY=",
    "",
  ].join("\n");
}
