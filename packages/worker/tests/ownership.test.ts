import { describe, expect, it } from "vitest";
import {
  isPathWithinOwnership,
  normalizeAllowedPaths,
  pathsOverlap,
  pickFixOwner,
} from "@/orchestrator/ownership";
import { snapshotIdForChanges } from "@/tools/gitDiff";
import type { FileDiff } from "@/tools/gitDiff";

describe("path ownership", () => {
  it("treats absent ownership as unrestricted (legacy plans)", () => {
    expect(normalizeAllowedPaths(undefined)).toEqual({ ok: true });
    expect(isPathWithinOwnership("any/file.ts", undefined)).toBe(true);
  });

  it("normalizes entries and dedupes", () => {
    expect(normalizeAllowedPaths(["apps\\web", "./apps/web", "apps/web"])).toEqual({
      ok: true,
      paths: ["apps/web"],
    });
  });

  it("rejects escapes and absolute paths", () => {
    expect(normalizeAllowedPaths(["../secret"])).toMatchObject({ ok: false });
    expect(normalizeAllowedPaths(["/etc/passwd"])).toMatchObject({ ok: false });
    expect(normalizeAllowedPaths(["apps/../secret"])).toMatchObject({ ok: false });
    expect(normalizeAllowedPaths(["apps//web"])).toMatchObject({ ok: false });
  });

  it("matches on directory boundaries only", () => {
    expect(isPathWithinOwnership("apps/web/app.tsx", ["apps/web"])).toBe(true);
    expect(isPathWithinOwnership("apps/web", ["apps/web"])).toBe(true);
    expect(isPathWithinOwnership("apps/web2/app.tsx", ["apps/web"])).toBe(false);
    expect(isPathWithinOwnership("apps/api/index.ts", ["apps/web"])).toBe(false);
  });

  it("detects overlap symmetrically and treats unrestricted as overlapping a declared scope", () => {
    expect(pathsOverlap(["apps/web"], ["apps/web/features"])).toBe(true);
    expect(pathsOverlap(["apps/web"], ["apps/api"])).toBe(false);
    expect(pathsOverlap(undefined, ["apps/web"])).toBe(true);
    expect(pathsOverlap(["apps/web"], undefined)).toBe(true);
    expect(pathsOverlap(undefined, undefined)).toBe(false);
  });
});

describe("change-set snapshot id", () => {
  const change = (filePath: string, newContentHash: string): FileDiff => ({
    filePath,
    changeType: "modified",
    oldContentHash: "old",
    newContentHash,
    diff: "",
  });

  it("is order-independent and changes when any new content changes", () => {
    const a = change("a.ts", "h1");
    const b = change("b.ts", "h2");
    expect(snapshotIdForChanges([a, b])).toBe(snapshotIdForChanges([b, a]));
    expect(snapshotIdForChanges([a, b])).not.toBe(
      snapshotIdForChanges([a, change("b.ts", "h3")])
    );
  });
});

describe("pickFixOwner", () => {
  const backend = {
    key: "types",
    kind: "code_change",
    capability: "backend-development",
    allowedPaths: ["src/lib/resume"],
  };
  const frontend = {
    key: "ui",
    kind: "code_change",
    capability: "frontend-development",
    allowedPaths: ["src/components/builder"],
  };
  const review = { key: "review", kind: "review", capability: "code-review" };

  it("routes a frontend finding to the frontend subtask even when backend comes first", () => {
    const owner = pickFixOwner([backend, frontend, review], [
      { filePath: "src/components/builder/EditorSections.tsx" },
    ]);
    expect(owner?.key).toBe("ui");
  });

  it("routes a backend finding to the backend subtask", () => {
    const owner = pickFixOwner([backend, frontend], [{ filePath: "./src/lib/resume/types.ts" }]);
    expect(owner?.key).toBe("types");
  });

  it("matches glob scopes and absolute worktree paths", () => {
    const globbed = { ...frontend, allowedPaths: ["src/components/builder/**/*.tsx"] };
    const owner = pickFixOwner([backend, globbed], [
      { filePath: "/tmp/.moagent-worktrees/task-1/src/components/builder/ItemCard.tsx" },
    ]);
    expect(owner?.key).toBe("ui");
  });

  it("prefers the longest matching scope", () => {
    const broad = { ...backend, key: "broad", allowedPaths: ["src/components"] };
    const owner = pickFixOwner([broad, frontend], [
      { filePath: "src/components/builder/EditorPanel.tsx" },
    ]);
    expect(owner?.key).toBe("ui");
  });

  it("never treats a bare src scope as a match and falls back to the last code_change", () => {
    const generic = { ...backend, key: "generic", allowedPaths: ["src/**"] };
    const owner = pickFixOwner([generic, frontend], [{ filePath: "README.md" }]);
    expect(owner?.key).toBe("ui");
  });

  it("returns undefined when there is no code_change", () => {
    expect(pickFixOwner([review], [{ filePath: "src/x.ts" }])).toBeUndefined();
  });
});

describe("normalizeAllowedPaths trailing slash (e2e ULTRA)", () => {
  it("accepts directory scopes written with a trailing slash", async () => {
    const { normalizeAllowedPaths } = await import("@/orchestrator/ownership");
    expect(normalizeAllowedPaths(["src/", "styles.css"])).toEqual({ ok: true, paths: ["src", "styles.css"] });
    expect(normalizeAllowedPaths(["/"]).ok).toBe(false);
    expect(normalizeAllowedPaths(["../x/"]).ok).toBe(false);
  });
});
