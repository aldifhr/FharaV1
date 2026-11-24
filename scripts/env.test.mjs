import { test } from "node:test";
import assert from "node:assert/strict";
import { FHARA_KEYS, keysToSync } from "./env.mjs";

test("only changed FharaRuntime keys are synced", () => {
  const wanted = { GITHUB_WEBHOOK_SECRET: "new", APP_ORIGIN: "", WORKSPACE_ROOT: "./w" };
  const current = { GITHUB_WEBHOOK_SECRET: "old" };
  assert.deepEqual(keysToSync(wanted, current), ["GITHUB_WEBHOOK_SECRET"]);
});

test("worker-only keys never go to FharaRuntime", () => {
  assert.equal(FHARA_KEYS.includes("WORKSPACE_ROOT"), false);
  assert.equal(FHARA_KEYS.includes("GITHUB_CLIENT_SECRET"), false);
  assert.equal(FHARA_KEYS.includes("GITHUB_WEBHOOK_SECRET"), true);
});

test("FHARA_KEYS come from the generated env manifest", async () => {
  const { createRequire } = await import("node:module");
  const manifest = createRequire(import.meta.url)("../packages/config/env-manifest.json");
  assert.deepEqual(FHARA_KEYS, manifest.runtimeSync);
});
