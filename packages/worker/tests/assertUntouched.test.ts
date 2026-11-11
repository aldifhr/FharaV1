import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertUntouched, changesOutside, snapshotTree } from "./helpers/assertUntouched";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-untouched-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries({ "docs/a.md": "a\n", "src/index.ts": "export {};\n", ".git/HEAD": "ref\n", "node_modules/x/i.js": "1\n" })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

describe("assertUntouched (verify the world)", () => {
  it("passes when only allowed paths changed (and ignores .git / node_modules)", () => {
    const dir = repo();
    const before = snapshotTree(dir);
    fs.writeFileSync(path.join(dir, "docs/a.md"), "edited\n");
    fs.writeFileSync(path.join(dir, "docs/b.md"), "new\n");
    fs.writeFileSync(path.join(dir, ".git/HEAD"), "moved\n");
    fs.writeFileSync(path.join(dir, "node_modules/x/i.js"), "2\n");
    expect(() => assertUntouched(before, dir, ["docs"])).not.toThrow();
  });

  it("fails on a planted edit, a new file or a deletion outside the allowed paths", () => {
    const dir = repo();
    const before = snapshotTree(dir);
    fs.writeFileSync(path.join(dir, "src/index.ts"), "export const leaked = 1;\n");
    expect(() => assertUntouched(before, dir, ["docs"])).toThrow(/src\/index\.ts \(modified\)/);
    fs.writeFileSync(path.join(dir, "docsx.md"), "prefix is not a match\n");
    fs.rmSync(path.join(dir, "docs/a.md"));
    expect(changesOutside(before, dir, ["docs"])).toEqual([
      { path: "docsx.md", change: "added" },
      { path: "src/index.ts", change: "modified" },
    ]);
    expect(changesOutside(before, dir, [])).toContainEqual({ path: "docs/a.md", change: "removed" });
  });
});
