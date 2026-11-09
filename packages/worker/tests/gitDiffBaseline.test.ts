import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeDiff,
  diffFromContents,
  isNoOpChange,
  readHeadContent,
  snapshotDirtyFiles,
} from "@/tools/gitDiff";

let repo: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "moagent-gitdiff-"));
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "index.html"), "<h1>old</h1>\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
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
