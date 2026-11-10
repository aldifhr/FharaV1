import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/orchestrator/types";
import type { GlobalLLMConfig, LLMProvider } from "@/llm";
import type { LLMMessage } from "@/types/llm";
import type { FallbackHandle } from "@/effects/llmCall";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { FileDiff } from "@/tools/gitDiff";

/**
 * R2: SEARCH/REPLACE (Format C) answers through the REAL executeSubtask with
 * a fake provider: the staged result, the reflection round, the full-file
 * fallback, byte equality with the full-file path, and output size.
 */

const AGENT: AgentDefinition = {
  _id: "agent-implementer",
  name: "Implementer",
  role: "frontend",
  capabilities: ["frontend-development"],
  isEnabled: true,
  priority: 0,
};
const PLAN: ExecutionPlan = { version: 1, goal: "Edit big.ts", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] };
const SUBTASK: PlanSubtask = {
  key: "implement",
  title: "Implement",
  description: "Update src/big.ts",
  kind: "code_change",
  capability: "frontend-development",
  dependencies: [],
  order: 0,
};
const CONFIG: GlobalLLMConfig = { provider: "openai-compatible", model: "test-model", baseUrl: "http://127.0.0.1:9", apiKey: "k" };

const BIG = Array.from({ length: 2000 }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n";
const TARGET_OLD = "export const value1234 = 1234;";
const TARGET_NEW = "export const value1234 = 4321;";
const EXPECTED = BIG.replace(TARGET_OLD, TARGET_NEW);

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-r2-"));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "big.ts"), BIG);
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function editBlock(search: string, replace: string): string {
  return ["src/big.ts", "```ts", "<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE", "```"].join("\n");
}

function run(answers: string[]) {
  const seen: LLMMessage[][] = [];
  const staged: FileDiff[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const outputTokens: number[] = [];
  let budgetChecks = 0;
  const provider: LLMProvider = {
    complete: async (messages) => {
      seen.push(messages as LLMMessage[]);
      const content = answers[Math.min(seen.length - 1, answers.length - 1)];
      return { content };
    },
  };
  const handle: FallbackHandle = { connectionId: "c", connectionName: "t", config: CONFIG, provider };
  const input: SubtaskExecutionInput = {
    workspacePath: workspace,
    command: "Change value1234 to 4321 in src/big.ts",
    plan: PLAN,
    subtask: SUBTASK,
    agent: AGENT,
    llmHandles: [handle],
    priorOutputs: new Map(),
    fileChanges: [],
    signal: new AbortController().signal,
    onEvent: async (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    },
    onMessage: async () => undefined,
    onChunk: async () => undefined,
    saveFileChange: async (change) => {
      staged.push(change);
    },
    assertBudgetForCall: () => {
      budgetChecks += 1;
    },
    onTokenUsage: async (_input, output) => {
      outputTokens.push(output);
    },
  } as SubtaskExecutionInput;
  return { input, seen, staged, events, outputTokens, budget: () => budgetChecks };
}

describe("R2 SEARCH/REPLACE through executeSubtask", () => {
  it("stages the same bytes as the full-file answer, with >80% fewer output tokens", async () => {
    const edit = run([editBlock(TARGET_OLD, TARGET_NEW)]);
    const editResult = await executeSubtask(edit.input);
    expect(editResult.status).toBe("completed");
    expect(edit.staged).toHaveLength(1);
    expect(edit.staged[0].newContent).toBe(EXPECTED);

    const full = run([`FILE: src/big.ts\n\`\`\`\`\n${EXPECTED}\`\`\`\`\n`]);
    const fullResult = await executeSubtask(full.input);
    expect(fullResult.status).toBe("completed");
    expect(full.staged[0].newContent).toBe(edit.staged[0].newContent);
    expect(full.staged[0].newContentHash).toBe(edit.staged[0].newContentHash);

    const editTokens = edit.outputTokens.reduce((a, b) => a + b, 0);
    const fullTokens = full.outputTokens.reduce((a, b) => a + b, 0);
    expect(editTokens).toBeGreaterThan(0);
    expect(editTokens).toBeLessThan(fullTokens * 0.2);
  });

  it("the prompt recommends Format C for existing files", async () => {
    const edit = run([editBlock(TARGET_OLD, TARGET_NEW)]);
    await executeSubtask(edit.input);
    const user = edit.seen[0].find((m) => m.role === "user")!.content as string;
    expect(user).toContain("Format C (SEARCH/REPLACE blocks) — RECOMMENDED for changing EXISTING files");
  });

  it("a miss gets one reflection with similar lines, then applies", async () => {
    const wrong = editBlock("export const value1234 = 9999;\nexport const value1235 = 1235;\nexport const value1236 = 1236;", "x");
    const right = editBlock(TARGET_OLD, TARGET_NEW);
    const r = run([wrong, right]);
    const result = await executeSubtask(r.input);
    expect(result.status).toBe("completed");
    expect(r.seen).toHaveLength(2);
    const reflection = r.seen[1];
    expect(reflection.at(-2)).toMatchObject({ role: "assistant" });
    const feedback = reflection.at(-1)!.content as string;
    expect(feedback).toContain("SearchReplaceNoExactMatch");
    expect(feedback).toContain("Did you mean to match some of these actual lines from src/big.ts?");
    expect(feedback).toContain("export const value1235 = 1235;");
    expect(r.staged[0].newContent).toBe(EXPECTED);
    expect(r.budget()).toBe(2);
  });

  it("an ambiguous match is refused with a line list and reflected", async () => {
    await fs.writeFile(path.join(workspace, "src", "big.ts"), "a();\nb();\na();\n");
    const ambiguous = editBlock("a();", "c();");
    const fixed = editBlock("a();\nb();", "c();\nb();");
    const r = run([ambiguous, fixed]);
    const result = await executeSubtask(r.input);
    expect(result.status).toBe("completed");
    expect(r.seen[1].at(-1)!.content).toContain("matches at lines 1, 3");
    expect(r.staged[0].newContent).toBe("c();\nb();\na();\n");
  });

  it("after the reflection rounds still miss, the full-file fallback lands", async () => {
    const wrong = editBlock("nothing like this line\nor this one\nat all", "x");
    const fullAnswer = `FILE: src/big.ts\n\`\`\`\`\n${EXPECTED}\`\`\`\`\n`;
    const r = run([wrong, wrong, wrong, fullAnswer]);
    const result = await executeSubtask(r.input);
    expect(result.status).toBe("completed");
    expect(r.seen).toHaveLength(4);
    const last = r.seen[3].find((m) => m.role === "user")!.content as string;
    expect(last).toContain("Do NOT use SEARCH/REPLACE blocks now");
    expect(r.staged[0].newContent).toBe(EXPECTED);
    expect(r.events.some((e) => e.type === "agent.edit_blocks" && e.payload.fallback === "full-file" && e.payload.ok === true)).toBe(true);
  });

  it("fails clearly when the fallback does not return the file", async () => {
    const wrong = editBlock("nothing like this line\nor this one\nat all", "x");
    const r = run([wrong, wrong, wrong, '{"files":[]}']);
    const result = await executeSubtask(r.input);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error).toContain("full-file fallback did not return src/big.ts");
    expect(r.staged).toHaveLength(0);
  });
});
