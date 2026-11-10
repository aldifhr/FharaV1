import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkNode,
  exitCodeFor,
  formatResult,
  mergeEnv,
  missingVars,
  modelsRequest,
  parseDotenv,
  REQUIRED_WORKER_VARS,
  manifestVar,
  withAliases,
} from "./doctor.mjs";
import { nextBackoff, parseArgs, MAX_BACKOFF_MS, MIN_BACKOFF_MS, STABLE_MS } from "./supervise.mjs";

test("parseDotenv handles comments, quotes, export and inline comments", () => {
  const env = parseDotenv(`# comment\nA=1\nexport B="two words"\nC='x # y'\nD=v # trailing\nE=\nbad line\n`);
  assert.deepEqual(env, { A: "1", B: "two words", C: "x # y", D: "v", E: "" });
});

test("mergeEnv: earlier sources win, empty values are unset", () => {
  assert.deepEqual(mergeEnv({ A: "proc", B: "" }, { A: "file", B: "file", C: "c" }), { A: "proc", B: "file", C: "c" });
});

test("checkNode: fail below 20.9, warn off the .nvmrc major, ok on it", () => {
  assert.equal(checkNode("v20.8.0", "24").status, "fail");
  assert.equal(checkNode("v22.23.3", "24").status, "warn");
  assert.equal(checkNode("v24.1.0", "24").status, "ok");
});

test("missingVars lists unset names only", () => {
  assert.deepEqual(missingVars({ A: "x", B: "" }, ["A", "B", "C"]), ["B", "C"]);
});

test("modelsRequest: bearer for OpenAI-compatible, x-api-key for Anthropic", () => {
  const openai = modelsRequest({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "https://h/v1/", LLM_API_KEY: "k" });
  assert.equal(openai.url, "https://h/v1/models");
  assert.equal(openai.headers.authorization, "Bearer k");
  const anthropic = modelsRequest({ LLM_API_KEY: "k" });
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/models");
  assert.equal(anthropic.headers["x-api-key"], "k");
  assert.equal(modelsRequest({}).hasKey, false);
});

test("formatResult and exitCodeFor: only required failures fail", () => {
  assert.equal(formatResult({ name: "X", status: "fail", detail: "d", hint: "h" }), "✗ X — d\n    → h");
  assert.equal(formatResult({ name: "X", status: "ok", hint: "h" }), "✓ X");
  assert.equal(exitCodeFor([{ status: "ok" }, { status: "warn" }, { status: "fail", required: false }]), 0);
  assert.equal(exitCodeFor([{ status: "fail" }]), 1);
});

test("supervise: backoff doubles on quick crashes, resets after a stable run", () => {
  assert.equal(nextBackoff(0, 10), MIN_BACKOFF_MS);
  assert.equal(nextBackoff(1000, 10), 2000);
  assert.equal(nextBackoff(20_000, 10), MAX_BACKOFF_MS);
  assert.equal(nextBackoff(16_000, STABLE_MS), MIN_BACKOFF_MS);
});

test("supervise: parseArgs splits options from the command", () => {
  const { options, command } = parseArgs(["--name", "worker", "--", "npx", "tsx", "src/index.ts"]);
  assert.equal(options.name, "worker");
  assert.deepEqual(command, ["npx", "tsx", "src/index.ts"]);
});

test("doctor: required vars and aliases come from the env manifest", () => {
  assert.deepEqual(REQUIRED_WORKER_VARS, ["NEXT_PUBLIC_CONVEX_URL", "CONVEX_SERVICE_TOKEN"]);
  assert.equal(withAliases({ CONVEX_URL: "http://legacy" }, "NEXT_PUBLIC_CONVEX_URL"), "http://legacy");
  assert.equal(withAliases({ NEXT_PUBLIC_CONVEX_URL: "a", CONVEX_URL: "b" }, "NEXT_PUBLIC_CONVEX_URL"), "a");
  assert.equal(withAliases({}, "CONVEX_SERVICE_TOKEN"), undefined);
  for (const name of ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "PROVIDER_ENCRYPTION_KEY", "WORKSPACE_ROOT", "QA_CHROMIUM_PATH", "ORCHESTRATOR_QA_REQUIRED", "ORCHESTRATOR_EXECUTION_RUNTIME", "ORCHESTRATOR_NATIVE_PROVIDER_COMMAND", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {
    assert.equal(manifestVar(name).name, name);
  }
  assert.throws(() => manifestVar("MODEL_CAPABILITY_ROUTING"));
});
