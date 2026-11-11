/**
 * GOAT G9: project setup / check scripts. The runner kills a script at its
 * timeout (`timed_out`), keeps a 40-line / 4k tail, never runs an argv off
 * the allowlist, and a project without a check script gets "No check
 * configured", which the card never shows as a pass. Setup runs only when
 * the worktree was just created.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { VerificationCardData } from "@/api/convex/cardTypes";
import { runProjectScript, scriptTail, type ProjectScriptOutcome } from "@/execution/projectScriptRun";
import {
  hostCheckOutcome,
  runHostCheckAfterDone,
  runSetupOnWorktreeCreate,
} from "@/services/runner/projectScriptHooks";

const dir = mkdtempSync(join(tmpdir(), "fhara-g9-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const allowAll = () => true;

function fakeApi() {
  return {
    logEvent: vi.fn(async () => undefined),
    postTaskCard: vi.fn(async () => undefined),
    appendAgentMessage: vi.fn(async () => undefined),
  };
}

describe("runProjectScript", () => {
  it("kills a script at its timeout and reports timed_out", async () => {
    const outcome = await runProjectScript({
      kind: "check",
      argv: [process.execPath, "-e", "console.log('started'); setInterval(() => {}, 1000)"],
      projectRoot: dir,
      timeoutMs: 400,
      allow: allowAll,
    });
    expect(outcome.status).toBe("timed_out");
    expect(outcome.detail).toMatch(/Timed out/);
    expect(outcome.durationMs).toBeLessThan(8_000);
  }, 15_000);

  it("reports failed with the exit code and a tail of at most 40 lines / 4,000 chars", async () => {
    const outcome = await runProjectScript({
      kind: "check",
      argv: [process.execPath, "-e", "for (let i = 0; i < 300; i++) console.log('line ' + i + ' ' + 'x'.repeat(150)); process.exitCode = 3"],
      projectRoot: dir,
      allow: allowAll,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.tail!.split("\n").length).toBeLessThanOrEqual(40);
    expect(outcome.tail!.length).toBeLessThanOrEqual(4_000);
    expect(outcome.tail).toContain("line 299");
  }, 15_000);

  it("passes on exit 0 and runs in the worktree with FHARA_* paths", async () => {
    const outcome = await runProjectScript({
      kind: "check",
      argv: [process.execPath, "-e", "console.log(process.cwd() === process.env.FHARA_WORKTREE_PATH ? 'ok' : 'bad')"],
      projectRoot: "/nonexistent-root",
      worktreePath: dir,
      allow: allowAll,
    });
    expect(outcome.status).toBe("passed");
    expect(outcome.tail).toContain("ok");
  }, 15_000);

  it("never runs an argv that is not on the allowlist", async () => {
    const outcome = await runProjectScript({ kind: "check", argv: ["npm", "run", "test", "--", "x"], projectRoot: dir });
    expect(outcome.status).toBe("blocked");
  });

  it("a missing script is not_configured: \"No check configured\"", async () => {
    const outcome = await runProjectScript({ kind: "check", argv: null, projectRoot: dir });
    expect(outcome.status).toBe("not_configured");
    expect(outcome.detail).toBe("No check configured");
  });

  it("scriptTail caps lines then characters", () => {
    const text = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    expect(scriptTail(text).split("\n")).toHaveLength(40);
    expect(scriptTail("y".repeat(10_000)).length).toBe(4_000);
  });
});

describe("host check after Done", () => {
  it("a project without a check posts \"No check configured\", never a pass", async () => {
    const api = fakeApi();
    await runHostCheckAfterDone(api as never, {
      taskId: "t1",
      projectId: "p1",
      scripts: undefined,
      projectRoot: dir,
      worktreePath: dir,
      agentOutcome: "passed",
    });
    const card = (api.postTaskCard.mock.calls[0] as unknown as [{ data: VerificationCardData }])[0].data;
    expect(card.hostCheck?.status).toBe("not_configured");
    expect(card.hostCheck?.detail).toBe("No check configured");
    expect(card.agentOutcome).toBe("passed");
    expect(card.outcome).not.toBe("passed");
  });

  it("the card outcome follows the host: timed_out and failed are failures", () => {
    expect(hostCheckOutcome("timed_out")).toBe("failed");
    expect(hostCheckOutcome("failed")).toBe("failed");
    expect(hostCheckOutcome("not_configured")).toBe("inconclusive");
    expect(hostCheckOutcome("blocked")).toBe("inconclusive");
    expect(hostCheckOutcome("passed")).toBe("passed");
  });

  it("runs the configured check in the worktree", async () => {
    const api = fakeApi();
    const run = vi.fn(async (): Promise<ProjectScriptOutcome> => ({ kind: "check", status: "passed", command: "npm run test", exitCode: 0, durationMs: 5 }));
    await runHostCheckAfterDone(
      api as never,
      { taskId: "t1", projectId: "p1", scripts: { check: ["npm", "run", "test"] }, projectRoot: "/repo", worktreePath: "/wt", agentOutcome: "failed" },
      run
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: "check", argv: ["npm", "run", "test"], worktreePath: "/wt" }));
    const card = (api.postTaskCard.mock.calls[0] as unknown as [{ data: VerificationCardData }])[0].data;
    expect(card.outcome).toBe("passed");
    expect(card.agentOutcome).toBe("failed");
  });
});

describe("setup on worktree create", () => {
  const ok = async (): Promise<ProjectScriptOutcome> => ({ kind: "setup", status: "passed", command: "npm ci", exitCode: 0, durationMs: 1 });

  it("runs the setup script when the worktree was just created", async () => {
    const api = fakeApi();
    const run = vi.fn(ok);
    const target = { taskId: "t1", projectId: "p1", scripts: { setup: ["npm", "ci"] }, projectRoot: "/repo", worktreePath: "/wt" };
    await runSetupOnWorktreeCreate(api as never, { ...target, created: true }, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: "setup", argv: ["npm", "ci"], worktreePath: "/wt" }));
    expect(api.logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "task.setup_script" }));
    expect(api.appendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not run on a reused worktree or without a setup script", async () => {
    const run = vi.fn(ok);
    const base = { taskId: "t1", projectId: "p1", projectRoot: "/repo", worktreePath: "/wt" };
    expect(await runSetupOnWorktreeCreate(fakeApi() as never, { ...base, scripts: { setup: ["npm", "ci"] }, created: false }, run)).toBeNull();
    expect(await runSetupOnWorktreeCreate(fakeApi() as never, { ...base, scripts: {}, created: true }, run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("a failed setup is reported in chat and the run continues", async () => {
    const api = fakeApi();
    const run = vi.fn(async (): Promise<ProjectScriptOutcome> => ({ kind: "setup", status: "failed", command: "npm ci", exitCode: 1, durationMs: 1 }));
    const outcome = await runSetupOnWorktreeCreate(
      api as never,
      { taskId: "t1", projectId: "p1", scripts: { setup: ["npm", "ci"] }, projectRoot: "/repo", worktreePath: "/wt", created: true },
      run
    );
    expect(outcome?.status).toBe("failed");
    expect(api.appendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("exit code 1") }));
  });
});
