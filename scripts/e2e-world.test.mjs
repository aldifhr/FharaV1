// e2e/fixtures-ui/world.mjs: the "verify the world" check the live worker flows run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { allowedPathsOfScript, changesOutside, isAllowedPath, snapshotTree } from "../e2e/fixtures-ui/world.mjs";

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-world-"));
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "docs/a.md"), "a\n");
  fs.writeFileSync(path.join(dir, "src/index.ts"), "export {};\n");
  fs.writeFileSync(path.join(dir, ".git/HEAD"), "ref\n");
  return dir;
}

test("an edit inside the allowed paths passes; a planted edit outside them is reported", () => {
  const dir = tmpRepo();
  try {
    const before = snapshotTree(dir);
    fs.writeFileSync(path.join(dir, "docs/a.md"), "changed\n");
    fs.writeFileSync(path.join(dir, "docs/new.md"), "new\n");
    fs.writeFileSync(path.join(dir, ".git/HEAD"), "moved\n"); // .git is never judged
    assert.deepEqual(changesOutside(before, dir, ["docs"]), []);
    fs.writeFileSync(path.join(dir, "src/index.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "stray.txt"), "x\n");
    assert.deepEqual(changesOutside(before, dir, ["docs/"]), [
      { path: "src/index.ts", change: "modified" },
      { path: "stray.txt", change: "added" },
    ]);
    fs.rmSync(path.join(dir, "src/index.ts"));
    assert.deepEqual(changesOutside(before, dir, ["docs"]).map((c) => c.change), ["removed", "added"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("allowed paths match whole segments, not prefixes", () => {
  assert.equal(isAllowedPath("docs/a.md", ["docs"]), true);
  assert.equal(isAllowedPath("docs", ["./docs/"]), true);
  assert.equal(isAllowedPath("docsx/a.md", ["docs"]), false);
  assert.equal(isAllowedPath("anything", []), false);
});

test("a flow's allowed paths come from its plans, following extends", () => {
  const scripts = path.resolve(import.meta.dirname, "mock-llm/scripts");
  assert.deepEqual(allowedPathsOfScript(path.join(scripts, "flow-e-verify-fix.json")), ["docs", "src"]);
  assert.deepEqual(allowedPathsOfScript(path.join(scripts, "default.json")), ["docs"]);
});
