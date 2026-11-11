import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, type LLMMessage } from "@/llm";
import { buildPlanningPrompt, createPlan } from "@/orchestrator/planner";
import { classifyCommand } from "@/orchestrator/classifier";
import { loadPolicy } from "@/orchestrator/policy";
import { ARCH_DECISION_KEY, applyArchitectureGate, detectArchitectureSignals, NO_CTO_NOTE } from "@/orchestrator/architecture";
import { conversationReplyCapability, pickPlannerModelSource } from "@/orchestrator/plannerAgent";
import { parseArchitectureFlag, parseArchVerdict } from "@/api/convex/lib/architectureFlag";
import { validateStoredPlan } from "@/orchestrator/planValidator";
import type { TaskLlmResolver } from "@/llm/resolver";
import type { AgentDefinition, ExecutionPlan } from "@/types";
import { startMockLlm, type MockScript } from "../../../scripts/mock-llm/server";

/**
 * O1 (Orchestrator/CTO split): the planner has no persona, an unflagged
 * plan never reaches the CTO, a flagged one (planner flag or deterministic
 * backstop) gets one `arch-decision` node that gates the dependent work,
 * and planning works without a CTO in the team.
 */
const policy = { ...loadPolicy(), reviewMode: "never" as const, qaMode: "never" as const };
const CTO_PERSONA = "You are the CTO. Avoid orchestration.";
const cto: AgentDefinition = { _id: "cto", name: "CTO", role: "cto", capabilities: ["architecture"], systemPrompt: CTO_PERSONA, isEnabled: true, priority: 9 };
const frontend: AgentDefinition = { _id: "fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], supportedTools: ["read_file", "write_file"], isEnabled: true, priority: 5 };
const backend: AgentDefinition = { _id: "be", name: "Backend", role: "backend", capabilities: ["backend-development"], supportedTools: ["read_file", "write_file"], isEnabled: true, priority: 6 };
const support: AgentDefinition = { _id: "sp", name: "Support", role: "support", capabilities: ["documentation-support"], isEnabled: true, priority: 1 };
const researcher: AgentDefinition = { _id: "rs", name: "Researcher", role: "researcher", capabilities: ["research"], isEnabled: true, priority: 2 };
const team = [cto, frontend, backend, support, researcher];

/** Resolver whose provider answers a fixed plan and records the agent and the messages. */
function resolverAnswering(content: string, log: { agents: string[]; messages: LLMMessage[][] }): TaskLlmResolver {
  return {
    handlesFor: (agent: AgentDefinition) => {
      log.agents.push(agent.name);
      return [
        {
          connectionId: "",
          connectionName: "fake",
          config: { provider: "openai-compatible", model: "fake", apiKey: "x", baseUrl: "http://x" } as never,
          provider: {
            complete: async (messages: LLMMessage[]) => {
              log.messages.push(messages);
              return { content };
            },
          },
        },
      ];
    },
  } as unknown as TaskLlmResolver;
}

const node = (key: string, fields: Partial<ExecutionPlan["subtasks"][number]> = {}): ExecutionPlan["subtasks"][number] => ({
  key,
  title: key,
  description: key,
  kind: "code_change",
  capability: "frontend-development",
  dependencies: [],
  order: 0,
  ...fields,
});
const planOf = (subtasks: ExecutionPlan["subtasks"], extra: Partial<ExecutionPlan> = {}): ExecutionPlan => ({
  version: 1,
  goal: "g",
  strategy: subtasks.length > 1 ? "dag" : "single",
  requiresApproval: true,
  maxConcurrency: 1,
  subtasks: subtasks.map((s, order) => ({ ...s, order })),
  ...extra,
});
const llmPlan = (subtasks: unknown[], architecture?: unknown) =>
  JSON.stringify({ goal: "g", strategy: "dag", requiresApproval: true, maxConcurrency: 1, subtasks, ...(architecture ? { architecture } : {}) });

async function plan(command: string, content: string, agents = team) {
  const log = { agents: [] as string[], messages: [] as LLMMessage[][] };
  const result = await createPlan({ command, classification: classifyCommand(command), agents, policy, llmResolver: resolverAnswering(content, log) });
  return { result, log };
}

describe("O1: neutral planner prompt and call", () => {
  it("the prompt has no CTO persona or CTO approval language, and asks for the architecture flag", () => {
    const prompt = buildPlanningPrompt({ command: "add a page", classification: classifyCommand("add a page"), agents: team, policy });
    expect(prompt).not.toMatch(/You are the CTO/i);
    expect(prompt).not.toMatch(/CTO must (verify|reject)/i);
    expect(prompt).not.toMatch(/CTO quality gate/i);
    expect(prompt.startsWith("You plan work for a team of specialist roles in Fhara. You do not do the work.")).toBe(true);
    expect(prompt).toContain('"architecture":{"needed":false');
  });

  it("the planner call carries no CTO system message (the CTO is only the model source)", async () => {
    const { log } = await plan("ganti warna tombol simpan", llmPlan([node("implement", { allowedPaths: ["apps/web/components/Save.tsx"] })]));
    expect(log.agents).toEqual(["CTO"]);
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0].some((m) => m.role === "system")).toBe(false);
    expect(JSON.stringify(log.messages[0])).not.toContain(CTO_PERSONA);
  });
});

describe("O1: unflagged plans never call the CTO", () => {
  for (const [command, paths] of [
    ["ganti warna tombol simpan", ["apps/web/components/Save.tsx"]],
    ["perbaiki typo di halaman login", ["apps/web/app/login/page.tsx"]],
    ["tambah kolom tanggal di tabel pesanan", ["apps/web/components/OrdersTable.tsx"]],
    ["fix the CI build workflow", [".github/workflows/ci.yml"]],
  ] as const) {
    it(`"${command}" → no arch-decision node, nothing routed to the CTO`, async () => {
      const { result } = await plan(command, llmPlan([node("implement", { allowedPaths: [...paths] })]));
      expect(result.plan.subtasks.map((s) => s.key)).toEqual(["implement"]);
      expect(result.plan.architecture).toBeUndefined();
      expect(result.plan.subtasks.some((s) => s.capability === "architecture")).toBe(false);
    });
  }
});

describe("O1: a flagged plan inserts the CTO decision node before the gated work", () => {
  it("planner flag → arch-decision node; gated subtasks depend on it; research feeds it", async () => {
    const { result } = await plan(
      "Status pesanan multi-tahap",
      llmPlan(
        [
          node("research", { kind: "research", capability: "research" }),
          node("backend", { capability: "backend-development", allowedPaths: ["apps/api/convex/orders.ts"] }),
          node("frontend", { dependencies: ["backend"], allowedPaths: ["apps/web/components/Order.tsx"] }),
        ],
        { needed: true, reasons: ["schema_change"], question: "Model order status as a state machine?", gatedKeys: ["backend"] }
      )
    );
    const keys = result.plan.subtasks.map((s) => s.key);
    expect(keys).toContain(ARCH_DECISION_KEY);
    const decision = result.plan.subtasks.find((s) => s.key === ARCH_DECISION_KEY)!;
    expect(decision).toMatchObject({ kind: "analysis", capability: "architecture", dependencies: ["research"] });
    expect(decision.title).toBe("Architecture decision: Model order status as a state machine?");
    expect(decision.description).toMatch(/Decision: go/);
    expect(result.plan.subtasks.find((s) => s.key === "backend")!.dependencies).toEqual([ARCH_DECISION_KEY]);
    // Downstream of a gated node waits transitively; it is not re-gated.
    expect(result.plan.subtasks.find((s) => s.key === "frontend")!.dependencies).toEqual(["backend"]);
    expect(keys.indexOf(ARCH_DECISION_KEY)).toBeLessThan(keys.indexOf("backend"));
    expect(result.plan.architecture).toMatchObject({ needed: true, reasons: ["schema_change"], gatedKeys: ["backend"], source: "planner" });
    // The stored plan (plan review / resume) keeps the flag.
    expect(validateStoredPlan(result.plan, 12).plan?.architecture?.needed).toBe(true);
  });

  it("backstop: package.json + a new library flags new_dependency (gates every write node)", () => {
    const flagged = applyArchitectureGate(
      planOf([node("implement", { allowedPaths: ["apps/web/package.json", "apps/web/lib"] })]),
      { command: "pakai library zod untuk validasi form", agents: team }
    );
    expect(flagged.architecture).toMatchObject({ reasons: ["new_dependency"], source: "backstop", gatedKeys: ["implement"] });
    expect(flagged.subtasks.map((s) => s.key)).toEqual([ARCH_DECISION_KEY, "implement"]);
  });

  it("backstop: schema.ts / migrations / auth paths and auth work flag; a UI table column does not", () => {
    const signals = (command: string, paths: string[]) => detectArchitectureSignals(planOf([node("i", { allowedPaths: paths })]), command);
    expect(signals("add order status", ["apps/api/convex/schema.ts"])).toEqual(["schema_change"]);
    expect(signals("add a column", ["db/migrations/002_status.sql"])).toEqual(["schema_change"]);
    expect(signals("update checks", ["apps/api/convex/lib/auth/session.ts"])).toEqual(["auth_boundary"]);
    expect(signals("Tambah login Google dan GitHub", ["apps/web"])).toEqual(["auth_boundary"]);
    expect(signals("split the API into its own service", ["Dockerfile.api", "infra/compose.yml"])).toEqual(["infra_deploy"]);
    expect(signals("tambah kolom tanggal di tabel", ["apps/web/components/Table.tsx"])).toEqual([]);
    expect(signals("perbaiki typo di halaman login", ["apps/web/app/login/page.tsx"])).toEqual([]);
    expect(signals("fix the docker build", ["Dockerfile"])).toEqual([]);
  });

  it("read-only plans are never gated (no write node)", () => {
    const readOnly = planOf([node("research", { kind: "research", capability: "research" })]);
    expect(applyArchitectureGate(readOnly, { command: "S3 or local storage?", agents: team, flag: { needed: true, reasons: ["infra_deploy"] } })).toBe(readOnly);
  });

  it("no CTO in the team → plan note, flag kept, no decision node, the work still runs", async () => {
    const { result } = await plan(
      "Tambah login Google dan GitHub",
      llmPlan([node("implement", { capability: "backend-development", allowedPaths: ["apps/api/convex/auth.ts"] })]),
      [frontend, backend]
    );
    expect(result.notes).toContain(NO_CTO_NOTE);
    expect(result.plan.subtasks.map((s) => s.key)).toEqual(["implement"]);
    expect(result.plan.architecture?.reasons).toEqual(["auth_boundary"]);
  });
});

describe("O1: planning works without a CTO agent", () => {
  it("an enabled team member's model chain plans (not degraded)", async () => {
    const { result, log } = await plan("Implement Tiga Kolom", llmPlan([node("implement", { allowedPaths: ["apps/web/components"] })]), [frontend, backend]);
    expect(log.agents).toEqual(["Backend"]);
    expect(result.createdBy).toBe("orchestrator");
    expect(result.plan.subtasks.map((s) => s.key)).toEqual(["implement"]);
    expect(pickPlannerModelSource([frontend], null)).toEqual({ agent: frontend, viaTeamMember: true });
    expect(pickPlannerModelSource([frontend, cto], null)).toEqual({ agent: cto, viaTeamMember: false });
    expect(pickPlannerModelSource([], null)).toBeNull();
  });

  it("a conversation reply goes to the topic owner, Support by default, never the CTO", () => {
    expect(conversationReplyCapability("hello", team)).toBe("documentation-support");
    expect(conversationReplyCapability("kenapa query database lambat", team)).toBe("backend-development");
    expect(conversationReplyCapability("hello", [cto, frontend])).toBe("frontend-development");
  });
});

describe("O1: flag and verdict parsing", () => {
  it("parseArchitectureFlag keeps known reasons only; needed requires a reason", () => {
    expect(parseArchitectureFlag({ needed: true, reasons: ["schema_change", "vibes"], question: " q ", gatedKeys: ["a", "a"] })).toEqual({
      needed: true,
      reasons: ["schema_change"],
      question: "q",
      gatedKeys: ["a"],
    });
    expect(parseArchitectureFlag({ needed: true, reasons: [] })?.needed).toBe(false);
    expect(parseArchitectureFlag("yes")).toBeUndefined();
  });

  it("parseArchVerdict reads the last Decision line; unreadable → go (parsed false)", () => {
    expect(parseArchVerdict("Use a state machine.\nDecision: go")).toEqual({ verdict: "go", parsed: true });
    expect(parseArchVerdict("Decision: go … on reflection\n**Decision: revise**")).toEqual({ verdict: "revise", parsed: true });
    expect(parseArchVerdict("decision - STOP")).toEqual({ verdict: "stop", parsed: true });
    expect(parseArchVerdict("Looks fine to me.")).toEqual({ verdict: "go", parsed: false });
  });
});

describe("O1: planner through the mock LLM", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });

  it("a flagged mock-LLM plan gets the decision node; the persona-free prompt matches the planner rule", async () => {
    const script: MockScript = {
      fallback: "Mock reply.",
      rules: [
        {
          id: "planner-arch",
          role: "planner",
          match: ["You plan work for a team of specialist roles"],
          reply: llmPlan(
            [node("implement", { capability: "backend-development", allowedPaths: ["apps/api/convex/schema.ts", "apps/api/convex/orders.ts"] })],
            { needed: true, reasons: ["schema_change"], question: "Order status model", gatedKeys: ["implement"] }
          ),
        },
      ],
    };
    const server = await startMockLlm({ speed: 0, quiet: true, token: "t", script });
    servers.push(server);
    const resolver = {
      handlesFor: () => [
        {
          connectionId: "",
          connectionName: "mock",
          config: { provider: "openai-compatible", model: "mock/default", apiKey: "t", baseUrl: server.url } as never,
          provider: new OpenAICompatibleProvider("t", "mock/default", server.url),
        },
      ],
    } as unknown as TaskLlmResolver;
    const command = "Status pesanan multi-tahap";
    const result = await createPlan({ command, classification: classifyCommand(command), agents: team, policy, llmResolver: resolver });
    expect(server.calls.map((c) => c.rule)).toEqual(["planner-arch"]);
    expect(result.createdBy).toBe("orchestrator");
    expect(result.plan.subtasks.map((s) => s.key)).toEqual([ARCH_DECISION_KEY, "implement"]);
  });
});
