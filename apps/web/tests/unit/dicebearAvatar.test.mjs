import assert from "node:assert/strict";
import test from "node:test";
import { avatarInitial, memoizeUntilFailure } from "../../lib/dicebearAvatar.ts";

test("the fallback letter comes from the agent's name, not a shuffled seed", () => {
  assert.equal(avatarInitial("Frontend", "x8k2m1"), "F");
  assert.equal(avatarInitial("  reviewer", "abc"), "R");
  assert.equal(avatarInitial(undefined, "qa-seed"), "Q");
  assert.equal(avatarInitial("  ", ""), "•");
});

test("a failed renderer load is retried; a good one is shared", async () => {
  let calls = 0;
  let fail = true;
  const load = memoizeUntilFailure(async () => {
    calls += 1;
    if (fail) throw new Error("chunk failed");
    return "renderer";
  });
  await assert.rejects(load());
  fail = false;
  assert.equal(await load(), "renderer");
  assert.equal(await load(), "renderer");
  assert.equal(calls, 2);
  // Concurrent callers share one in-flight load.
  const shared = memoizeUntilFailure(async () => {
    calls += 1;
    return 1;
  });
  await Promise.all([shared(), shared(), shared()]);
  assert.equal(calls, 3);
});
