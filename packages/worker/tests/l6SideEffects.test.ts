import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armDecision, resolvedPhase } from "@/api/convex/sideEffects";
import { guardedEffect, type SideEffectApi } from "@/services/sideEffects";
import { handlePushRequest, pushErrorKind, type PushClaim } from "@/services/pushRequests";
import { applyEffectKey, applyUnderLedger, fileApplyState } from "@/services/runner/applyLedger";
import { hashContent, type FileDiff } from "@/tools/gitDiff";
import type { ExecGit } from "@/tools/gitPush";

/** In-memory ledger with the same transitions as apps/api/convex/sideEffects.ts. */
function memoryLedger() {
  type Row = { id: string; key: string; kind: string; phase: string; outcome?: string; evidence?: unknown; attempts: number; reason?: string };
  const rows = new Map<string, Row>();
  const byId = (id: string) => [...rows.values()].find((r) => r.id === id)!;
  const ambiguousCalls: any[] = [];
  const api: SideEffectApi = {
    armSideEffect: vi.fn(async (input: any) => {
      const row = rows.get(input.key) ?? null;
      const decision = armDecision(row as any);
      if (!row) {
        const fresh = { id: `e${rows.size + 1}`, key: input.key, kind: input.kind, phase: "armed", attempts: 1 };
        rows.set(input.key, fresh);
        return { decision, effectId: fresh.id, phase: "armed", evidence: null, attempts: 1 } as any;
      }
      if (decision === "proceed") Object.assign(row, { phase: "armed", outcome: undefined, attempts: row.attempts + 1 });
      return { decision, effectId: row.id, phase: row.phase, evidence: row.evidence ?? null, attempts: row.attempts } as any;
    }) as any,
    acceptSideEffect: vi.fn(async (input: any) => {
      const row = byId(input.effectId);
      if (row.phase === "armed") Object.assign(row, { phase: "accepted", evidence: input.evidence ?? row.evidence });
      return { applied: true } as any;
    }) as any,
    settleSideEffect: vi.fn(async (input: any) => {
      const row = byId(input.effectId);
      if (row.phase === "terminal") return { applied: false } as any;
      if (input.outcome === "failed" && row.phase === "accepted") return { applied: false } as any;
      Object.assign(row, { phase: "terminal", outcome: input.outcome, evidence: input.evidence ?? row.evidence });
      return { applied: true } as any;
    }) as any,
    markSideEffectAmbiguous: vi.fn(async (input: any) => {
      ambiguousCalls.push(input);
      const row = byId(input.effectId);
      if (row.phase !== "terminal") Object.assign(row, { phase: "ambiguous", reason: input.reason });
      return { applied: true, messageId: "m1" } as any;
    }) as any,
  };
  /** The user's click on the card. */
  const click = (key: string, action: "check" | "mark_done" | "retry") => {
    const row = rows.get(key)!;
    Object.assign(row, resolvedPhase(action));
  };
  /** A worker died after arming `key` (and maybe after accept). */
  const crashAfter = (key: string, kind: string, phase: "armed" | "accepted") =>
    rows.set(key, { id: `e${rows.size + 1}`, key, kind, phase, attempts: 1 });
  return { api, rows, click, crashAfter, ambiguousCalls };
}

describe("L6 ledger transitions", () => {
  it("only queued, absent and clean failures may write", () => {
    expect(armDecision(null)).toBe("proceed");
    expect(armDecision({ phase: "queued" } as any)).toBe("proceed");
    expect(armDecision({ phase: "terminal", outcome: "failed" } as any)).toBe("proceed");
    expect(armDecision({ phase: "armed" } as any)).toBe("reconcile");
    expect(armDecision({ phase: "accepted" } as any)).toBe("reconcile");
    expect(armDecision({ phase: "terminal", outcome: "done" } as any)).toBe("done");
    expect(armDecision({ phase: "ambiguous" } as any)).toBe("ambiguous");
    expect(resolvedPhase("check")).toEqual({ phase: "armed" });
    expect(resolvedPhase("retry")).toEqual({ phase: "queued" });
    expect(resolvedPhase("mark_done")).toEqual({ phase: "terminal", outcome: "done" });
  });

  it("a queued effect is retried normally; a clean failure may run again", async () => {
    const l = memoryLedger();
    const perform = vi.fn(async () => "ok");
    const reconcile = vi.fn(async () => ({ status: "unknown" as const, reason: "x" }));
    l.rows.set("k", { id: "e1", key: "k", kind: "push", phase: "queued", attempts: 0 });
    expect((await guardedEffect({ api: l.api, workerId: "w", key: "k", kind: "push", label: "x", perform, reconcile })).status).toBe("performed");
    const failing = vi.fn(async () => {
      throw new Error("[rejected] non-fast-forward");
    });
    expect((await guardedEffect({ api: l.api, workerId: "w", key: "k2", kind: "push", label: "x", perform: failing, reconcile })).status).toBe("failed");
    expect(l.rows.get("k2")!.outcome).toBe("failed");
    expect((await guardedEffect({ api: l.api, workerId: "w", key: "k2", kind: "push", label: "x", perform, reconcile })).status).toBe("performed");
    expect(reconcile).not.toHaveBeenCalled();
  });
});

const TOKEN = "gho_ledgertesttoken1234567890abcdef";
const SHA = "0123456789abcdef0123456789abcdef01234567";
function claim(overrides: Partial<PushClaim> = {}): PushClaim {
  return {
    pushId: "push1",
    taskId: "task1",
    projectId: "proj1",
    workspacePath: "/tmp",
    branchName: "fhara/task1/x",
    commitSha: SHA,
    openPr: false,
    existingPrNumber: undefined,
    owner: "acme",
    repo: "app",
    baseBranch: "develop",
    token: TOKEN,
    prTitle: "T",
    prBody: "B",
    ...overrides,
  } as PushClaim;
}

function pushHarness(remoteSha: string | null, ledger = memoryLedger()) {
  const gitCalls: string[][] = [];
  const execGit: ExecGit = vi.fn(async (args) => {
    gitCalls.push(args);
    if (args[0] === "ls-remote") return { stdout: remoteSha ? `${remoteSha}\trefs/heads/fhara/task1/x\n` : "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const completed: any[] = [];
  const api = {
    ...ledger.api,
    claimPushRequest: vi.fn(),
    completePushRequest: vi.fn(async (input: any) => {
      completed.push(input);
      return { applied: true };
    }),
  };
  return { ledger, gitCalls, execGit, completed, api };
}

describe("L6 push: no second git push after a crash", () => {
  const key = `push:push1:${SHA}`;

  it("armed + remote already at the sha → settled terminal, no push", async () => {
    const h = pushHarness(SHA);
    h.ledger.crashAfter(key, "push", "armed");
    await handlePushRequest(claim(), { api: h.api as any, workerId: "w2", workspaceRoot: "/", log: () => {}, execGit: h.execGit });
    expect(h.gitCalls.some((a) => a[0] === "push")).toBe(false);
    expect(h.gitCalls.some((a) => a[0] === "ls-remote")).toBe(true);
    expect(h.ledger.rows.get(key)).toMatchObject({ phase: "terminal", outcome: "done" });
    expect(h.completed[0]).toMatchObject({ outcome: "pushed" });
  });

  it("armed + remote elsewhere → ambiguous card, no push; Retry needs the click", async () => {
    const h = pushHarness("f".repeat(40));
    h.ledger.crashAfter(key, "push", "accepted");
    await handlePushRequest(claim(), { api: h.api as any, workerId: "w2", workspaceRoot: "/", log: () => {}, execGit: h.execGit });
    expect(h.gitCalls.some((a) => a[0] === "push")).toBe(false);
    expect(h.ledger.rows.get(key)!.phase).toBe("ambiguous");
    expect(h.ledger.ambiguousCalls[0].label).toMatch(/the push of fhara\/task1\/x/);
    expect(h.completed[0]).toMatchObject({ outcome: "failed" });
    expect(h.completed[0].error).toMatch(/could not confirm whether the push happened/);

    // Another claim of the same request (no click): still no push.
    await handlePushRequest(claim(), { api: h.api as any, workerId: "w3", workspaceRoot: "/", log: () => {}, execGit: h.execGit });
    expect(h.gitCalls.some((a) => a[0] === "push")).toBe(false);

    // The user clicks Retry: the push runs once.
    h.ledger.click(key, "retry");
    await handlePushRequest(claim(), { api: h.api as any, workerId: "w3", workspaceRoot: "/", log: () => {}, execGit: h.execGit });
    expect(h.gitCalls.filter((a) => a[0] === "push")).toHaveLength(1);
    expect(h.ledger.rows.get(key)).toMatchObject({ phase: "terminal", outcome: "done" });
  });

  it("a timed-out push is ambiguous, not retried", () => {
    expect(pushErrorKind(new Error("git push failed for x: git push timed out after 300s and was killed"))).toBe("ambiguous");
    expect(pushErrorKind(new Error("git push failed (the remote branch has commits): [rejected]"))).toBe("failed");
    expect(pushErrorKind(new Error("Push blocked: possible secret in the outgoing changes: .env"))).toBe("failed");
  });
});

describe("L6 PR: interrupted create finds the PR by head branch", () => {
  it("does not create a second PR", async () => {
    const h = pushHarness(SHA);
    h.ledger.crashAfter("pr:push1:fhara/task1/x", "pr_create", "armed");
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET" });
      return new Response(
        JSON.stringify([{ number: 9, html_url: "https://github.com/acme/app/pull/9", title: "T", state: "open", draft: true }]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    await handlePushRequest(claim({ openPr: true }), { api: h.api as any, workerId: "w2", workspaceRoot: "/", log: () => {}, execGit: h.execGit, fetchImpl: fetchImpl as any });
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
    expect(fetchCalls.some((c) => c.url.includes("/pulls?") && c.url.includes("head=acme%3Afhara%2Ftask1%2Fx"))).toBe(true);
    expect(h.completed[0]).toMatchObject({ outcome: "pushed", pr: { number: 9 } });
  });
});

describe("L6 apply: interrupted apply is reconciled by hash", () => {
  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), "l6-apply-"));
    return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const change = (filePath: string, oldContent: string | undefined, newContent: string, changeType: FileDiff["changeType"] = "modified"): FileDiff => ({
    filePath,
    changeType,
    oldContent,
    newContent,
    oldContentHash: oldContent !== undefined ? hashContent(oldContent) : undefined,
    newContentHash: hashContent(newContent),
    diff: "",
  });

  it("classifies files and resumes only the unwritten ones", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "a.ts"), "A2"); // already written by the dead attempt
      writeFileSync(join(ws.dir, "b.ts"), "B1"); // not written yet
      const changes = [change("a.ts", "A1", "A2"), change("b.ts", "B1", "B2")];
      expect(await fileApplyState(ws.dir, changes[0])).toBe("applied");
      expect(await fileApplyState(ws.dir, changes[1])).toBe("pending");
      const l = memoryLedger();
      const key = applyEffectKey("task1", changes);
      l.crashAfter(key, "apply", "armed");
      const writeAll = vi.fn(async () => {
        writeFileSync(join(ws.dir, "b.ts"), "B2");
        return { applied: ["a.ts", "b.ts"] } as { applied: string[] } | { stop: string };
      });
      const out = await applyUnderLedger({ api: l.api, workerId: "w", taskId: "task1", projectId: "p", workspaceRoot: ws.dir, changes, writeAll, isStop: (r) => "stop" in r });
      expect(out.kind).toBe("result");
      expect(writeAll).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(ws.dir, "b.ts"), "utf-8")).toBe("B2");
      expect(l.rows.get(key)).toMatchObject({ phase: "terminal", outcome: "done" });
    } finally {
      ws.done();
    }
  });

  it("a file changed by someone else → ambiguous, nothing written", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "a.ts"), "edited by the user");
      const changes = [change("a.ts", "A1", "A2")];
      const l = memoryLedger();
      l.crashAfter(applyEffectKey("task1", changes), "apply", "armed");
      const writeAll = vi.fn(async () => ({ applied: ["a.ts"] }));
      const out = await applyUnderLedger({ api: l.api, workerId: "w", taskId: "task1", projectId: "p", workspaceRoot: ws.dir, changes, writeAll, isStop: () => false });
      expect(out.kind).toBe("ambiguous");
      expect(writeAll).not.toHaveBeenCalled();
      expect(readFileSync(join(ws.dir, "a.ts"), "utf-8")).toBe("edited by the user");
    } finally {
      ws.done();
    }
  });

  it("everything already applied → settled, no write", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "n.ts"), "N");
      const changes = [change("n.ts", undefined, "N", "new")];
      const l = memoryLedger();
      l.crashAfter(applyEffectKey("task1", changes), "apply", "accepted");
      const writeAll = vi.fn(async () => ({ applied: ["n.ts"] }));
      const out = await applyUnderLedger({ api: l.api, workerId: "w", taskId: "task1", projectId: "p", workspaceRoot: ws.dir, changes, writeAll, isStop: () => false });
      expect(out.kind).toBe("already_applied");
      expect(writeAll).not.toHaveBeenCalled();
    } finally {
      ws.done();
    }
  });
});
