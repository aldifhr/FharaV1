import { test } from "node:test";
import assert from "node:assert/strict";
import { FHARA_KEYS, keysToSync } from "./env.mjs";

test("only changed FharaRuntime keys are synced", () => {
  const wanted = { GITHUB_CLIENT_ID: "new", GITHUB_CLIENT_SECRET: "s", WORKSPACE_ROOT: "./w", APP_ORIGIN: "" };
  const current = { GITHUB_CLIENT_ID: "old", GITHUB_CLIENT_SECRET: "s" };
  assert.deepEqual(keysToSync(wanted, current), ["GITHUB_CLIENT_ID"]);
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
