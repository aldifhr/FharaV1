// D12: the client side of history paging (merge, cursor, jump to a turn), against an in-memory thread.
import test from "node:test";
import assert from "node:assert/strict";

import { loadEarlier, mergeHistory, oldestCursor, turnPreview, MESSAGE_WINDOW } from "../../../api/convex/lib/historyPaging.ts";

const thread = Array.from({ length: 3000 }, (_, i) => ({ _id: `m${i + 1}`, _creationTime: 1000 + i, content: `message ${i + 1}` }));
const live = thread.slice(-MESSAGE_WINDOW);

/** The cursor query's contract: rows in [floor, before), newest `limit`, oldest first. */
async function fetchPage({ before, floor, limit = 200 }) {
  const range = thread.filter((m) => m._creationTime < before && (floor === undefined || m._creationTime >= floor));
  const rows = range.slice(-limit);
  const overflow = range.length > limit;
  if (floor === undefined) return { rows, hasMore: overflow, reachedFloor: true };
  if (overflow) return { rows, hasMore: true, reachedFloor: false };
  return { rows, hasMore: thread.some((m) => m._creationTime < floor), reachedFloor: true };
}

test("paging from the live window reaches message 1", async () => {
  let held = { earlier: [], hasMore: true };
  for (let pages = 0; held.hasMore; pages++) {
    assert.ok(pages < 50);
    held = await loadEarlier(fetchPage, { earlier: held.earlier, live });
  }
  const all = mergeHistory(held.earlier, live);
  assert.equal(all.length, 3000);
  assert.equal(all[0].content, "message 1");
  assert.equal(oldestCursor(all), 1000);
});

test("a jump pages down to the turn and keeps the list contiguous", async () => {
  const target = thread[41];
  const held = await loadEarlier(fetchPage, { earlier: [], live }, { floor: target._creationTime });
  const all = mergeHistory(held.earlier, live);
  assert.equal(all[0]._id, target._id);
  assert.equal(all.length, 3000 - 41);
  assert.equal(held.hasMore, true);
});

test("merge keeps the live copy of a row held in both", () => {
  const edited = { ...live[0], content: "edited" };
  const merged = mergeHistory([thread[2499], live[0]], [edited, ...live.slice(1)]);
  assert.equal(merged.length, MESSAGE_WINDOW + 1);
  assert.equal(merged[1].content, "edited");
});

test("turn previews take the first line and cut long text", () => {
  assert.equal(turnPreview("\n  fix the build  \nmore"), "fix the build");
  assert.equal(turnPreview("x".repeat(200)).length, 80);
});
