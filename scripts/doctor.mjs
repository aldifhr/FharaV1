#!/usr/bin/env node
/**
 * `npm run doctor` — checks a local Fhara setup and prints ✓ / ! / ✗ with a
 * fix hint per problem. Exits 1 when a REQUIRED check fails.
 *
 * Secrets are never printed: env checks report variable NAMES only, the LLM
 * check reports the HTTP status only, and the Convex env check compares the
 * worker token in memory.
 *
 * Env is read from process.env, then the repo's .env files (process.env wins):
 *   .env                 the one env file (worker; the web app loads it too)
 *   apps/web/.env.local  optional Next.js override
 *   apps/api/.env.local  Convex CLI (CONVEX_DEPLOYMENT or CONVEX_SELF_HOSTED_*)
 *
 * Which vars are required, their aliases and defaults come from
 * @fhara/config's generated env-manifest.json (npm run env:example).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { ENV_MANIFEST, envFlag, manifestVar, withAliases } from "./envManifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Required in the worker (schema `required`), e.g. NEXT_PUBLIC_CONVEX_URL, CONVEX_SERVICE_TOKEN. */
export const REQUIRED_WORKER_VARS = [...(ENV_MANIFEST.required.worker ?? [])];
export { manifestVar, withAliases };

// ---------------------------------------------------------------- pure parts

/** Minimal dotenv parser: KEY=value, quotes, `export`, comments. */
export function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[match[1]] = value;
  }
  return out;
}

/** Later sources lose to earlier ones; empty strings count as unset. */
export function mergeEnv(...sources) {
  const out = {};
  for (const source of sources.reverse()) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value !== undefined && value !== "") out[key] = value;
    }
  }
  return out;
}

export function parseVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  return { major, minor, patch };
}

/** Next.js 16 needs >= 20.9; the repo pins a recommended major in .nvmrc. */
export function checkNode(version, recommendedMajor) {
  const v = parseVersion(version);
  const ok = v.major > 20 || (v.major === 20 && v.minor >= 9);
  if (!ok) return { status: "fail", detail: `Node ${version}`, hint: `Install Node >= 20.9 (recommended ${recommendedMajor ?? "LTS"}: nvm use)` };
  if (recommendedMajor && v.major !== Number(recommendedMajor)) {
    return { status: "warn", detail: `Node ${version} (.nvmrc recommends ${recommendedMajor})`, hint: "nvm install && nvm use" };
  }
  return { status: "ok", detail: `Node ${version}` };
}

/** Names from `names` that are unset in env. */
export function missingVars(env, names) {
  return names.filter((name) => !env[name]);
}

/** `npx convex env list` prints NAME=value lines; keep a name → value map in memory only. */
export function parseConvexEnvList(text) {
  return parseDotenv(text);
}

/** GET /models request for an OpenAI-compatible or Anthropic endpoint. */
export function modelsRequest(env) {
  const provider = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  const anthropic = provider === "anthropic";
  const base = (env.LLM_BASE_URL ?? (anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")).replace(/\/+$/, "");
  const key = env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? "";
  const headers = anthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
  return { url: `${base}/models`, headers, hasKey: key.length > 0 };
}

const ICON = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

export function formatResult(result) {
  const head = `${ICON[result.status]} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`;
  return result.hint && result.status !== "ok" ? `${head}\n    → ${result.hint}` : head;
}

/** Exit code: 1 when any required check failed. Warnings never fail. */
export function exitCodeFor(results) {
  return results.some((r) => r.status === "fail" && r.required !== false) ? 1 : 0;
}

// ---------------------------------------------------------------- checks

function readEnvFile(relative) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) return null;
  return parseDotenv(fs.readFileSync(file, "utf-8"));
}

function onPath(command) {
  if (command.includes("/")) return fs.existsSync(command) ? command : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function fetchWithTimeout(url, init = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const files = {
    ".env": readEnvFile(".env"),
    "apps/web/.env.local": readEnvFile("apps/web/.env.local"),
    "apps/api/.env.local": readEnvFile("apps/api/.env.local"),
  };
  const env = mergeEnv(process.env, files[".env"], files["apps/web/.env.local"], files["apps/api/.env.local"]);
  const results = [];
  const add = (r) => {
    results.push(r);
    console.log(formatResult(r));
  };

  console.log("Fhara doctor\n");

  // Node
  const nvmrc = fs.existsSync(path.join(ROOT, ".nvmrc")) ? fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf-8").trim() : undefined;
  add({ name: "Node.js", ...checkNode(process.version, nvmrc) });

  // dependencies
  add(
    fs.existsSync(path.join(ROOT, "node_modules", "convex"))
      ? { name: "Dependencies", status: "ok", detail: "node_modules present" }
      : { name: "Dependencies", status: "fail", detail: "node_modules missing", hint: "npm install" },
  );

  // .env files
  add(
    files[".env"]
      ? { name: ".env", status: "ok", detail: "present" }
      : { name: ".env", status: "fail", detail: "missing", hint: "cp .env.example .env and fill it in" },
  );
  // The web app loads the root .env in next.config.mjs; apps/web/.env.local
  // is only an override (it wins over .env).
  const webEnv = mergeEnv(process.env, files["apps/web/.env.local"], files[".env"]);
  add(
    webEnv.CONVEX_SERVICE_TOKEN
      ? { name: "Web server token", status: "ok", detail: "CONVEX_SERVICE_TOKEN set for Next.js" }
      : {
          name: "Web server token",
          status: "warn",
          required: false,
          detail: "CONVEX_SERVICE_TOKEN not set for Next.js — Settings LLM/MCP writes and enhance are disabled",
          hint: "set CONVEX_SERVICE_TOKEN in .env",
        },
  );
  const convexCliTarget = env.CONVEX_DEPLOYMENT ? "cloud" : env.CONVEX_SELF_HOSTED_URL ? "self-hosted" : null;
  add(
    convexCliTarget
      ? { name: "Convex CLI target", status: "ok", detail: `${convexCliTarget} (${env.CONVEX_DEPLOYMENT ? "CONVEX_DEPLOYMENT" : "CONVEX_SELF_HOSTED_URL"})` }
      : {
          name: "Convex CLI target",
          status: "warn",
          required: false,
          detail: "neither CONVEX_DEPLOYMENT nor CONVEX_SELF_HOSTED_URL set",
          hint: "cd apps/api && npx convex dev (creates apps/api/.env.local), or see apps/api/.env.example for self-hosted",
        },
  );

  // required worker vars
  const convexUrl = withAliases(env, "NEXT_PUBLIC_CONVEX_URL");
  const resolved = Object.fromEntries(REQUIRED_WORKER_VARS.map((name) => [name, withAliases(env, name)]));
  const missingRequired = missingVars(resolved, REQUIRED_WORKER_VARS);
  add(
    missingRequired.length === 0
      ? { name: "Required env", status: "ok", detail: `${REQUIRED_WORKER_VARS.join(", ")} set` }
      : { name: "Required env", status: "fail", detail: `missing: ${missingRequired.join(", ")}`, hint: "set them in .env (see .env.example)" },
  );
  const optionalSet = ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "PROVIDER_ENCRYPTION_KEY", "WORKSPACE_ROOT"].filter((n) => env[n]);
  add({ name: "Optional env", status: "ok", detail: optionalSet.length ? `set: ${optionalSet.join(", ")}` : "none of LLM_*, PROVIDER_ENCRYPTION_KEY, WORKSPACE_ROOT set" });

  // LLM endpoint
  const llm = modelsRequest(env);
  if (!llm.hasKey) {
    add({
      name: "LLM endpoint",
      status: "warn",
      required: false,
      detail: "LLM_API_KEY not set in the worker env — skipped",
      hint: "add a provider in Settings → LLM, or set LLM_PROVIDER/LLM_BASE_URL/LLM_MODEL/LLM_API_KEY in .env",
    });
  } else {
    try {
      const res = await fetchWithTimeout(llm.url, { headers: llm.headers });
      add(
        res.ok
          ? { name: "LLM endpoint", status: "ok", detail: `GET /models → ${res.status}` }
          : { name: "LLM endpoint", status: "fail", detail: `GET /models → ${res.status}`, hint: res.status === 401 || res.status === 403 ? "check LLM_API_KEY" : "check LLM_BASE_URL / LLM_PROVIDER" },
      );
    } catch (err) {
      add({ name: "LLM endpoint", status: "fail", detail: `unreachable (${err.name === "AbortError" ? "timeout" : err.cause?.code ?? err.message})`, hint: "check LLM_BASE_URL and network/proxy" });
    }
  }

  // Convex
  let convexReachable = false;
  if (!convexUrl) {
    add({ name: "Convex backend", status: "fail", detail: "no URL", hint: "set NEXT_PUBLIC_CONVEX_URL" });
  } else {
    try {
      const res = await fetchWithTimeout(`${convexUrl.replace(/\/+$/, "")}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "agents:list", args: {}, format: "json" }),
      });
      const body = await res.json().catch(() => ({}));
      convexReachable = true;
      if (body.status === "success") {
        add({ name: "Convex backend", status: "ok", detail: `reachable, functions deployed (${Array.isArray(body.value) ? body.value.length : "?"} agents)` });
      } else if (/Could not find public function/i.test(body.errorMessage ?? "")) {
        add({ name: "Convex backend", status: "fail", detail: "reachable, functions NOT deployed", hint: "cd apps/api && npx convex dev --once (or npx convex deploy for self-hosted)" });
      } else {
        add({ name: "Convex backend", status: "ok", detail: `reachable, functions deployed (query answered ${res.status})` });
      }
    } catch (err) {
      add({ name: "Convex backend", status: "fail", detail: `unreachable (${err.name === "AbortError" ? "timeout" : err.cause?.code ?? err.message})`, hint: "start it: npm run dev (or cd apps/api && npx convex dev)" });
    }
  }

  // Convex deployment env (names only; token compared in memory)
  let convexEnv = null;
  if (convexReachable && convexCliTarget) {
    const out = spawnSync("npx", ["convex", "env", "list"], {
      cwd: path.join(ROOT, "apps/api"),
      env: { ...process.env, ...env },
      encoding: "utf-8",
      timeout: 30_000,
    });
    if (out.status === 0) convexEnv = parseConvexEnvList(out.stdout);
  }
  if (!convexEnv) {
    add({ name: "Worker service token", status: env.CONVEX_SERVICE_TOKEN ? "ok" : "fail", detail: env.CONVEX_SERVICE_TOKEN ? "set in worker env (Convex env not readable — not compared)" : "CONVEX_SERVICE_TOKEN missing", hint: "generate one (openssl rand -hex 32), put it in .env and `npx convex env set CONVEX_SERVICE_TOKEN …`" });
  } else if (!convexEnv.CONVEX_SERVICE_TOKEN) {
    add({ name: "Worker service token", status: "fail", detail: "not set in the Convex deployment env", hint: "cd apps/api && npx convex env set CONVEX_SERVICE_TOKEN <same value as .env>" });
  } else if (convexEnv.CONVEX_SERVICE_TOKEN !== env.CONVEX_SERVICE_TOKEN) {
    add({ name: "Worker service token", status: "fail", detail: "worker and Convex values differ", hint: "set the same CONVEX_SERVICE_TOKEN in .env and the Convex env" });
  } else {
    add({ name: "Worker service token", status: "ok", detail: "set and matches the Convex env" });
  }

  // GitHub OAuth (optional; lives in the Convex env)
  const ghSource = convexEnv ?? env;
  const ghMissing = missingVars(ghSource, ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
  add(
    ghMissing.length === 0
      ? { name: "GitHub OAuth", status: "ok", detail: `GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET set${convexEnv ? " (Convex env)" : ""}` }
      : {
          name: "GitHub OAuth",
          status: "warn",
          required: false,
          detail: `optional, missing ${ghMissing.join(", ")}${convexEnv ? "" : " (Convex env not read)"}`,
          hint: "needed for push/draft PR: npx convex env set GITHUB_CLIENT_ID … / GITHUB_CLIENT_SECRET …",
        },
  );

  // Chromium for browser QA
  const qaRequired = envFlag(env, "ORCHESTRATOR_QA_REQUIRED", envFlag(env, "QA_REQUIRED", false));
  const explicitChromium = env.QA_CHROMIUM_PATH ?? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  let chromium = null;
  let chromiumFrom = "";
  if (explicitChromium) {
    if (fs.existsSync(explicitChromium)) {
      chromium = explicitChromium;
      chromiumFrom = env.QA_CHROMIUM_PATH ? "QA_CHROMIUM_PATH" : "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
    }
  } else {
    try {
      const require = createRequire(path.join(ROOT, "packages/worker/package.json"));
      const executable = require("playwright").chromium.executablePath();
      if (executable && fs.existsSync(executable)) {
        chromium = executable;
        chromiumFrom = "Playwright";
      }
    } catch {}
  }
  add(
    chromium
      ? { name: "Chromium (browser QA)", status: "ok", detail: `found via ${chromiumFrom}` }
      : {
          name: "Chromium (browser QA)",
          status: qaRequired ? "fail" : "warn",
          required: qaRequired,
          detail: explicitChromium ? "configured path does not exist" : "not installed — UI QA will be reported as environment-blocked",
          hint: "cd packages/worker && npx playwright install chromium, or set QA_CHROMIUM_PATH",
        },
  );

  // OpenCode
  const runtime = (env.ORCHESTRATOR_EXECUTION_RUNTIME ?? env.ORCHESTRATOR_RUNTIME ?? "api").toLowerCase();
  const openCodeNeeded = runtime === "opencode" || runtime === "native-provider";
  const openCodeCommand = env.ORCHESTRATOR_NATIVE_PROVIDER_COMMAND ?? "opencode";
  const openCodePath = onPath(openCodeCommand);
  add(
    openCodePath
      ? { name: "OpenCode CLI", status: "ok", detail: `${openCodeCommand} found` }
      : {
          name: "OpenCode CLI",
          status: openCodeNeeded ? "fail" : "warn",
          required: openCodeNeeded,
          detail: `${openCodeCommand} not on PATH${openCodeNeeded ? " but ORCHESTRATOR_EXECUTION_RUNTIME=opencode" : " (optional; only for the OpenCode runtime)"}`,
          hint: "npm i -g opencode-ai, or set ORCHESTRATOR_NATIVE_PROVIDER_COMMAND",
        },
  );

  // git identity (task commits)
  const gitValue = (key) => {
    try {
      return execFileSync("git", ["config", key], { cwd: ROOT, encoding: "utf-8" }).trim();
    } catch {
      return "";
    }
  };
  const gitMissing = ["user.name", "user.email"].filter((k) => !gitValue(k));
  add(
    gitMissing.length === 0
      ? { name: "Git identity", status: "ok", detail: "user.name and user.email set" }
      : { name: "Git identity", status: "fail", detail: `missing ${gitMissing.join(", ")}`, hint: 'git config --global user.name "…" && git config --global user.email "…"' },
  );

  const code = exitCodeFor(results);
  const failed = results.filter((r) => r.status === "fail" && r.required !== false).length;
  const warned = results.filter((r) => r.status === "warn" || (r.status === "fail" && r.required === false)).length;
  console.log(`\n${code === 0 ? "Ready" : "Not ready"}: ${failed} required failure(s), ${warned} warning(s).`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().then((code) => process.exit(code));
}
