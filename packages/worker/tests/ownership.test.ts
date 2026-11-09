import { describe, expect, it } from "vitest";
import {
  isPathWithinOwnership,
  normalizeAllowedPaths,
  pathsOverlap,
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
