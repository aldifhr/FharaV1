import assert from "node:assert/strict";
import test from "node:test";
import { requestThread, takeRequestedThread } from "../../lib/pendingThread.ts";

test("a request opens its own project's thread, once", () => {
  requestThread("p1", "t1");
  assert.equal(takeRequestedThread("p1"), "t1");
  // The shell takes it once; a StrictMode replay is absorbed by its own ref.
  assert.equal(takeRequestedThread("p1"), null);
});

test("a request for another project is left for that project", () => {
  requestThread("p2", "t2");
  assert.equal(takeRequestedThread("p1"), null);
  assert.equal(takeRequestedThread("p2"), "t2");
});

test("a new request replaces the previous one", () => {
  requestThread("p3", "t3");
  requestThread("p3", "t4");
  assert.equal(takeRequestedThread("p3"), "t4");
});
