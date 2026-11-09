import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutDag, positionLayers, positionRing } from "../../lib/dagLayout.ts";

test("layoutDag layers a chain left-to-right in dependency order", () => {
  const nodes = [
    { key: "a", dependencies: [] },
    { key: "b", dependencies: ["a"] },
    { key: "c", dependencies: ["b"] },
  ];
  const layout = layoutDag(nodes);
  assert.deepEqual(layout.levels, [["a"], ["b"], ["c"]]);
  assert.deepEqual(layout.edges, [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
  const { boxOf } = positionLayers(layout, { nodeW: 100, nodeH: 40, colGap: 20, rowGap: 10, pad: 8 });
  assert.ok(boxOf("a").x < boxOf("b").x && boxOf("b").x < boxOf("c").x);
});

test("layoutDag ignores unknown deps and self edges, breaks cycles", () => {
  const layout = layoutDag([
    { key: "a", dependencies: ["ghost", "a"] },
    { key: "b", dependencies: ["a"] },
  ]);
  assert.equal(layout.levels.length, 2);
  assert.equal(layout.edges.length, 1);
});

test("positionRing places keys on a circle with no overlaps for a ring", () => {
  const { width, height, boxOf } = positionRing(["a", "b", "c", "d"], { nodeW: 80, nodeH: 30, pad: 16 });
  assert.ok(width > 0 && height > 0);
  const boxes = ["a", "b", "c", "d"].map((k) => boxOf(k));
  const centers = boxes.map((b) => [b.x + b.w / 2, b.y + b.h / 2]);
  const distinct = new Set(centers.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`));
  assert.equal(distinct.size, 4);
});
