import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRows,
  checksSummary,
  consumeOpenChanges,
  diffChangeType,
  isPatchTruncated,
  prFactsText,
  prLine,
  requestOpenChanges,
  splitPatchByFile,
  statusLetter,
  stepFile,
} from "../../lib/changesView.ts";
import { KEYBINDING_ACTIONS, defaultKeybindings, formatChord, matchesChord } from "../../lib/keybindings.ts";

const section = (oldPath, path, body = "@@ -1 +1 @@\n-a\n+b\n") =>
  `diff --git a/${oldPath} b/${path}\nindex 1..2 100644\n--- a/${oldPath}\n+++ b/${path}\n${body}`;

test("splitPatchByFile keys sections by the known file list, spaces and renames included", () => {
  const files = [
    { path: "src/a b.ts" },
    { path: "new/name.ts", oldPath: "old/name.ts" },
    { path: "café.txt" },
  ];
  const patch = section("src/a b.ts", "src/a b.ts") + section("old/name.ts", "new/name.ts") + section("café.txt", "café.txt");
  const map = splitPatchByFile(patch, files);
  assert.deepEqual([...map.keys()], ["src/a b.ts", "new/name.ts", "café.txt"]);
  assert.ok(map.get("new/name.ts").startsWith("diff --git a/old/name.ts b/new/name.ts\n"));
  assert.ok(map.get("src/a b.ts").endsWith("+b\n"));
  assert.ok(!map.get("src/a b.ts").includes("old/name.ts"));
});

test("splitPatchByFile falls back to the +++ line when git quoted the header", () => {
  const patch = `diff --git "a/tab\\there" "b/tab\\there"\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n`;
  const map = splitPatchByFile(patch, [{ path: "x.ts" }]);
  assert.ok(map.has("x.ts"));
});

test("a truncated patch is detected and later files are missing from the map", () => {
  const marker = "\\ Fhara: diff truncated at 32 MB; later files are listed but not shown\n";
  const patch = section("a.ts", "a.ts") + marker;
  assert.equal(isPatchTruncated(patch), true);
  assert.equal(isPatchTruncated(section("a.ts", "a.ts")), false);
  const map = splitPatchByFile(patch, [{ path: "a.ts" }, { path: "b.ts" }]);
  assert.equal(map.has("b.ts"), false);
  assert.ok(!map.get("a.ts").includes("Fhara: diff truncated"));
});

test("status letters and DiffCard change types", () => {
  assert.deepEqual(["added", "modified", "deleted", "renamed", "copied", "changed"].map(statusLetter), ["A", "M", "D", "R", "C", "·"]);
  assert.equal(diffChangeType("added"), "new");
  assert.equal(diffChangeType("deleted"), "deleted");
  assert.equal(diffChangeType("renamed"), "modified");
});

test("PR facts read as plain words", () => {
  assert.equal(prLine({ number: 12, state: "draft" }), "#12 draft");
  assert.deepEqual(prFactsText({ reviewState: "changes_requested", mergeable: "conflict" }), ["Changes requested", "Has conflicts"]);
  assert.deepEqual(prFactsText({ reviewState: "none", mergeable: "unknown" }), []);
});

test("check rows put failures first and summarise counts", () => {
  const checks = [
    { name: "lint", status: "passed" },
    { name: "test", status: "failed", url: "https://ci/1" },
    { name: "build", status: "pending" },
    { name: "e2e", status: "failed" },
  ];
  assert.deepEqual(checkRows(checks).map((r) => `${r.name}:${r.word}`), ["test:Failed", "e2e:Failed", "build:Pending", "lint:Passed"]);
  assert.equal(checkRows(checks)[0].url, "https://ci/1");
  assert.equal(checksSummary(checks), "2 failed · 1 pending · 1 passed");
  assert.equal(checksSummary([]), "");
});

test("stepFile clamps and starts from either end", () => {
  assert.equal(stepFile(-1, 3, 1), 0);
  assert.equal(stepFile(-1, 3, -1), 2);
  assert.equal(stepFile(2, 3, 1), 2);
  assert.equal(stepFile(0, 3, -1), 0);
  assert.equal(stepFile(1, 3, 1), 2);
  assert.equal(stepFile(0, 0, 1), -1);
});

test("open-changes hand-off is consumed once, by the matching task", () => {
  requestOpenChanges("t1");
  assert.equal(consumeOpenChanges("t2"), false);
  assert.equal(consumeOpenChanges("t1"), true);
  assert.equal(consumeOpenChanges("t1"), false);
});

test("Changes keybindings: defaults, matching and display", () => {
  const ids = KEYBINDING_ACTIONS.map((a) => a.id);
  for (const id of ["toggleChanges", "nextFile", "prevFile"]) assert.ok(ids.includes(id), id);
  const b = defaultKeybindings();
  const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(matchesChord(key("G", { metaKey: true, shiftKey: true }), b.toggleChanges), true);
  assert.equal(matchesChord(key("ArrowDown", { altKey: true }), b.nextFile), true);
  assert.equal(matchesChord(key("ArrowUp", { altKey: true }), b.prevFile), true);
  assert.equal(matchesChord(key("ArrowDown"), b.nextFile), false);
  assert.equal(formatChord(b.nextFile, true), "⌥↓");
  assert.equal(formatChord(b.toggleChanges, true), "⌘⇧G");
});
