import { describe, expect, it, vi } from "vitest";
import { collectRoleLearnings, groupWorkByAgent, maskWorkOutput } from "@/services/runner/roleLearnings";
import { buildRoleLearningsPrompt } from "@/prompts/roleLearnings";
import type { RunnerDeps } from "@/services/runner/types";
import type { AgentDefinition } from "@/types";

function fakeApi(over: { disabledBackend?: boolean } = {}) {
  const recorded: Array<Record<string, unknown>> = [];
  const api = {
    recordRoleLearnings: vi.fn(async (input: Record<string, unknown>) => {
      if (over.disabledBackend) return { applied: false, reason: "disabled", inserted: 0, updated: 0, evicted: 0 };
      recorded.push(input);
      return { applied: true, inserted: (input.learnings as unknown[]).length, updated: 0, evicted: 0 };
    }),
    logEvent: vi.fn(async () => undefined),
  };
  return { api, recorded, deps: { api } as unknown as RunnerDeps };
}

const agents = [
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "qa", name: "QA", role: "qa" },
  { _id: "be", name: "Backend", role: "backend" },
] as unknown as AgentDefinition[];

const long = (s: string) => `${s} ${"detail ".repeat(20)}`;
const subtasks = [
  { key: "s1", title: "Build the card", status: "completed", assignedAgentId: "fe", output: long("Built the card with the ink token") },
  { key: "s2", title: "Style tweaks", status: "completed", assignedAgentId: "fe", output: long("Moved spacing into tokens") },
  { key: "s3", title: "Test the card", status: "completed", assignedAgentId: "qa", output: long("Ran vitest") },
  { key: "s4", title: "API", status: "failed", assignedAgentId: "be", output: long("failed") },
  { key: "s5", title: "Tiny", status: "completed", assignedAgentId: "be", output: "ok" },
];

const reply = JSON.stringify({
  learnings: [
    { title: "Card tokens", content: "Cards use the ink token for borders.", kind: "convention" },
    { title: "Key", content: "Deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123456789", kind: "fact" },
  ],
});

const base = (deps: RunnerDeps, extra: Record<string, unknown> = {}) => ({
  deps,
  taskId: "t1",
  projectId: "p1",
  project: {},
  task: { title: "Card", request: "Build a card", status: "done" as const },
  agents,
  subtasks,
  env: {},
  ...extra,
});

describe("role memory: per-role learnings after a task", () => {
  it("one call per role with completed work (batched across its subtasks), not per subtask", async () => {
    const ask = vi.fn(async (_agent: AgentDefinition, _system: string, _user: string) => reply);
    const { deps, recorded } = fakeApi();
    const out = await collectRoleLearnings({ ...base(deps), ask });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls.map((c) => c[0].role).sort()).toEqual(["frontend", "qa"]);
    // Frontend's call carries both of its subtasks.
    const feUser = ask.mock.calls.find((c) => c[0].role === "frontend")![2];
    expect(feUser).toContain("Build the card");
    expect(feUser).toContain("Style tweaks");
    expect(feUser).not.toContain("Test the card");
    expect(recorded.map((r) => r.agentId).sort()).toEqual(["fe", "qa"]);
    expect(recorded[0]).toMatchObject({ projectId: "p1", taskId: "t1" });
    expect(out.roles.every((r) => r.tag === "written")).toBe(true);
  });

  it("masks secrets in learnings before they leave the worker", async () => {
    const ask = vi.fn(async (_agent: AgentDefinition, _system: string, _user: string) => reply);
    const { deps, recorded } = fakeApi();
    await collectRoleLearnings({ ...base(deps), ask });
    const all = JSON.stringify(recorded);
    expect(all).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("the project toggle (or FHARA_ROLE_MEMORY=0) makes zero calls and writes nothing", async () => {
    const ask = vi.fn(async (_agent: AgentDefinition, _system: string, _user: string) => reply);
    const a = fakeApi();
    expect((await collectRoleLearnings({ ...base(a.deps), project: { roleMemoryDisabled: true }, ask })).skipped).toBe("disabled");
    const b = fakeApi();
    expect((await collectRoleLearnings({ ...base(b.deps), env: { FHARA_ROLE_MEMORY: "0" }, ask })).skipped).toBe("disabled");
    expect(ask).not.toHaveBeenCalled();
    expect(a.api.recordRoleLearnings).not.toHaveBeenCalled();
    expect(b.api.recordRoleLearnings).not.toHaveBeenCalled();
  });

  it("stops after the backend says the project turned role memory off", async () => {
    const ask = vi.fn(async (_agent: AgentDefinition, _system: string, _user: string) => reply);
    const { deps, api } = fakeApi({ disabledBackend: true });
    await collectRoleLearnings({ ...base(deps), ask });
    expect(api.recordRoleLearnings).toHaveBeenCalledTimes(1);
  });

  it("budget gate runs before each call; a veto stops further calls", async () => {
    const ask = vi.fn(async (_agent: AgentDefinition, _system: string, _user: string) => reply);
    const { deps } = fakeApi();
    const gate = vi.fn(() => {
      throw new Error("over budget");
    });
    const out = await collectRoleLearnings({ ...base(deps), ask, assertBudgetForCall: gate });
    expect(ask).not.toHaveBeenCalled();
    expect(out.roles[0].tag).toBe("skipped_budget");
  });

  it("invalid JSON or an empty list writes nothing and never throws", async () => {
    const { deps, api } = fakeApi();
    await collectRoleLearnings({ ...base(deps), ask: async () => "no idea" });
    await collectRoleLearnings({ ...base(deps), ask: async () => '{"learnings":[]}' });
    await collectRoleLearnings({ ...base(deps), ask: async () => { throw new Error("provider down"); } });
    expect(api.recordRoleLearnings).not.toHaveBeenCalled();
  });

  it("prompt input is bounded and never carries a raw diff", () => {
    expect(maskWorkOutput("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b")).toBe("(diff omitted)");
    const work = groupWorkByAgent(
      Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, title: `t${i}`, status: "completed", assignedAgentId: "fe", output: "x".repeat(5000) }))
    );
    const prompt = buildRoleLearningsPrompt({ taskTitle: "T", request: "r".repeat(5000), status: "done", work: work.get("fe")! });
    expect(prompt.length).toBeLessThan(4500);
  });
});
