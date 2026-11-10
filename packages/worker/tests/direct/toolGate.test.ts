import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { commandRule, describeToolCall, EDIT_RULE, gateToolCall, shellWords } from "@/direct/toolGate";
import { runsAsCodeByName } from "@/direct/codeWrites";
import { handoffNote } from "@/direct/handoff";

describe("shellWords", () => {
  it("plain commands become argv; anything needing a shell is null", () => {
    expect(shellWords("npm run test -- --watch=false")).toEqual(["npm", "run", "test", "--", "--watch=false"]);
    expect(shellWords(`git commit -m "fix #1; really"`)).toEqual(["git", "commit", "-m", "fix #1; really"]);
    expect(shellWords("echo 'a b'")).toEqual(["echo", "a b"]);
    for (const cmd of ["ls | sh", "a && b", "echo $HOME", "rm *.ts", "x > y", "FOO=1 npm test", "echo `id`", 'echo "$(id)"', "echo 'open"]) {
      expect(shellWords(cmd), cmd).toBeNull();
    }
  });
});

describe("describeToolCall", () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fhara-gate-")));
  it("a plain command gets a rule for its exact argv in its real folder", () => {
    const d = describeToolCall({ cwd, kind: "execute", rawInput: { command: "npm test", description: "tests" }, paths: [] });
    expect(d.request.argv).toEqual(["npm", "test"]);
    expect(d.request.ruleKey).toBe(commandRule(["npm", "test"], cwd));
    expect(JSON.parse(d.input)).toEqual({ command: "npm test", cwd });
  });
  it("an env or a second folder makes it inexact: no rule", () => {
    const d = describeToolCall({ cwd, kind: "execute", rawInput: { command: "npm test", env: { A: "1" } }, paths: [] });
    expect(d.request.ruleKey).toBeUndefined();
  });
  it("an edit to a file that runs as code is flagged and gets no edit rule", () => {
    const hook = describeToolCall({ cwd, kind: "edit", rawInput: { filePath: path.join(cwd, ".husky/pre-commit"), content: "x" }, paths: [path.join(cwd, ".husky/pre-commit")] });
    expect(hook.request.codeWrite).toBe(true);
    expect(hook.request.ruleKey).toBeUndefined();
    const plain = describeToolCall({ cwd, kind: "edit", rawInput: { filePath: path.join(cwd, "a.ts"), content: "x" }, paths: [path.join(cwd, "a.ts")] });
    expect(plain.request.codeWrite).toBeUndefined();
    expect(plain.request.ruleKey).toBe(EDIT_RULE);
  });
  it("a card too long to show whole is refused without asking", async () => {
    const d = describeToolCall({ cwd, kind: "edit", rawInput: { filePath: path.join(cwd, "a.ts"), content: "x".repeat(9000) }, paths: [path.join(cwd, "a.ts")] });
    expect(d.tooLong).toBeGreaterThan(8000);
    let asked = 0;
    const res = await gateToolCall(
      { requestApproval: async () => (asked++, { decision: "allow" }), note: () => undefined },
      { itemId: "i", description: d, signal: new AbortController().signal }
    );
    expect(res.allowed).toBe(false);
    expect(asked).toBe(0);
  });
});

describe("codeWrites", () => {
  it("knows Fhara's run-as-code files", () => {
    for (const f of ["/r/.opencode/plugin.ts", "/r/opencode.json", "/r/.husky/pre-push", "/r/package.json", "/r/.github/workflows/ci.yml", "/r/.git/hooks/pre-commit", "/r/.claude/settings.local.json", "/r/.mcp.json"]) {
      expect(runsAsCodeByName(f), f).toBe(true);
    }
    for (const f of ["/r/src/a.ts", "/r/README.md", "/r/.github/CODEOWNERS"]) expect(runsAsCodeByName(f), f).toBe(false);
  });
});

describe("handoff", () => {
  it("keeps the first and last messages and the work, skipping the turn being re-sent", () => {
    const note = handoffNote([
      { type: "user.message", sequence: 1, payload: { text: "first ask" } },
      { type: "tool.call", sequence: 2, payload: { itemId: "t", title: "npm test" } },
      { type: "tool.result", sequence: 3, payload: { itemId: "t", ok: false, text: "1 failing" } },
      { type: "edit.diff", sequence: 4, payload: { itemId: "t", path: "a.ts" } },
      { type: "assistant.text", sequence: 5, payload: { itemId: "a", text: "fixed it" } },
      { type: "user.message", sequence: 6, payload: { text: "now this" } },
    ], 6);
    expect(note).toContain("User: first ask");
    expect(note).toContain("Tool: npm test");
    expect(note).toContain("failed: 1 failing");
    expect(note).toContain("Edited: a.ts");
    expect(note).toContain("Assistant: fixed it");
    expect(note).not.toContain("now this");
  });
});
