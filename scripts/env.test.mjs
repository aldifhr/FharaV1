import { test } from "node:test";
import assert from "node:assert/strict";
import { FHARA_KEYS, keysToSync } from "./env.mjs";

test("only changed FharaRuntime keys are synced", () => {
  const wanted = { LLM_MODEL: "nous", LLM_API_KEY: "k", WORKSPACE_ROOT: "./w", GITHUB_CLIENT_ID: "" };
  const current = { LLM_MODEL: "nous", LLM_API_KEY: "old" };
  assert.deepEqual(keysToSync(wanted, current), ["LLM_API_KEY"]);
});

test("worker-only keys never go to FharaRuntime", () => {
  assert.equal(FHARA_KEYS.includes("WORKSPACE_ROOT"), false);
  assert.equal(FHARA_KEYS.includes("GITHUB_CLIENT_SECRET"), true);
  assert.equal(FHARA_KEYS.includes("GITHUB_WEBHOOK_SECRET"), true);
});

test("FHARA_KEYS come from the generated env manifest", async () => {
  const { createRequire } = await import("node:module");
  const manifest = createRequire(import.meta.url)("../packages/config/env-manifest.json");
  assert.deepEqual(FHARA_KEYS, manifest.runtimeSync);
});
