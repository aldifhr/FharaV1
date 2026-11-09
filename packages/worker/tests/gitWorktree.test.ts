import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitWorktree } from "@/tools/gitWorktree";
import { createTempGitRepo } from "./helpers/tempRepo";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("commitWorktree", () => {
  it("commits only the given files and skips a clean tree", async () => {
    const { dir, cleanup } = createTempGitRepo({ prefix: "moagent-worktree-" });
    try {
      writeFileSync(join(dir, "a.txt"), "one");
      writeFileSync(join(dir, "b.txt"), "two");
      const committed = await commitWorktree(dir, "MOAgent: test", ["a.txt"]);
      expect(committed).toBe(true);
      expect(git(dir, ["log", "-1", "--format=%s"]).trim()).toBe("MOAgent: test");
      expect(git(dir, ["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("a.txt");
      writeFileSync(join(dir, "b.txt"), "two again");
      expect(await commitWorktree(dir, "MOAgent: b", ["b.txt"])).toBe(true);
      expect(await commitWorktree(dir, "MOAgent: noop", ["b.txt"])).toBe(false);
    } finally {
      cleanup();
    }
  });
});
