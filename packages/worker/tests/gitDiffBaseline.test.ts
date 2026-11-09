import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeDiff,
  diffFromContents,
  isNoOpChange,
  readHeadContent,
  snapshotDirtyFiles,
} from "@/tools/gitDiff";
import { createTempGitRepo } from "./helpers/tempRepo";

let repo: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir: repo, cleanup } = createTempGitRepo({
    prefix: "fhara-gitdiff-",
    files: { "index.html": "<h1>old</h1>\n" },
  }));
});

afterEach(() => {
  cleanup();
});

describe("no-op changes", () => {
  it("flags a modified file whose new content equals the current content", async () => {
    const diff = await computeDiff(repo, "index.html", "<h1>old</h1>\n");
    expect(isNoOpChange(diff)).toBe(true);
  });

  it("does not flag a real edit or a new file", async () => {
    expect(isNoOpChange(await computeDiff(repo, "index.html", "<h1>new</h1>\n"))).toBe(false);
    expect(isNoOpChange(await computeDiff(repo, "about.html", "hi"))).toBe(false);
  });
});

describe("baseline for runtimes that write straight to disk", () => {
  it("reads the old content from HEAD, not from the already-edited disk", async () => {
    fs.writeFileSync(path.join(repo, "index.html"), "<h1>new</h1>\n");
    const baseline = await readHeadContent(repo, "index.html");
    const diff = diffFromContents("index.html", baseline, "<h1>new</h1>\n");
    expect(diff.changeType).toBe("modified");
    expect(isNoOpChange(diff)).toBe(false);
    expect(diff.diff).toContain("-<h1>old</h1>");
  });

  it("treats an untracked file as new", async () => {
    expect(await readHeadContent(repo, "about.html")).toBeUndefined();
    expect(diffFromContents("about.html", undefined, "hi").changeType).toBe("new");
  });

  it("snapshots files that were already dirty before the run", async () => {
    fs.writeFileSync(path.join(repo, "index.html"), "<h1>user edit</h1>\n");
    const snapshot = await snapshotDirtyFiles(repo);
    expect(snapshot.get("index.html")).toBe("<h1>user edit</h1>\n");
  });
});
