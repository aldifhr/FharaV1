import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GlobalLLMConfig, LLMMessage, LLMProvider } from "@/llm";
import type { FallbackHandle } from "@/effects/llmCall";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { FileDiff } from "@/tools/gitDiff";
import { newSyntaxErrors, stagedSyntaxErrors, syntaxErrorsOf, syntaxRetryFeedback } from "@/execution/editGuards";
import { scopeViolations, testStrength } from "@/execution/scopeGuard";
import { newFilesOnlyFixWarning } from "@/services/runner/noTargetGuard";

/** R3 (multi-repo adoption): pre-approval syntax gate and test-weakening guard. */

const GOOD_TSX = "export function Card() {\n  return <div className=\"card\"><span>hi</span></div>;\n}\n";
const UNCLOSED_TSX = "export function Card() {\n  return <div className=\"card\"><span>hi</span>;\n}\n";

describe("syntaxErrorsOf", () => {
  it("flags an unclosed JSX tag in a .tsx file", () => {
    const issues = syntaxErrorsOf("src/Card.tsx", UNCLOSED_TSX);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({ filePath: "src/Card.tsx" });
    expect(syntaxErrorsOf("src/Card.tsx", GOOD_TSX)).toEqual([]);
  });

  it("checks .ts, .js (JSX allowed) and JSON; tsconfig comments are fine", () => {
    expect(syntaxErrorsOf("a.ts", "const x: number = ;")).not.toEqual([]);
    expect(syntaxErrorsOf("a.js", "const el = <b>x</b>;\n")).toEqual([]);
    expect(syntaxErrorsOf("data.json", "{\"a\": 1,}")).not.toEqual([]);
    expect(syntaxErrorsOf("tsconfig.json", "{\n  // comment\n  \"compilerOptions\": {},\n}\n")).toEqual([]);
    expect(syntaxErrorsOf("README.md", "<<<<")).toEqual([]);
    // Type errors are not syntax errors.
    expect(syntaxErrorsOf("a.ts", "const x: number = 's';")).toEqual([]);
  });

  it("counts only errors the edit introduced", () => {
    const broken = "const a = ;\n";
    expect(newSyntaxErrors("a.ts", `${broken}const b = 1;\n`, broken)).toEqual([]);
    expect(newSyntaxErrors("a.ts", `${broken}const b = ;\n`, broken)).toHaveLength(1);
  });

  it("the retry feedback marks the offending line", () => {
    const issues = syntaxErrorsOf("src/Card.tsx", UNCLOSED_TSX);
    const text = syntaxRetryFeedback(issues, new Map([["src/Card.tsx", UNCLOSED_TSX]]));
    expect(text).toContain("REJECTED before approval");
    expect(text).toContain("█");
  });

  it("flags a broken staged batch on the approval warning (forces an ask in auto-accept)", () => {
    const changes = [{ filePath: "src/Card.tsx", changeType: "modified", oldContent: GOOD_TSX, newContent: UNCLOSED_TSX }];
    expect(stagedSyntaxErrors(changes).length).toBeGreaterThan(0);
    expect(newFilesOnlyFixWarning("change the card", changes)).toMatch(/Syntax check/);
    expect(newFilesOnlyFixWarning("change the card", [{ ...changes[0], newContent: GOOD_TSX.replace("hi", "hello") }])).toBeNull();
  });
});

describe("test-weakening guard", () => {
  const TEST = "import { add } from './add';\ndescribe('add', () => {\n  it('adds', () => {\n    expect(add(1, 2)).toBe(3);\n    expect(add(0, 0)).toBe(0);\n  });\n});\n";

  it("counts skips, focuses and assertions outside comments", () => {
    expect(testStrength("it.skip('a', () => {}); xit('b'); // it.skip('c')\nfit('d', () => { expect(1).toBe(1); });")).toEqual({
      skips: 2,
      onlys: 1,
      assertions: 1,
    });
  });

  it("adding .skip / .only or dropping assertions flags the batch", () => {
    const skip = scopeViolations("make add faster", [{ filePath: "src/add.test.ts", changeType: "modified", oldContent: TEST, newContent: TEST.replace("it('adds'", "it.skip('adds'") }]);
    expect(skip.map((v) => v.code)).toEqual(["weakened_test"]);
    expect(skip[0].message).toMatch(/skipped test/);
    const only = scopeViolations("make add faster", [{ filePath: "src/add.test.ts", changeType: "modified", oldContent: TEST, newContent: TEST.replace("it('adds'", "it.only('adds'") }]);
    expect(only[0].message).toMatch(/focused test/);
    const fewer = scopeViolations("make add faster", [{ filePath: "src/add.test.ts", changeType: "modified", oldContent: TEST, newContent: TEST.replace("    expect(add(0, 0)).toBe(0);\n", "") }]);
    expect(fewer[0]).toMatchObject({ code: "weakened_test" });
    expect(fewer[0].message).toMatch(/removes 1 assertion/);
    // Deleting the test file is still the existing deleted_test finding.
    expect(scopeViolations("make add faster", [{ filePath: "src/add.test.ts", changeType: "deleted", oldContent: TEST }])[0].code).toBe("deleted_test");
    // ...and the approval warning carries it.
    expect(newFilesOnlyFixWarning("make add faster", [{ filePath: "src/add.test.ts", changeType: "modified", oldContent: TEST, newContent: TEST.replace("it('adds'", "it.skip('adds'") }])).toMatch(/weakens the existing tests/);
  });

  it("a request to skip the test, or a change to a non-test file, is not flagged", () => {
    expect(scopeViolations("skip the flaky add test", [{ filePath: "src/add.test.ts", changeType: "modified", oldContent: TEST, newContent: TEST.replace("it('adds'", "it.skip('adds'") }])).toEqual([]);
    expect(scopeViolations("make add faster", [{ filePath: "src/add.ts", changeType: "modified", oldContent: "export const add = (a, b) => a + b; // expect(1)\n", newContent: "export const add = (a, b) => b + a;\n" }])).toEqual([]);
    expect(scopeViolations("make add faster", [{ filePath: "src/add.test.ts", changeType: "modified", oldContent: TEST, newContent: TEST.replace("expect(add(1, 2)).toBe(3);", "expect(add(1, 2)).toBe(3);\n    expect(add(2, 2)).toBe(4);") }])).toEqual([]);
  });
});

describe("syntax gate in the implementer (one reflection, never an approval with broken files)", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-syntax-"));
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "Card.tsx"), GOOD_TSX);
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const config: GlobalLLMConfig = { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" };
  function input(provider: LLMProvider, saved: FileDiff[], events: Array<{ type: string; payload: any }>): SubtaskExecutionInput {
    const handle: FallbackHandle = { connectionId: "c", connectionName: "t", config, provider };
    return {
      workspacePath: workspace,
      command: "wrap the card text in a bold tag in src/Card.tsx",
      plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] },
      subtask: { key: "ui", title: "ui", description: "Bold card text in src/Card.tsx", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
      agent: { _id: "a", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] },
      llmHandles: [handle],
      priorOutputs: new Map(),
      fileChanges: [],
      getStagedChange: () => undefined,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10 * 60_000,
      onEvent: async (type: string, payload: any) => {
        events.push({ type, payload });
      },
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async (change) => {
        saved.push(change);
      },
    };
  }
  const FIXED = GOOD_TSX.replace("<span>hi</span>", "<span><b>hi</b></span>");
  const BROKEN = UNCLOSED_TSX.replace("<span>hi</span>", "<span><b>hi</b></span>");

  it("reflects the syntax errors once and stages the corrected answer", async () => {
    const prompts: string[] = [];
    const saved: FileDiff[] = [];
    const events: Array<{ type: string; payload: any }> = [];
    const provider: LLMProvider = {
      complete: async (messages: LLMMessage[]) => {
        prompts.push(messages.map((m) => m.content).join("\n"));
        return { content: JSON.stringify({ files: [{ filePath: "src/Card.tsx", newContent: prompts.length === 1 ? BROKEN : FIXED }] }) };
      },
    };
    const result = await executeSubtask(input(provider, saved, events));
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("do not parse (syntax errors)");
    expect(prompts[1]).toContain("src/Card.tsx:");
    expect(saved.at(-1)?.newContent).toBe(FIXED);
    expect(events.filter((e) => e.type === "syntax.error").map((e) => e.payload.attempt)).toEqual([1, 2]);
  });

  it("fails the subtask without staging anything when the retry still does not parse", async () => {
    const saved: FileDiff[] = [];
    const events: Array<{ type: string; payload: any }> = [];
    let calls = 0;
    const provider: LLMProvider = {
      complete: async () => {
        calls += 1;
        return { content: JSON.stringify({ files: [{ filePath: "src/Card.tsx", newContent: BROKEN }] }) };
      },
    };
    const result = await executeSubtask(input(provider, saved, events));
    expect(calls).toBe(2);
    expect(result.status).toBe("failed");
    expect((result as { error?: string }).error).toMatch(/Syntax check/);
    expect(saved).toHaveLength(0);
  });

  it("a clean answer makes no extra call", async () => {
    const saved: FileDiff[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      complete: async () => {
        calls += 1;
        return { content: JSON.stringify({ files: [{ filePath: "src/Card.tsx", newContent: FIXED }] }) };
      },
    };
    const result = await executeSubtask(input(provider, saved, []));
    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
  });
});
