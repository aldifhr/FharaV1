import { describe, expect, it, vi } from "vitest";
import { applyOrRequestFixApproval } from "@/services/runner/fixApply";
import { brokerCheckAndApply } from "@/services/runner/applyStage";
import type { RunContext } from "@/services/runner/types";

/** L2: a staged secret stops the apply with a flagged approval in every mode. */

function makeCtx(opts: { approvalMode: "ask" | "auto"; permissionMode?: string; approvalResolved?: boolean; change: any }) {
  const calls: Record<string, any[]> = { requestApproval: [], autoApprove: [], applyStaged: [], events: [] };
  const api = {
    autoApprove: vi.fn(async (input: any) => {
      calls.autoApprove.push(input);
      return { autoApproved: true, reason: "test", mode: opts.permissionMode ?? "supervised" };
    }),
    requestApproval: vi.fn(async (input: any) => {
      calls.requestApproval.push(input);
      return "approval_1";
    }),
    checkPermission: vi.fn(async () => ({ decision: opts.approvalMode === "auto" ? "allow" : "ask", reason: "test" })),
    appendAgentMessage: vi.fn(async () => undefined),
    recordAudit: vi.fn(async () => undefined),
    logEvent: vi.fn(async (input: any) => {
      calls.events.push(input);
      return undefined;
    }),
  };
  const ctx = {
    deps: { api, workerId: "w1", workspaceRoot: "/tmp" },
    taskId: "task_1",
    project: { _id: "project_1", workspacePath: "/tmp/p" },
    plan: { version: 1, subtasks: [] },
    agents: [],
    reviewNodes: [],
    qaNodes: [],
    input: {
      approvalMode: opts.approvalMode,
      approvalResolved: opts.approvalResolved,
      planVersion: 1,
      agents: [],
      task: { _id: "task_1", command: "add config", ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}) },
    },
    state: {
      fileChanges: new Map([[opts.change.filePath, opts.change]]),
      appliedFilesBySubtask: new Map([["fix_1", [opts.change.filePath]]]),
      verification: { status: "failed" },
      feedback: [],
    },
    pendingApproval: false,
    applyStaged: vi.fn(async (changes: any[]) => {
      calls.applyStaged.push(changes);
      return { applied: changes.map((change) => change.filePath) };
    }),
  } as unknown as RunContext;
  return { ctx, calls };
}

const ENV = { filePath: ".env", changeType: "new", newContent: "OPENAI_API_KEY=x\n", diff: "" };
const PEM = { filePath: "deploy/key.txt", changeType: "new", newContent: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n", diff: "" };
const GHP = { filePath: "src/c.ts", changeType: "modified", oldContent: "a\n", newContent: `a\nconst t = "ghp_${"x".repeat(30)}";\n`, diff: "" };
const SAMPLE = { filePath: ".env.example", changeType: "new", newContent: "OPENAI_API_KEY=\n", diff: "" };
const fixSubtask = { key: "fix_1", capability: "frontend-development", kind: "code_change" } as any;

describe("L2 apply gate", () => {
  for (const [label, change] of [["a .env", ENV], ["a PEM marker", PEM], ["a ghp_ token", GHP]] as const) {
    for (const mode of [
      { approvalMode: "auto" as const },
      { approvalMode: "ask" as const, permissionMode: "auto_edits" },
      { approvalMode: "ask" as const, permissionMode: "full_access" },
      { approvalMode: "ask" as const },
    ]) {
      it(`${label} asks with secret_detected (${mode.approvalMode}/${mode.permissionMode ?? "supervised"})`, async () => {
        const { ctx, calls } = makeCtx({ ...mode, change });
        const stop = await brokerCheckAndApply(ctx, { preparedChanges: [change as any], reviewSnapshotId: "r", approvedVerdicts: [] });
        expect(stop).toBe("waiting_approval");
        expect(calls.applyStaged).toHaveLength(0);
        expect(calls.autoApprove).toHaveLength(0);
        expect(calls.requestApproval[0].payload.flags).toEqual(["secret_detected"]);
        expect(calls.requestApproval[0].summary).toMatch(/Possible secret detected/);
        expect(calls.events.some((e) => e.type === "secret.detected")).toBe(true);

        const fix = makeCtx({ ...mode, change });
        const result = await applyOrRequestFixApproval(fix.ctx, fixSubtask, "verification");
        expect(result).toBe("waiting_approval");
        expect(fix.calls.applyStaged).toHaveLength(0);
        expect(fix.calls.requestApproval[0].payload.flags).toEqual(["secret_detected"]);
      });
    }
  }

  it(".env.example passes under auto approval", async () => {
    const { ctx, calls } = makeCtx({ approvalMode: "auto", change: SAMPLE });
    const stop = await brokerCheckAndApply(ctx, { preparedChanges: [SAMPLE as any], reviewSnapshotId: "r", approvedVerdicts: [] });
    expect(stop).toBeNull();
    expect(calls.applyStaged).toHaveLength(1);
  });

  it("after the user approved the flagged batch, it applies", async () => {
    const { ctx, calls } = makeCtx({ approvalMode: "auto", approvalResolved: true, change: ENV });
    const stop = await brokerCheckAndApply(ctx, { preparedChanges: [ENV as any], reviewSnapshotId: "r", approvedVerdicts: [] });
    expect(stop).toBeNull();
    expect(calls.applyStaged).toHaveLength(1);
  });
});
