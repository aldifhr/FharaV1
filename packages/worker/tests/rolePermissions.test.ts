/**
 * Plan 040 (P1): role permissions are enforced by the executor, not only by
 * the prompt. Designer / Support / Researcher / CTO / Reviewer / QA never
 * stage a file change; QA runs verification commands only; DevOps writes
 * only CI / container / infra paths; destructive commands never run
 * without an approval channel.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeSubtask, roleRefusal, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import {
  canWritePath,
  isVerifyCommand,
  permissionsForAgent,
  shellDenial,
  writeDenial,
} from "@/utils/rolePolicy";
import { tool_call } from "@/governance/registry";
import { ROLES, ROLE_KEYS, permissionsFromTools } from "@/api/convex/lib/roles";
import type { FallbackHandle } from "@/effects/llmCall";
import type { GlobalLLMConfig, LLMProvider } from "@/llm";
import type { AgentDefinition, PlanSubtask } from "@/types";
import type { FileDiff } from "@/tools/gitDiff";

const CONFIG: GlobalLLMConfig = { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" };

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-roleperm-"));
  await fs.writeFile(path.join(workspace, "index.html"), "<h1>Hi</h1>\n");
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function agent(role: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return { _id: `agent-${role}`, name: role, role, capabilities: [], isEnabled: true, priority: 1, ...extra };
}

function subtask(kind: PlanSubtask["kind"], extra: Partial<PlanSubtask> = {}): PlanSubtask {
  return { key: "n1", title: "node", description: "Edit index.html", kind, capability: "frontend-development", dependencies: [], order: 0, ...extra };
}

function counting(reply: string): { provider: LLMProvider; calls: () => number } {
  let n = 0;
  return {
    provider: { complete: async () => { n += 1; return { content: reply, inputTokens: 1, outputTokens: 1 }; } },
    calls: () => n,
  };
}

function input(a: AgentDefinition, s: PlanSubtask, provider: LLMProvider, saved: FileDiff[] = [], events: Array<{ type: string; payload: unknown }> = [], extra: Partial<SubtaskExecutionInput> = {}): SubtaskExecutionInput {
  const handle: FallbackHandle = { connectionId: "c", connectionName: "t", config: CONFIG, provider };
  return {
    workspacePath: workspace,
    command: "change the page",
    plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [s] },
    subtask: s,
    agent: a,
    llmHandles: [handle],
    priorOutputs: new Map(),
    fileChanges: [],
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    onEvent: async (type: string, payload: unknown) => { events.push({ type, payload }); },
    onMessage: async () => undefined,
    onChunk: async () => undefined,
    saveFileChange: async (change: FileDiff) => { saved.push(change); },
    ...extra,
  } as SubtaskExecutionInput;
}

const WRITE_REPLY = JSON.stringify({ files: [{ filePath: "index.html", newContent: "<h1>Hello</h1>\n" }] });

describe("role permission table", () => {
  it("every role has permissions and none may push", () => {
    for (const key of ROLE_KEYS) {
      expect(ROLES[key].permissions.read).toBe(true);
      expect(ROLES[key].permissions.push).toBe(false);
    }
  });

  it("only Frontend and Backend write anywhere; DevOps is path-scoped; the rest are read-only", () => {
    const writers = ROLE_KEYS.filter((key) => ROLES[key].permissions.write === true);
    expect(writers.sort()).toEqual(["backend", "frontend"]);
    expect(Array.isArray(ROLES.devops.permissions.write)).toBe(true);
    for (const key of ["cto", "designer", "qa", "support", "reviewer", "researcher"] as const) {
      expect(ROLES[key].permissions.write).toBe(false);
      expect(ROLES[key].defaultTools).not.toContain("write_file");
    }
  });

  it("web only for the Researcher; QA shell is verify-only", () => {
    expect(ROLE_KEYS.filter((key) => ROLES[key].permissions.web)).toEqual(["researcher"]);
    expect(ROLES.qa.permissions.shell).toBe("verify");
    expect(ROLES.researcher.defaultTools).toContain("web_reach");
  });

  it("DevOps may write only .github/**, Dockerfile*, docker-compose*, infra/**", () => {
    const devops = ROLES.devops.permissions;
    for (const ok of [".github/workflows/ci.yml", "Dockerfile", "Dockerfile.worker", "apps/web/Dockerfile", "docker-compose.yml", "docker-compose.prod.yaml", "infra/terraform/main.tf"]) {
      expect(canWritePath(devops, ok), ok).toBe(true);
    }
    for (const no of ["apps/web/app/page.tsx", "package.json", "src/infra/x.ts", ".githubx/y", "infra/../src/a.ts", "README.md"]) {
      expect(canWritePath(devops, no), no).toBe(false);
    }
  });

  it("resolves titles and aliases; a custom role keeps what its tools allowed", () => {
    expect(permissionsForAgent(agent("UI/UX Designer")).write).toBe(false);
    expect(permissionsForAgent(agent("QA Engineer")).shell).toBe("verify");
    expect(permissionsForAgent(agent("technical-writer")).write).toBe(false);
    expect(permissionsForAgent(agent("Frontend Developer")).write).toBe(true);
    expect(permissionsForAgent(agent("data-wrangler", { supportedTools: ["read_file", "write_file"] })).write).toBe(true);
    expect(permissionsForAgent(agent("data-wrangler", { supportedTools: ["read_file"] })).write).toBe(false);
    expect(permissionsFromTools(["run_command"]).push).toBe(false);
  });

  it("verify commands: tests/typecheck/build/read-only git, never pull/fetch", () => {
    expect(isVerifyCommand("npm", ["run", "test"])).toBe(true);
    expect(isVerifyCommand("npx", ["tsc", "--noEmit"])).toBe(true);
    expect(isVerifyCommand("git", ["diff", "--stat"])).toBe(true);
    expect(isVerifyCommand("git", ["pull", "--rebase"])).toBe(false);
    expect(isVerifyCommand("git", ["fetch"])).toBe(false);
    expect(shellDenial("qa", ROLES.qa.permissions, "git", ["pull"])).toMatch(/only run tests/);
    expect(shellDenial("designer", ROLES.designer.permissions, "npm", ["run", "test"])).toMatch(/may not run commands/);
    expect(shellDenial("devops", ROLES.devops.permissions, "git", ["pull"])).toBeNull();
    expect(writeDenial("devops", ROLES.devops.permissions, "src/a.ts")).toMatch(/may only write/);
  });
});

describe("executor: read-only roles never stage a file change", () => {
  for (const role of ["designer", "support", "researcher", "cto", "qa", "reviewer"]) {
    it(`${role}: code_change refused before any LLM call`, async () => {
      const { provider, calls } = counting(WRITE_REPLY);
      const saved: FileDiff[] = [];
      const events: Array<{ type: string; payload: unknown }> = [];
      const result = await executeSubtask(input(agent(role, { supportedTools: ["read_file", "write_file"] }), subtask("code_change"), provider, saved, events));
      expect(result.status).toBe("failed");
      expect(result.status === "failed" ? result.error : "").toMatch(/read-only/);
      expect(saved).toHaveLength(0);
      expect(calls()).toBe(0);
      expect(events.map((e) => e.type)).toContain("agent.permission_denied");
    });
  }

  it("the native (OpenCode) runtime is refused too for a read-only role", () => {
    expect(roleRefusal({ agent: agent("designer"), subtask: subtask("code_change") })).toMatch(/read-only/);
    expect(roleRefusal({ agent: agent("support"), subtask: subtask("shell") })).toMatch(/may not run commands/);
    expect(roleRefusal({ agent: agent("qa"), subtask: subtask("shell") })).toBeNull();
    expect(roleRefusal({ agent: agent("designer"), subtask: subtask("analysis") })).toBeNull();
  });

  it("frontend still writes", async () => {
    const { provider } = counting(WRITE_REPLY);
    const saved: FileDiff[] = [];
    const result = await executeSubtask(input(agent("frontend"), subtask("code_change"), provider, saved));
    expect(result.status).toBe("completed");
    expect(saved.map((c) => c.filePath)).toEqual(["index.html"]);
  });

  it("backend still writes", async () => {
    const { provider } = counting(WRITE_REPLY);
    const saved: FileDiff[] = [];
    const result = await executeSubtask(input(agent("backend"), subtask("code_change", { capability: "backend-development" }), provider, saved));
    expect(result.status).toBe("completed");
    expect(saved).toHaveLength(1);
  });
});

describe("executor: DevOps writes only CI / infra paths", () => {
  it("refuses an application file", async () => {
    const { provider } = counting(WRITE_REPLY);
    const saved: FileDiff[] = [];
    const result = await executeSubtask(input(agent("devops"), subtask("code_change", { capability: "github" }), provider, saved));
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.error : "").toMatch(/may only write/);
    expect(saved).toHaveLength(0);
  });

  it("stages a workflow file", async () => {
    const { provider } = counting(JSON.stringify({ files: [{ filePath: ".github/workflows/ci.yml", newContent: "name: ci\n" }] }));
    const saved: FileDiff[] = [];
    const result = await executeSubtask(input(agent("devops"), subtask("code_change", { capability: "github", description: "Add CI workflow" }), provider, saved));
    expect(result.status).toBe("completed");
    expect(saved.map((c) => c.filePath)).toEqual([".github/workflows/ci.yml"]);
  });
});

describe("executor: shell permissions", () => {
  it("QA may run tests but not git pull", async () => {
    const { provider } = counting('{"command":"git","args":["pull"]}');
    const result = await executeSubtask(input(agent("qa"), subtask("shell", { capability: "browser-testing", description: "Run exactly: git pull" }), provider));
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.error : "").toMatch(/only run tests/);
  });

  it("QA node --version (verify) runs", async () => {
    const { provider } = counting('{"command":"node","args":["--version"]}');
    const result = await executeSubtask(input(agent("qa"), subtask("shell", { capability: "browser-testing", description: "Run exactly: node --version" }), provider));
    expect(result.status).toBe("completed");
  });

  it("Designer shell node refused before any LLM call", async () => {
    const { provider, calls } = counting('{"command":"node","args":["--version"]}');
    const result = await executeSubtask(input(agent("designer"), subtask("shell"), provider));
    expect(result.status).toBe("failed");
    expect(calls()).toBe(0);
  });
});

describe("governance broker follows the role policy", () => {
  const ctx = (role: string) => ({ workspacePath: "/tmp/none", agentRole: role, audit: async () => undefined }) as never;
  it("designer / support may not write_file; qa may not write_file; devops may", async () => {
    for (const role of ["designer", "support", "qa", "researcher", "reviewer", "cto"]) {
      const result = await tool_call({ ctx: ctx(role), supportedTools: ["write_file"], name: "write_file", args: { path: "a.txt", content: "x" } });
      expect(result.ok, role).toBe(false);
      expect((result as { reason?: string }).reason ?? "").toMatch(/read-only-role/);
    }
  });
  it("designer may not run_command", async () => {
    const result = await tool_call({ ctx: ctx("designer"), supportedTools: ["run_command"], name: "run_command", args: { command: "git status" } });
    expect((result as { reason?: string }).reason ?? "").toMatch(/read-only-role/);
  });
});
