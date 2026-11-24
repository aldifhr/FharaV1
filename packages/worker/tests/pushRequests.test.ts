import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePushRequest, type PushClaim } from "@/services/pushRequests";
import { githubAuthEnv, redactSecret, type ExecGit } from "@/tools/gitPush";
import { describeCommit } from "@/tools/gitWorktree";

const TOKEN = "gho_supersecrettoken1234567890abcdef";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function claim(overrides: Partial<PushClaim> = {}): PushClaim {
  return {
    pushId: "push1",
    taskId: "task1",
    projectId: "proj1",
    workspacePath: "/repo",
    branchName: "fhara/task1/dark-mode",
    commitSha: SHA,
    openPr: true,
    existingPrNumber: undefined,
    owner: "acme",
    repo: "app",
    baseBranch: "develop",
    token: TOKEN,
    prTitle: "Add dark mode",
    prBody: "## Summary",
    ...overrides,
  } as PushClaim;
}

function harness(options: {
  pushFails?: boolean;
  prStatus?: number;
  prBody?: unknown;
  origin?: string;
  defaultBranch?: string;
  baseBranches?: string[];
  remoteBranches?: string[];
} = {}) {
  const gitCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const execGit: ExecGit = vi.fn(async (args, opts) => {
    gitCalls.push({ args, env: opts.env });
    if (args[0] === "remote") return { stdout: options.origin ?? "", stderr: "" };
    if (args[0] === "rev-parse" && args[3]?.startsWith("refs/")) {
      const name = args[3].split("/").pop() ?? "";
      if (!options.baseBranches?.includes(name)) throw new Error("not found");
      return { stdout: `${SHA}\n`, stderr: "" };
    }
    if (args[0] === "push" && options.pushFails) {
      throw new Error(`remote: Permission denied. Authorization: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")} token ${TOKEN}`);
    }
    return { stdout: "", stderr: "" };
  });
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ default_branch: options.defaultBranch ?? "main" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const branchMatch = url.match(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/branches\/([^/]+)$/);
    if (branchMatch) {
      const exists = options.remoteBranches
        ? options.remoteBranches.includes(decodeURIComponent(branchMatch[1]))
        : options.baseBranches?.includes(decodeURIComponent(branchMatch[1]));
      return new Response(exists ? "{}" : JSON.stringify({ message: "Branch not found" }), {
        status: exists ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify(
        options.prBody ?? {
          number: 7,
          html_url: "https://github.com/acme/app/pull/7",
          title: "Add dark mode",
          state: "open",
          draft: true,
        }
      ),
      { status: options.prStatus ?? 201, headers: { "Content-Type": "application/json" } }
    );
  });
  const completed: any[] = [];
  const api = {
    claimPushRequest: vi.fn(),
    completePushRequest: vi.fn(async (input: any) => {
      completed.push(input);
      return { applied: true };
    }),
  };
  const logs: string[] = [];
  const log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  return { gitCalls, execGit, fetchCalls, fetchImpl, api, completed, logs, log };
}

describe("handlePushRequest", () => {
  it("pushes the sha with the token only in the environment and opens a draft PR", async () => {
    const h = harness();
    await handlePushRequest(claim(), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    const push = h.gitCalls.find((call) => call.args[0] === "push")!;
    expect(push.args).toEqual([
      "push",
      "--porcelain",
      "https://github.com/acme/app.git",
      `${SHA}:refs/heads/fhara/task1/dark-mode`,
    ]);
    // Token never in argv; present only as the extraheader env value.
    for (const call of h.gitCalls) expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(push.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(push.env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`
    );
    expect(push.env.GIT_TERMINAL_PROMPT).toBe("0");

    const create = h.fetchCalls[0];
    expect(create.url).toBe("https://api.github.com/repos/acme/app/pulls");
    expect(JSON.parse(String(create.init?.body))).toMatchObject({
      head: "fhara/task1/dark-mode",
      base: "develop",
      draft: true,
      title: "Add dark mode",
    });
    expect(h.completed).toEqual([
      {
        pushId: "push1",
        workerId: "w1",
        outcome: "pushed",
        repoFullName: "acme/app",
        baseBranch: "develop",
        pr: { number: 7, url: "https://github.com/acme/app/pull/7", title: "Add dark mode", state: "draft" },
        // O8: the mock git has no base ref, so the dependency check is skipped (never fails the push).
        dependencyCheck: { status: "skipped", high: 0, summary: "base branch develop is not available locally" },
      },
    ]);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });

  it("uses the workspace Git origin when the claim has no pinned repository", async () => {
    const h = harness({ origin: "git@github.com:acme/app.git\n" });
    await handlePushRequest(claim({ owner: undefined, repo: undefined, workspacePath: tmpdir() }), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.gitCalls.find((call) => call.args[0] === "remote")?.args).toEqual(["remote", "get-url", "origin"]);
    expect(h.gitCalls.find((call) => call.args[0] === "push")?.args[2]).toBe("https://github.com/acme/app.git");
    expect(h.completed[0]).toMatchObject({ outcome: "pushed", repoFullName: "acme/app" });
  });

  it("uses GitHub's default branch when an unpinned claim has no base branch", async () => {
    const h = harness({ origin: "https://github.com/acme/app.git", defaultBranch: "trunk" });
    await handlePushRequest(
      claim({ owner: undefined, repo: undefined, baseBranch: undefined, workspacePath: tmpdir() }),
      {
        api: h.api as any,
        workerId: "w1",
        workspaceRoot: "/ws",
        log: h.log,
        execGit: h.execGit,
        fetchImpl: h.fetchImpl as any,
      }
    );
    expect(h.fetchCalls[0].url).toBe("https://api.github.com/repos/acme/app");
    const create = h.fetchCalls.find((call) => call.url.endsWith("/pulls"))!;
    expect(JSON.parse(String(create.init?.body)).base).toBe("trunk");
    expect(h.completed[0]).toMatchObject({ outcome: "pushed", baseBranch: "trunk" });
  });

  it("falls back to a local trunk when GitHub's default branch is the task branch", async () => {
    const unpinned = claim({ owner: undefined, repo: undefined, baseBranch: undefined, workspacePath: tmpdir() });
    const h = harness({
      origin: "https://github.com/acme/app.git",
      defaultBranch: unpinned.branchName,
      baseBranches: ["master"],
    });
    await handlePushRequest(unpinned, {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    const create = h.fetchCalls.find((call) => call.url.endsWith("/pulls"))!;
    expect(JSON.parse(String(create.init?.body)).base).toBe("master");
    expect(h.completed[0]).toMatchObject({ outcome: "pushed", baseBranch: "master" });
  });

  it("refuses a local trunk that does not exist on GitHub", async () => {
    const unpinned = claim({ owner: undefined, repo: undefined, baseBranch: undefined, workspacePath: tmpdir() });
    const h = harness({
      origin: "https://github.com/acme/app.git",
      defaultBranch: unpinned.branchName,
      baseBranches: ["master"],
      remoteBranches: [],
    });
    await handlePushRequest(unpinned, {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.completed[0]).toMatchObject({ outcome: "failed" });
    expect(h.completed[0].error).toMatch(/no "master" branch on GitHub/);
    expect(h.gitCalls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("surfaces GitHub's field-level 422 detail", async () => {
    const h = harness({
      prStatus: 422,
      prBody: { message: "Validation Failed", errors: [{ field: "base", code: "invalid" }] },
    });
    await handlePushRequest(claim({ openPr: true }), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.completed[0]).toMatchObject({ outcome: "pushed" });
    expect(h.completed[0].error).toMatch(/field base invalid/);
  });

  it("fails clearly when the workspace has no usable GitHub origin", async () => {
    const h = harness({ origin: "/srv/git/not-github.git\n" });
    await handlePushRequest(claim({ owner: undefined, repo: undefined, workspacePath: tmpdir() }), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.completed[0]).toMatchObject({ outcome: "failed" });
    expect(h.completed[0].error).toMatch(/no GitHub origin remote/);
    expect(h.gitCalls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("O8: sends a failed dependencyCheck when the pushed commit adds a typosquatted dependency", async () => {
    const h = harness();
    const BASE = "b".repeat(40);
    const before = JSON.stringify({ dependencies: { react: "18.2.0" } });
    const after = JSON.stringify({ dependencies: { react: "18.2.0", lodahs: "4.17.21" } });
    const execGit: ExecGit = vi.fn(async (args) => {
      if (args[0] === "rev-parse") return { stdout: args[3].startsWith("refs/remotes/origin/develop") ? `${BASE}\n` : "", stderr: "" };
      if (args[0] === "merge-base") return { stdout: `${BASE}\n`, stderr: "" };
      if (args[0] === "diff") return { stdout: "M\0package.json\0M\0package-lock.json\0", stderr: "" };
      if (args[0] === "show") return { stdout: args[1].startsWith(BASE) ? before : after, stderr: "" };
      if (args[0] === "ls-tree") return { stdout: "package-lock.json\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await handlePushRequest(claim({ openPr: false }), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.completed[0]).toMatchObject({ outcome: "pushed", dependencyCheck: { status: "failed", high: 1 } });
    expect(h.completed[0].dependencyCheck.summary).toContain("lodahs");
  });

  it("push only: no PR call", async () => {
    const h = harness();
    await handlePushRequest(claim({ openPr: false }), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.completed[0]).toMatchObject({ outcome: "pushed" });
    expect(h.completed[0].pr).toBeUndefined();
  });

  it("reports a redacted failure when git push fails", async () => {
    const h = harness({ pushFails: true });
    await handlePushRequest(claim(), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.completed).toHaveLength(1);
    expect(h.completed[0].outcome).toBe("failed");
    expect(h.completed[0].error).toMatch(/git push failed/);
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    for (const text of [h.completed[0].error, ...h.logs]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(b64);
    }
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("reports a failure when opening the PR fails, without the token", async () => {
    const h = harness({ prStatus: 403, prBody: { message: `Resource not accessible ${TOKEN}` } });
    await handlePushRequest(claim(), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    // The push landed; the PR error is kept on the card for a PR-only retry.
    expect(h.completed[0].outcome).toBe("pushed");
    expect(h.completed[0].error).toMatch(/403/);
    expect(h.completed[0].error).not.toContain(TOKEN);
  });

  it("opens only the PR on a retry when the commit is already pushed", async () => {
    const h = harness();
    await handlePushRequest(claim({ alreadyPushed: true }), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.gitCalls.some((call) => call.args[0] === "push")).toBe(false);
    expect(h.fetchCalls.some((call) => call.url.endsWith("/pulls"))).toBe(true);
    expect(h.completed[0]).toMatchObject({ outcome: "pushed", repoFullName: "acme/app" });
  });

  it("refuses an unsafe branch name before running git push", async () => {
    const h = harness();
    await handlePushRequest(claim({ branchName: "--upload-pack=evil" }), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: h.fetchImpl as any,
    });
    expect(h.gitCalls.some((call) => call.args[0] === "push")).toBe(false);
    expect(h.completed[0]).toMatchObject({ outcome: "failed" });
  });

  it("reuses an existing PR when GitHub says one already exists", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:b." }] }), { status: 422 });
      }
      return new Response(
        JSON.stringify([{ number: 3, html_url: "https://github.com/acme/app/pull/3", title: "T", state: "open", draft: false }]),
        { status: 200 }
      );
    });
    const h = harness();
    await handlePushRequest(claim(), {
      api: h.api as any,
      workerId: "w1",
      workspaceRoot: "/ws",
      log: h.log,
      execGit: h.execGit,
      fetchImpl: fetchImpl as any,
    });
    expect(calls[1]).toMatch(/^GET .*pulls\?head=acme%3Afhara%2Ftask1%2Fdark-mode/);
    expect(h.completed[0].pr).toMatchObject({ number: 3, state: "open" });
  });
});

describe("gitPush helpers", () => {
  it("githubAuthEnv drops inherited GIT_CONFIG_* entries", () => {
    const env = githubAuthEnv(TOKEN, { PATH: "/bin", GIT_CONFIG_COUNT: "5", GIT_CONFIG_KEY_4: "x" });
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_4).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("redactSecret removes the raw and base64 token and token-shaped strings", () => {
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    const out = redactSecret(`a ${TOKEN} b ${b64} c ghp_${"x".repeat(36)}`, TOKEN);
    expect(out).toBe("a *** b *** c ***");
  });
});

describe("describeCommit", () => {
  it("reports sha, files, line counts and ahead/behind against the base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fhara-describe-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
    try {
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "t@t"]);
      git(["config", "user.name", "t"]);
      writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
      git(["add", "."]);
      git(["commit", "-q", "-m", "base"]);
      git(["checkout", "-q", "-b", "task"]);
      writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");
      writeFileSync(join(dir, "b.txt"), "new\n");
      git(["add", "."]);
      git(["commit", "-q", "-m", "Fhara: change"]);
      const summary = await describeCommit(dir, "main");
      expect(summary.sha).toBe(git(["rev-parse", "HEAD"]).trim());
      expect(summary.message).toBe("Fhara: change");
      expect(summary).toMatchObject({ filesChanged: 2, additions: 3, deletions: 1, ahead: 1, behind: 0, comparedTo: "main" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
