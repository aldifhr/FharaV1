/**
 * Grounded chat: read-only repo tools the worker runs for the CTO's chat
 * reply. Invariants: no path escapes the repo (lexical or via symlink), no
 * secret / ignored location is listed or read, every output is capped, and
 * the queue worker runs a claimed call in the project's own workspace.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_TOOL_CAPS, runRepoToolLoop } from "@/api/convex/lib/chat/repoTools";
import { globToRegExp, guardRepoPath, runRepoReadTool } from "@/tools/repoRead";
import { processNextRepoToolCall } from "@/services/repoTools";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "repo-read-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "repo-outside-"));
  await fs.mkdir(path.join(root, "src/lib"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, "src/index.ts"), 'export const replyToChat = 1;\nconst x = "hello";\n');
  await fs.writeFile(path.join(root, "src/lib/util.ts"), "export function replyToChat() {}\n");
  await fs.writeFile(path.join(root, "README.md"), "# Repo\n");
  await fs.writeFile(path.join(root, ".env"), "LLM_API_KEY=sk-should-never-leak\n");
  await fs.writeFile(path.join(root, ".env.local"), "SECRET=1\n");
  await fs.writeFile(path.join(root, "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
  await fs.writeFile(path.join(root, "node_modules/pkg/index.js"), "replyToChat\n");
  await fs.writeFile(path.join(root, ".git/config"), "replyToChat\n");
  await fs.writeFile(path.join(root, "big.ts"), Array.from({ length: 1000 }, (_, i) => `const line${i} = "replyToChat ${"y".repeat(60)}";`).join("\n"));
  await fs.writeFile(path.join(outside, "secret.txt"), "outside replyToChat\n");
  await fs.symlink(outside, path.join(root, "linked")).catch(() => undefined);
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "src/escape.txt")).catch(() => undefined);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("guardRepoPath", () => {
  it("accepts repo-relative paths and the root", async () => {
    expect((await guardRepoPath(root, "src/index.ts")).relative).toBe("src/index.ts");
    expect((await guardRepoPath(root, "./src")).relative).toBe("src");
    expect((await guardRepoPath(root, "")).relative).toBe("");
  });

  it.each([
    ["../outside.txt"],
    ["src/../../etc/passwd"],
    ["/etc/passwd"],
    ["C:\\Windows\\system.ini"],
    [".env"],
    [".env.local"],
    ["config/.env.production"],
    ["node_modules/pkg/index.js"],
    [".git/config"],
    ["server.pem"],
    ["linked/secret.txt"],
    ["src/escape.txt"],
  ])("refuses %s", async (requested) => {
    await expect(guardRepoPath(root, requested)).rejects.toThrow();
    const res = await runRepoReadTool(root, "read_file", { path: requested });
    expect(res.ok).toBe(false);
    expect(res.text).not.toContain(root);
    expect(res.text).not.toContain("sk-should-never-leak");
  });
});

describe("list_files / grep / read_file", () => {
  it("list_files skips node_modules, .git, .env*, keys and symlinks; shows sizes", async () => {
    const res = await runRepoReadTool(root, "list_files", {});
    expect(res.ok).toBe(true);
    expect(res.text).toContain("src/index.ts (");
    expect(res.text).toMatch(/README\.md \(7 bytes\)/);
    for (const hidden of ["node_modules", ".git/", ".env", "server.pem", "linked", "escape.txt"]) {
      expect(res.text).not.toContain(hidden);
    }
  });

  it("list_files honours a glob", async () => {
    const res = await runRepoReadTool(root, "list_files", { path: "src", glob: "**/*.ts" });
    expect(res.text).toContain("src/lib/util.ts");
    expect(res.text).not.toContain("README.md");
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("lib/a.ts")).toBe(false);
  });

  it("grep finds matches with path:line and never searches ignored or secret files", async () => {
    const res = await runRepoReadTool(root, "grep", { pattern: "replyToChat", path: "src" });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("src/index.ts:1: export const replyToChat = 1;");
    expect(res.text).toContain("src/lib/util.ts:1:");
    const all = await runRepoReadTool(root, "grep", { pattern: "replyToChat|sk-should" });
    expect(all.text).not.toContain("node_modules");
    expect(all.text).not.toContain(".git/");
    expect(all.text).not.toContain("sk-should-never-leak");
    expect(all.text).not.toContain("outside replyToChat");
  });

  it("grep caps matches and line length", async () => {
    const res = await runRepoReadTool(root, "grep", { pattern: "replyToChat", glob: "big.ts" });
    const lines = res.text.split("\n").slice(1);
    expect(lines).toHaveLength(REPO_TOOL_CAPS.grepMaxMatches);
    expect(res.text).toMatch(/first 40; narrow the search/);
    expect(res.text.length).toBeLessThanOrEqual(REPO_TOOL_CAPS.resultMaxChars);
  });

  it("grep treats an invalid regex literally and rejects an empty or huge pattern", async () => {
    expect((await runRepoReadTool(root, "grep", { pattern: "replyToChat(" })).ok).toBe(true);
    expect((await runRepoReadTool(root, "grep", { pattern: "" })).ok).toBe(false);
    expect((await runRepoReadTool(root, "grep", { pattern: "a".repeat(500) })).ok).toBe(false);
  });

  it("read_file returns numbered lines plus size and total line count, capped", async () => {
    const res = await runRepoReadTool(root, "read_file", { path: "src/index.ts" });
    expect(res.ok).toBe(true);
    expect(res.files).toEqual(["src/index.ts"]);
    expect(res.text.split("\n")[0]).toMatch(/^src\/index\.ts: \d+ bytes, 3 lines$/);
    expect(res.text).toContain("1: export const replyToChat = 1;");

    const big = await runRepoReadTool(root, "read_file", { path: "big.ts", maxLines: 10_000 });
    const body = big.text.split("\n").slice(1);
    expect(body.length).toBeLessThanOrEqual(REPO_TOOL_CAPS.readMaxLines);
    expect(big.text.length).toBeLessThanOrEqual(REPO_TOOL_CAPS.readMaxBytes + 200);
    expect(big.text).toMatch(/1000 lines — showing lines 1-\d+; call again with startLine \d+/);

    const window = await runRepoReadTool(root, "read_file", { path: "big.ts", startLine: 500, maxLines: 3 });
    expect(window.text).toContain("500: const line499");
    expect(window.text.split("\n").slice(1)).toHaveLength(3);
  });

  it("read_file refuses directories and unknown tools are refused", async () => {
    expect((await runRepoReadTool(root, "read_file", { path: "src" })).ok).toBe(false);
    expect((await runRepoReadTool(root, "write_file", { path: "src/a.ts" })).ok).toBe(false);
    expect((await runRepoReadTool(root, "run_command", { command: "ls" })).ok).toBe(false);
  });
});

describe("processNextRepoToolCall", () => {
  it("runs a claimed call in the project workspace and reports the capped result", async () => {
    const completed: any[] = [];
    const api = {
      claimRepoToolCall: async () => ({
        callId: "c1",
        tool: "read_file",
        args: JSON.stringify({ path: "README.md" }),
        workspacePath: path.basename(root),
      }),
      completeRepoToolCall: async (input: any) => {
        completed.push(input);
        return true;
      },
    };
    const ran = await processNextRepoToolCall({
      api: api as any,
      workerId: "w1",
      workspaceRoot: path.dirname(root), // relative workspacePath resolves against it
      log: () => undefined,
    });
    expect(ran).toBe(true);
    expect(completed[0]).toMatchObject({ callId: "c1", workerId: "w1", ok: true, files: ["README.md"] });
    expect(completed[0].result).toContain("1: # Repo");
  });

  it("returns false when nothing is queued and fails a call without a workspace", async () => {
    expect(
      await processNextRepoToolCall({
        api: { claimRepoToolCall: async () => null, completeRepoToolCall: async () => true } as any,
        workerId: "w1",
        workspaceRoot: root,
        log: () => undefined,
      })
    ).toBe(false);
    const completed: any[] = [];
    await processNextRepoToolCall({
      api: {
        claimRepoToolCall: async () => ({ callId: "c2", tool: "list_files", args: "{}", workspacePath: null }),
        completeRepoToolCall: async (input: any) => (completed.push(input), true),
      } as any,
      workerId: "w1",
      workspaceRoot: root,
      log: () => undefined,
    });
    expect(completed[0]).toMatchObject({ ok: false });
  });
});

describe("grounded reply executor end to end (mocked LLM, real tools)", () => {
  it("grep → read_file → answer, with the files read recorded", async () => {
    const replies = [
      '{"tool":"grep","arguments":{"pattern":"replyToChat","path":"src"}}',
      '{"tool":"read_file","arguments":{"path":"src/lib/util.ts"}}',
      "replyToChat is defined in src/index.ts and src/lib/util.ts.",
    ];
    const prompts: string[] = [];
    let i = 0;
    const result = await runRepoToolLoop({
      messages: [{ role: "user", content: "where is replyToChat?" }],
      step: async (messages) => {
        prompts.push(messages.at(-1)!.content);
        return { content: replies[i++] };
      },
      callTool: (call) => runRepoReadTool(root, call.tool, call.args),
    });
    expect(result.answer).toBe("replyToChat is defined in src/index.ts and src/lib/util.ts.");
    expect(result.checkedFiles).toEqual(["src/lib/util.ts"]);
    expect(prompts[1]).toContain("src/index.ts:1: export const replyToChat = 1;");
    expect(prompts[2]).toContain("src/lib/util.ts: ");
  });
});
