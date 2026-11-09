import { describe, expect, it, vi } from "vitest";
import {
  AUTO_ACCEPT_DELETE_LIMIT,
  autoApprovalDecision,
  normalizePermissionMode,
  projectDefaultPermissionMode,
} from "@/api/convex/lib/permissionModes";
import { applyOrRequestFixApproval } from "@/services/runner/fixApply";
import { mayAutoApproveEdits, tryAutoApprove } from "@/services/runner/autoApprove";
import type { RunContext } from "@/services/runner/types";

/**
 * Plan 020 — permission modes. The policy is pure; the worker paths are
 * exercised with a minimal RunContext and a recording API double.
 */

describe("autoApprovalDecision", () => {
  it("supervised asks for everything", () => {
    for (const kind of ["apply_changes", "run_command", "git_push", "merge_pr"] as const) {
      expect(autoApprovalDecision("supervised", kind).auto).toBe(false);
    }
  });

  it("auto-accept edits approves file changes only", () => {
    expect(autoApprovalDecision("auto_edits", "apply_changes").auto).toBe(true);
    expect(autoApprovalDecision("auto_edits", "run_command").auto).toBe(false);
  });

  it("push and PR always ask, even in full access", () => {
    for (const mode of ["supervised", "auto_edits", "full_access"] as const) {
      expect(autoApprovalDecision(mode, "git_push").auto).toBe(false);
      expect(autoApprovalDecision(mode, "merge_pr").auto).toBe(false);
    }
    expect(autoApprovalDecision("full_access", "run_command").auto).toBe(true);
  });

  it("risky batches still ask under auto-accept edits", () => {
    expect(autoApprovalDecision("auto_edits", "apply_changes", { deletes: AUTO_ACCEPT_DELETE_LIMIT }).auto).toBe(true);
    expect(autoApprovalDecision("auto_edits", "apply_changes", { deletes: AUTO_ACCEPT_DELETE_LIMIT + 1 }).auto).toBe(false);
    expect(autoApprovalDecision("auto_edits", "apply_changes", { policyFlagged: true }).auto).toBe(false);
    expect(autoApprovalDecision("full_access", "apply_changes", { outsideWorkspace: true }).auto).toBe(false);
    // Full access has no delete threshold.
    expect(autoApprovalDecision("full_access", "apply_changes", { deletes: 50 }).auto).toBe(true);
  });

  it("existing tasks and projects default to supervised", () => {
    expect(normalizePermissionMode(undefined)).toBe("supervised");
    expect(normalizePermissionMode("bogus")).toBe("supervised");
    expect(projectDefaultPermissionMode({})).toBe("supervised");
    expect(projectDefaultPermissionMode({ defaultPermissionMode: "auto_edits" })).toBe("auto_edits");
    // Legacy project-level auto switch maps to full access.
    expect(projectDefaultPermissionMode({ approvalMode: "auto" })).toBe("full_access");
  });
});

function makeCtx(permissionMode: string | undefined, autoApproved = true) {
  const calls: Record<string, any[]> = { requestApproval: [], autoApprove: [], applyStaged: [] };
  const api = {
    autoApprove: vi.fn(async (input: any) => {
      calls.autoApprove.push(input);
      return { autoApproved, reason: "test", mode: permissionMode ?? "supervised" };
    }),
    requestApproval: vi.fn(async (input: any) => {
      calls.requestApproval.push(input);
      return "approval_1";
    }),
    appendAgentMessage: vi.fn(async () => undefined),
    logEvent: vi.fn(async () => undefined),
  };
  const fix = { filePath: "src/a.ts", changeType: "modified", newContent: "fixed\n", diff: "" };
  const ctx = {
    deps: { api, workerId: "w1" },
    taskId: "task_1",
    project: { _id: "project_1" },
    plan: { version: 1, subtasks: [] },
    agents: [],
    input: {
      approvalMode: "ask",
      planVersion: 1,
      task: { _id: "task_1", ...(permissionMode ? { permissionMode } : {}) },
    },
    state: {
      fileChanges: new Map([[fix.filePath, fix]]),
      appliedFilesBySubtask: new Map([["verify_fix_1", [fix.filePath]]]),
      verification: { status: "failed" },
      feedback: [],
    },
    pendingApproval: false,
    applyStaged: vi.fn(async (changes: any[]) => {
      calls.applyStaged.push(changes);
      return { applied: changes.map((change) => change.filePath) };
    }),
  } as unknown as RunContext;
  const fixSubtask = { key: "verify_fix_1", capability: "frontend-development", kind: "code_change" } as any;
  return { ctx, calls, fixSubtask };
}

describe("verification fix under a permission mode", () => {
  it("auto-accept edits: the verify fix is auto-approved and applied with no pause", async () => {
    const { ctx, calls, fixSubtask } = makeCtx("auto_edits");
    const result = await applyOrRequestFixApproval(ctx, fixSubtask, "verification");
    expect(result).toBe("applied");
    expect(ctx.pendingApproval).toBe(false);
    expect(calls.requestApproval).toHaveLength(0);
    expect(calls.autoApprove).toHaveLength(1);
    expect(calls.autoApprove[0]).toMatchObject({ kind: "apply_changes", subtaskKey: "verify_fix_1" });
    // The recorded approval covers every staged file (broker coverage rule).
    expect(calls.autoApprove[0].payload.filePaths).toEqual(["src/a.ts"]);
    expect(calls.applyStaged).toHaveLength(1);
  });

  it("supervised (and pre-020 tasks): the verify fix still pauses for approval", async () => {
    for (const mode of ["supervised", undefined]) {
      const { ctx, calls, fixSubtask } = makeCtx(mode);
      const result = await applyOrRequestFixApproval(ctx, fixSubtask, "verification");
      expect(result).toBe("waiting_approval");
      expect(ctx.pendingApproval).toBe(true);
      expect(calls.autoApprove).toHaveLength(0);
      expect(calls.requestApproval).toHaveLength(1);
      expect(calls.applyStaged).toHaveLength(0);
    }
  });

  it("falls back to asking when the backend refuses the auto-approval", async () => {
    const { ctx, calls, fixSubtask } = makeCtx("auto_edits", false);
    const result = await applyOrRequestFixApproval(ctx, fixSubtask, "QA");
    expect(result).toBe("waiting_approval");
    expect(calls.requestApproval).toHaveLength(1);
    expect(calls.applyStaged).toHaveLength(0);
  });

  it("push still asks: tryAutoApprove never auto-approves git_push, even in full access", async () => {
    const { ctx, calls } = makeCtx("full_access");
    const approved = await tryAutoApprove(ctx, {
      kind: "git_push",
      summary: "Push branch",
      payload: {},
      changes: [],
    });
    expect(approved).toBe(false);
    expect(calls.autoApprove).toHaveLength(0);
  });

  it("only modes that may auto-approve edits skip the plan-level gate", () => {
    expect(mayAutoApproveEdits(makeCtx("supervised").ctx)).toBe(false);
    expect(mayAutoApproveEdits(makeCtx(undefined).ctx)).toBe(false);
    expect(mayAutoApproveEdits(makeCtx("auto_edits").ctx)).toBe(true);
    expect(mayAutoApproveEdits(makeCtx("full_access").ctx)).toBe(true);
  });
});
