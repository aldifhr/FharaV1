import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { allowedCommandLines, ALLOWED_ARGV, isCommandAllowed } from "@/utils/commandAllowlist";
import * as runCommandModule from "@/tools/runCommand";
import { parseShellReply, shellInstruction, shellRegistryList, shellRepairContent } from "@/prompts/shell";
import { classifyCommand, detectRunCommands } from "@/orchestrator/classifier";
import { validatePlan } from "@/orchestrator/planValidator";
import { buildPlanningPrompt, heuristicPlan } from "@/orchestrator/planner";
import { loadPolicy } from "@/orchestrator/policy";
import { routeMessage } from "@/router/route";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { FallbackHandle } from "@/effects/llmCall";
import type { GlobalLLMConfig, LLMProvider } from "@/llm";
import type { AgentDefinition, ExecutionPlan, LLMMessage, PlanSubtask } from "@/types";

const POLICY = loadPolicy();

// Live test: the shell agent's prompt listed only git commands while the
// executor also allows npm run test/build/typecheck, npx tsc --noEmit and
// node --version; the model refused "npm run test" in prose and the task
// failed with "Shell agent did not return a valid command JSON".
describe("shell prompt is generated from the executor's allowlist", () => {
  it("lists every allowlisted command line, including npm/npx/node", () => {
    const list = shellRegistryList();
    for (const line of allowedCommandLines()) expect(list).toContain(`- ${line}`);
    expect(list).toContain("- npm run test");
    expect(list).toContain("- npm run build");
    expect(list).toContain("- npm run typecheck");
    expect(list).toContain("- npx tsc --noEmit");
    expect(list).toContain("- node --version");
    expect(shellInstruction()).toContain(list);
  });

  it("runCommand enforces the same allowlist object", () => {
    expect(runCommandModule.ALLOWED_ARGV).toBe(ALLOWED_ARGV);
    expect(runCommandModule.isCommandAllowed).toBe(isCommandAllowed);
    for (const line of allowedCommandLines()) {
      const [command, ...args] = line.split(" ");
      expect(runCommandModule.isCommandAllowed(command, args)).toBe(true);
    }
  });

  it("states the strict JSON contract and the refusal shape", () => {
    const instruction = shellInstruction();
    expect(instruction).toContain('{"command":"<binary>","args":["<arg>", ...]}');
    expect(instruction).toContain('{"command":null,"reason":"<one line>"}');
    expect(shellRepairContent("I cannot run npm")).toContain("Previous reply: I cannot run npm");
    expect(shellRepairContent("")).toContain("Schema:");
  });
});

describe("parseShellReply", () => {
  it("accepts the contract, with or without a code fence", () => {
    expect(parseShellReply('{"command":"npm","args":["run","test"]}')).toEqual({ kind: "command", command: "npm", args: ["run", "test"] });
    expect(parseShellReply('```json\n{"command":"git","args":["status"]}\n```')).toEqual({ kind: "command", command: "git", args: ["status"] });
  });

  it("an explicit null command is a refusal", () => {
    expect(parseShellReply('{"command":null,"reason":"needs file writes"}')).toEqual({ kind: "refusal", reason: "needs file writes" });
  });

  it("prose, broken JSON and wrong shapes are invalid", () => {
    expect(parseShellReply("I'm sorry, I can only run git commands.")).toBeNull();
    expect(parseShellReply("{command: npm}")).toBeNull();
    expect(parseShellReply('{"command":"npm","args":"run test"}')).toBeNull();
    expect(parseShellReply('{"command":"npm","args":["run",1]}')).toBeNull();
    expect(parseShellReply('{"command":"","args":[]}')).toBeNull();
    expect(parseShellReply("")).toBeNull();
  });
});

// ─── Executor: one repair round before failing ─────────────────────────────

const AGENT: AgentDefinition = {
  _id: "agent-devops",
  name: "DevOps",
  role: "devops",
  capabilities: ["shell-execution"],
  isEnabled: true,
  priority: 0,
};
const SUBTASK: PlanSubtask = {
  key: "run-node-version",
  title: "Run node --version",
  description: "Run exactly: node --version",
  kind: "shell",
  capability: "shell-execution",
  dependencies: [],
  order: 0,
};
const PLAN: ExecutionPlan = { version: 1, goal: "print node version", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [SUBTASK] };
const CONFIG: GlobalLLMConfig = { provider: "openai-compatible", model: "test-model", baseUrl: "http://127.0.0.1:9", apiKey: "test-key" };

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-shell-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function scripted(replies: string[]): { provider: LLMProvider; calls: LLMMessage[][] } {
  const calls: LLMMessage[][] = [];
  const provider: LLMProvider = {
    complete: async (messages) => {
      calls.push(messages.map((m) => ({ ...m })));
      return { content: replies[Math.min(calls.length - 1, replies.length - 1)], inputTokens: 1, outputTokens: 1 };
    },
  };
  return { provider, calls };
}

function shellInput(provider: LLMProvider, events: string[] = []): SubtaskExecutionInput {
  const handle: FallbackHandle = { connectionId: "c1", connectionName: "test", config: CONFIG, provider };
  return {
    workspacePath: workspace,
    command: "print the node version",
    plan: PLAN,
    subtask: SUBTASK,
    agent: AGENT,
    llmHandles: [handle],
    priorOutputs: new Map(),
    fileChanges: [],
    signal: new AbortController().signal,
    onEvent: async (type: string) => {
      events.push(type);
    },
    onMessage: async () => undefined,
    onChunk: async () => undefined,
    saveFileChange: async () => undefined,
  } as SubtaskExecutionInput;
}

type Outcome = Awaited<ReturnType<typeof executeSubtask>>;
const outputOf = (result: Outcome) => (result.status === "completed" ? result.output ?? "" : "");
const errorOf = (result: Outcome) => (result.status === "failed" ? result.error : "");

describe("executeShell: JSON repair", () => {
  it("valid JSON on the first reply runs without a repair call", async () => {
    const { provider, calls } = scripted(['{"command":"node","args":["--version"]}']);
    const result = await executeSubtask(shellInput(provider));
    expect(result.status).toBe("completed");
    expect(outputOf(result)).toContain("$ node --version");
    expect(outputOf(result)).toMatch(/v\d+\./);
    expect(calls).toHaveLength(1);
    // The subtask's own instruction reaches the agent, with the user request.
    expect(calls[0].at(-1)?.content).toContain("Run exactly: node --version");
    expect(calls[0].at(-1)?.content).toContain("- npm run test");
  });

  it("prose first, JSON on the repair round: runs the command", async () => {
    const events: string[] = [];
    const { provider, calls } = scripted([
      "I can only run git commands, so I cannot run that.",
      '{"command":"node","args":["--version"]}',
    ]);
    const result = await executeSubtask(shellInput(provider, events));
    expect(result.status).toBe("completed");
    expect(outputOf(result)).toContain("$ node --version");
    expect(calls).toHaveLength(2);
    const repair = calls[1];
    expect(repair.at(-2)).toEqual({ role: "assistant", content: "I can only run git commands, so I cannot run that." });
    expect(repair.at(-1)?.role).toBe("user");
    expect(repair.at(-1)?.content).toContain('Schema: {"command":"<binary>","args":["<arg>", ...]}');
    expect(events).toContain("shell.reply_repair");
  });

  it("still invalid after the repair round: fails, exactly two calls", async () => {
    const { provider, calls } = scripted(["no.", "still no."]);
    const result = await executeSubtask(shellInput(provider));
    expect(result.status).toBe("failed");
    expect(errorOf(result)).toContain("Shell agent did not return a valid command JSON (after one repair attempt)");
    expect(calls).toHaveLength(2);
  });

  it("an explicit refusal fails at once with its reason (no repair)", async () => {
    const { provider, calls } = scripted(['{"command":null,"reason":"needs a file write"}']);
    const result = await executeSubtask(shellInput(provider));
    expect(result.status).toBe("failed");
    expect(errorOf(result)).toContain("no allowlisted command for this task: needs a file write");
    expect(calls).toHaveLength(1);
  });

  it("a non-allowlisted argv is still blocked after parsing", async () => {
    const { provider } = scripted(['{"command":"npm","args":["run","test","--","--watch"]}']);
    const result = await executeSubtask(shellInput(provider));
    expect(result.status).toBe("failed");
    expect(errorOf(result)).toContain("Command blocked (not allowlisted)");
  });
});

// ─── Classifier / validatePlan: run requests are shell tasks ───────────────

// Live test: "run npm test" / "jalankan tes" were planned as code_change (one
// failed "no file changes", another wrote TEST_REPORT.md saying the tests
// were not executed).
describe("classifier: run requests become command tasks", () => {
  const cases: Array<[string, string[]]> = [
    ["run npm test", ["npm run test"]],
    ["Run the tests", ["npm run test"]],
    ["please run the unit tests", ["npm run test"]],
    ["npm run test", ["npm run test"]],
    ["npm test", ["npm run test"]],
    ["run npm run build", ["npm run build"]],
    ["run the build", ["npm run build"]],
    ["run typecheck", ["npm run typecheck"]],
    ["run tsc", ["npx tsc --noEmit"]],
    ["npx tsc --noEmit", ["npx tsc --noEmit"]],
    ["can you run the tests?", ["npm run test"]],
    ["jalankan tes", ["npm run test"]],
    ["Jalankan testnya", ["npm run test"]],
    ["tolong jalankan semua tes sekarang", ["npm run test"]],
    ["jalankan npm test", ["npm run test"]],
    ["jalanin build", ["npm run build"]],
    ["jalankan typecheck lalu tes", ["npm run typecheck", "npm run test"]],
    ["run the tests and the build", ["npm run test", "npm run build"]],
    ["jalankan tes, jangan ubah kode", ["npm run test"]],
    ["jalankan git status", ["git status"]],
    ["run node --version", ["node --version"]],
  ];
  for (const [text, commands] of cases) {
    it(`"${text}" → ${commands.join(" + ")}`, () => {
      const result = classifyCommand(text);
      expect(result.kind).toBe("command");
      expect(result.commands).toEqual(commands);
      expect(result.suggestedCapabilities).toEqual(["shell-execution"]);
      expect(detectRunCommands(text)).toEqual(commands);
    });
  }

  const notCommands: Array<[string, string]> = [
    ["run the tests and fix the failures", "code_change"],
    ["jalankan tes lalu perbaiki yang gagal", "code_change"],
    ["add unit tests for the header", "code_change"],
    ["tambahkan tes untuk komponen header", "code_change"],
    ["build a login page", "code_change"],
    ["fix the failing tests", "code_change"],
    ["kenapa npm test gagal?", "research"],
    ["why does the build fail?", "research"],
    ["Investigate why the build is slow, don't change code", "research"],
    ["Run QA on the app", "code_change"],
  ];
  for (const [text, kind] of notCommands) {
    it(`"${text}" stays ${kind}`, () => {
      const result = classifyCommand(text);
      expect(result.kind).not.toBe("command");
      expect(detectRunCommands(text)).toBeNull();
      if (kind === "research") expect(result.kind).toBe("research");
    });
  }

  it("attached file contexts do not count as the request", () => {
    expect(classifyCommand("add a footer\nAttached file context:\nrun npm test").kind).toBe("code_change");
  });
});

describe("router: a run request is a task", () => {
  it("routes run requests (EN + ID) to a task", async () => {
    for (const text of ["run npm test", "jalankan tes", "can you run the tests?"]) {
      const result = await routeMessage({ text, agents: [] });
      expect(result.intent).toBe("task");
      expect(result.classification.kind).toBe("command");
    }
  });
});

describe("validatePlan: command lock", () => {
  const codeChangePlan = {
    goal: "run npm test",
    strategy: "dag",
    requiresApproval: true,
    maxConcurrency: 1,
    subtasks: [
      { key: "run-tests", title: "Run tests and write report", description: "Run the tests and write TEST_REPORT.md", kind: "code_change", capability: "backend-development", dependencies: [], order: 0, allowedPaths: ["TEST_REPORT.md"] },
      { key: "review", title: "Review", description: "Review the diff", kind: "review", capability: "code-review", dependencies: ["run-tests"], order: 1 },
    ],
  };

  it("replaces a code_change plan with one shell node per requested command", () => {
    const result = validatePlan(codeChangePlan, 8, { taskKind: "command", commands: ["npm run test"] });
    expect(result.ok).toBe(true);
    expect(result.plan?.requiresApproval).toBe(false);
    expect(result.plan?.subtasks).toHaveLength(1);
    const node = result.plan!.subtasks[0];
    expect(node.kind).toBe("shell");
    expect(node.capability).toBe("shell-execution");
    expect(node.description).toBe("Run exactly: npm run test");
    expect(node.allowedPaths).toBeUndefined();
    expect(result.notes?.join(" ")).toMatch(/replaced code_change subtask run-tests/);
    expect(result.notes?.join(" ")).toMatch(/replaced review subtask review/);
  });

  it("several commands run in request order", () => {
    const result = validatePlan({ goal: "g", subtasks: [] }, 8, { taskKind: "command", commands: ["npm run typecheck", "npm run test"] });
    expect(result.ok).toBe(true);
    const [first, second] = result.plan!.subtasks;
    expect(first.description).toBe("Run exactly: npm run typecheck");
    expect(second.description).toBe("Run exactly: npm run test");
    expect(second.dependencies).toEqual([first.key]);
    expect(result.plan!.subtasks.every((s) => s.kind === "shell")).toBe(true);
  });

  it("without known commands: code_change becomes shell, review/qa are dropped", () => {
    const result = validatePlan(codeChangePlan, 8, { taskKind: "command" });
    expect(result.ok).toBe(true);
    expect(result.plan?.subtasks.map((s) => [s.key, s.kind, s.capability])).toEqual([["run-tests", "shell", "shell-execution"]]);
    expect(result.plan?.requiresApproval).toBe(false);
  });

  it("other task kinds keep their plan unchanged", () => {
    const result = validatePlan(codeChangePlan, 8, { taskKind: "code_change" });
    expect(result.ok).toBe(true);
    expect(result.plan?.subtasks.map((s) => s.kind)).toEqual(["code_change", "review"]);
    expect(result.plan?.requiresApproval).toBe(true);
  });
});

describe("planner: run-command tasks", () => {
  it("the heuristic plan is shell-only", () => {
    const classification = classifyCommand("jalankan tes");
    const plan = heuristicPlan({ command: "jalankan tes", classification, agents: [], policy: POLICY });
    expect(plan.subtasks.map((s) => [s.kind, s.capability, s.description])).toEqual([["shell", "shell-execution", "Run exactly: npm run test"]]);
    expect(plan.requiresApproval).toBe(false);
  });

  it("the planning prompt says to emit shell nodes, never code_change", () => {
    const prompt = buildPlanningPrompt({ command: "run npm test", classification: classifyCommand("run npm test"), agents: [], policy: POLICY });
    expect(prompt).toMatch(/RUN-COMMAND TASK/);
    expect(prompt).toContain("npm run test");
    expect(prompt).toMatch(/NEVER emit code_change/);
  });
});
