import { describe, expect, it, vi } from "vitest";
import { handlePushRequest, type PushClaim } from "@/services/pushRequests";
import type { ExecGit } from "@/tools/gitPush";
import { buildAccessLogEntry, sanitizeAccessLogArgs, sanitizeAccessLogText, withAccessLog, type AccessLogEntry } from "@/utils/accessLog";

const TOKEN = "gho_supersecrettoken1234567890abcdef";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

describe("O5 access-log sanitizer (vigilante port)", () => {
  it("argv snapshot", () => {
    expect(
      sanitizeAccessLogArgs([
        "--token",
        "abc",
        "-H",
        "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "GH_TOKEN=ghs_abcdefghijklmnop1234",
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${B64}`,
        `https://x-access-token:${TOKEN}@github.com/acme/app.git`,
        "sk-proj-abcdefghijklmnopqrstuvwx",
        "--password=hunter22",
        "push",
        "--porcelain",
        "origin",
      ])
    ).toMatchInlineSnapshot(`
      [
        "--token",
        "<redacted>",
        "-H",
        "<redacted>",
        "GH_TOKEN=<redacted>",
        "-c",
        "http.https://github.com/.extraheader=<redacted>",
        "https://<redacted>@github.com/acme/app.git",
        "<redacted>",
        "--password=<redacted>",
        "push",
        "--porcelain",
        "origin",
      ]
    `);
  });

  it("text: headers, x-access-token, assignments, token shapes and known values", () => {
    const out = sanitizeAccessLogText(
      `remote: denied. Authorization: basic ${B64} token ${TOKEN} GITHUB_TOKEN=xyz12345 x-access-token:${TOKEN} plain-SECRET-VALUE-9`,
      ["plain-SECRET-VALUE-9"]
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(B64);
    expect(out).not.toContain("xyz12345");
    expect(out).not.toContain("plain-SECRET-VALUE-9");
    expect(out).toContain("<redacted>");
    expect(sanitizeAccessLogText("git push failed: rejected (non-fast-forward)")).toBe("git push failed: rejected (non-fast-forward)");
  });

  it("entry: exit code, duration, failure kind, truncated detail", () => {
    const err = Object.assign(new Error("Command failed"), { code: 128 });
    const e = buildAccessLogEntry({ tool: "git", args: ["push"], startedAt: 1000, endedAt: 1250, error: err, output: "x".repeat(400) });
    expect(e).toMatchObject({ exitCode: 128, durationMs: 250, success: false, failureKind: "exit_error" });
    expect(e.error!.endsWith("...(truncated)")).toBe(true);
  });

  it("withAccessLog emits once on success and on failure, and rethrows", async () => {
    const rows: AccessLogEntry[] = [];
    await withAccessLog({ tool: "git", args: ["status"], recorder: (r) => void rows.push(r) }, async () => "ok");
    await expect(
      withAccessLog({ tool: "git", args: ["push"], recorder: (r) => void rows.push(r) }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // A recorder that throws never breaks the command.
    await withAccessLog({ tool: "git", args: ["x"], recorder: () => { throw new Error("sink down"); } }, async () => 1);
    expect(rows.map((r) => r.success)).toEqual([true, false]);
  });
});

describe("O5 push and PR leave one cmd row each, without secrets", () => {
  function claim(): PushClaim {
    return {
      pushId: "push1",
      taskId: "task1",
      projectId: "proj1",
      workspacePath: "/repo",
      branchName: "fhara/task1/x",
      commitSha: SHA,
      openPr: true,
      existingPrNumber: undefined,
      owner: "acme",
      repo: "app",
      baseBranch: "develop",
      token: TOKEN,
      prTitle: "T",
      prBody: "B",
    } as PushClaim;
  }

  it("records cat-file, push and the PR create with exit code and duration", async () => {
    const execGit: ExecGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ number: 7, html_url: "https://github.com/acme/app/pull/7", title: "T", state: "open", draft: true }), { status: 201 })
    );
    const audits: any[] = [];
    const api = {
      claimPushRequest: vi.fn(),
      completePushRequest: vi.fn(async () => ({ applied: true })),
      recordAudit: vi.fn(async (row: any) => void audits.push(row)),
    };
    await handlePushRequest(claim(), { api: api as any, workerId: "w1", workspaceRoot: "/ws", log: () => {}, execGit, fetchImpl: fetchImpl as any });
    expect(audits.map((a) => a.action)).toEqual(["cmd.git", "cmd.git", "cmd.github-api"]);
    for (const a of audits) {
      expect(a).toMatchObject({ tool: "cmd", actor: "worker", decision: "recorded", taskId: "task1", projectId: "proj1", workerId: "w1" });
      expect(typeof a.details.exitCode).toBe("number");
      expect(typeof a.details.durationMs).toBe("number");
    }
    expect(audits[1].details.argv[0]).toBe("push");
    expect(audits[2].details.exitCode).toBe(0);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it("a failed push row carries the exit code and a redacted error", async () => {
    const execGit: ExecGit = vi.fn(async (args) => {
      if (args[0] === "push") throw Object.assign(new Error(`remote: denied Authorization: basic ${B64} token ${TOKEN}`), { code: 128 });
      return { stdout: "", stderr: "" };
    });
    const audits: any[] = [];
    const api = {
      claimPushRequest: vi.fn(),
      completePushRequest: vi.fn(async () => ({ applied: true })),
      recordAudit: vi.fn(async (row: any) => void audits.push(row)),
    };
    await handlePushRequest(claim(), { api: api as any, workerId: "w1", workspaceRoot: "/ws", log: () => {}, execGit });
    const push = audits.find((a) => a.details.argv[0] === "push");
    expect(push.details).toMatchObject({ exitCode: 128, success: false, failureKind: "exit_error" });
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    expect(JSON.stringify(audits)).not.toContain(B64);
  });
});
