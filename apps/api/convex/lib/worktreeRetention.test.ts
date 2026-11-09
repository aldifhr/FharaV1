import { describe, expect, it } from "vitest";
import { worktreeCleanupBlocker, worktreeRetentionMs } from "./worktreeRetention";

const H = 60 * 60 * 1000;

describe("stale worktree cleanup rules", () => {
  const now = 1_000 * H;
  const base = { status: "done", worktreePath: "/w/x", finishedAt: now - 100 * H, pushes: [] as Array<{ status: string; prState?: string }> };

  it("cleans a finished task past retention", () => {
    expect(worktreeCleanupBlocker(base, now, 72 * H)).toBeNull();
    expect(worktreeCleanupBlocker({ ...base, status: "failed" }, now, 72 * H)).toBeNull();
    expect(worktreeCleanupBlocker({ ...base, status: "cancelled" }, now, 72 * H)).toBeNull();
    expect(worktreeCleanupBlocker({ ...base, pushes: [{ status: "pushed", prState: "merged" }] }, now, 72 * H)).toBeNull();
  });

  it("keeps it while the PR is open or a push is in flight", () => {
    expect(worktreeCleanupBlocker({ ...base, pushes: [{ status: "pushed", prState: "open" }] }, now, 72 * H)).toMatch(/open/);
    expect(worktreeCleanupBlocker({ ...base, pushes: [{ status: "pushed", prState: "draft" }] }, now, 72 * H)).toMatch(/open/);
    expect(worktreeCleanupBlocker({ ...base, pushes: [{ status: "pushing" }] }, now, 72 * H)).toMatch(/in flight/);
  });

  it("keeps unfinished, recent, or worktree-less tasks", () => {
    expect(worktreeCleanupBlocker({ ...base, status: "running" }, now, 72 * H)).toMatch(/not finished/);
    expect(worktreeCleanupBlocker({ ...base, status: "needs_approval" }, now, 72 * H)).toMatch(/not finished/);
    expect(worktreeCleanupBlocker({ ...base, finishedAt: now - H }, now, 72 * H)).toMatch(/retention/);
    expect(worktreeCleanupBlocker({ ...base, worktreePath: undefined }, now, 72 * H)).toMatch(/no worktree/);
  });

  it("reads the retention from env with bounds", () => {
    expect(worktreeRetentionMs(undefined)).toBe(72 * H);
    expect(worktreeRetentionMs("24")).toBe(24 * H);
    expect(worktreeRetentionMs("0")).toBe(1 * H);
    expect(worktreeRetentionMs("nope")).toBe(72 * H);
  });
});
