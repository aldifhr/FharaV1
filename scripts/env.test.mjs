import { test } from "node:test";
import assert from "node:assert/strict";
import { CONVEX_KEYS, keysToSync } from "./env.mjs";

test("only changed Convex keys are synced", () => {
  const wanted = { LLM_MODEL: "nous", LLM_API_KEY: "k", WORKSPACE_ROOT: "./w", GITHUB_CLIENT_ID: "" };
  const current = { LLM_MODEL: "nous", LLM_API_KEY: "old" };
  assert.deepEqual(keysToSync(wanted, current), ["LLM_API_KEY"]);
});

test("worker-only keys never go to Convex", () => {
  assert.equal(CONVEX_KEYS.includes("WORKSPACE_ROOT"), false);
  assert.equal(CONVEX_KEYS.includes("GITHUB_CLIENT_SECRET"), true);
  assert.equal(CONVEX_KEYS.includes("GITHUB_WEBHOOK_SECRET"), true);
});
