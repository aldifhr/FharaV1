import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOptimistic,
  newClientId,
  optimisticUserRow,
  reconcileOptimistic,
  withOptimisticRow,
} from "../../lib/optimisticChat.ts";

test("placeholder row carries the clientId and is marked optimistic", () => {
  const row = optimisticUserRow({ projectId: "p", content: "  halo  ", clientId: "c1" }, 1000);
  assert.equal(row._id, "optimistic:c1");
  assert.equal(row.content, "halo");
  assert.equal(row.clientId, "c1");
  assert.equal(row.authorType, "user");
  assert.equal(row._creationTime, 1000);
  assert.ok(isOptimistic(row));
  assert.ok(!isOptimistic({ _id: "k123" }));
});

test("a retried send does not draw a second bubble", () => {
  const row = optimisticUserRow({ projectId: "p", content: "x", clientId: "c1" }, 1);
  const once = withOptimisticRow([], row);
  assert.equal(withOptimisticRow(once, row).length, 1);
  assert.equal(withOptimisticRow([{ _id: "server", clientId: "c1" }], row).length, 1);
});

test("the server row with the same clientId replaces the placeholder", () => {
  const row = optimisticUserRow({ projectId: "p", content: "x", clientId: "c1" }, 1);
  const other = optimisticUserRow({ projectId: "p", content: "y", clientId: "c2" }, 2);
  const rows = reconcileOptimistic([row, other, { _id: "server1", clientId: "c1" }]);
  assert.deepEqual(rows.map((r) => r._id), ["optimistic:c2", "server1"]);
});

test("client ids are unique", () => {
  assert.notEqual(newClientId(), newClientId());
});
