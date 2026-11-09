import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "@/types";
import { routeCapability } from "@/orchestrator/capabilities";
import { loadAwareRoutingEnabled, pickLoadAware } from "@/orchestrator/loadAwareRouting";
import { createRunContext } from "@/services/runner/runContext";
import type { ExecutePlanInput } from "@/services/runner/types";
import type { WebClient } from "@/tools/webClient";

const agent = (over: Partial<AgentDefinition> & { _id: string; name: string; role: string }): AgentDefinition =>
  ({ isEnabled: true, capabilities: [], supportedTools: ["read_file", "write_file"], ...over }) as AgentDefinition;

const fe1 = agent({ _id: "fe1", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], priority: 8, maxConcurrency: 1 });
const fe2 = agent({ _id: "fe2", name: "Frontend B", role: "frontend", capabilities: ["frontend-development"], priority: 5, maxConcurrency: 2 });
const be = agent({ _id: "be", name: "Backend", role: "backend", capabilities: ["backend-development"], priority: 9, maxConcurrency: 4 });
const qa = agent({ _id: "qa", name: "QA", role: "qa", capabilities: ["browser-testing"], supportedTools: ["read_file"], maxConcurrency: 3 });
const team = [fe1, fe2, be, qa];

describe("pickLoadAware", () => {
  it("keeps the normal pick when it has spare capacity and nobody is freer", () => {
    const pick = pickLoadAware(fe1, "frontend-development", team, () => 0);
    expect(pick.agent?._id).toBe("fe1");
    expect(pick.loadAware).toBeUndefined();
  });

  it("moves to the capable agent with spare capacity when the normal pick is full", () => {
    const load: Record<string, number> = { fe1: 1, fe2: 0 };
    const pick = pickLoadAware(fe1, "frontend-development", team, (a) => load[a._id] ?? 0);
    expect(pick.agent?._id).toBe("fe2");
    expect(pick.loadAware).toMatchObject({ from: "Frontend", to: "Frontend B", fromRole: "frontend", toRole: "frontend" });
    expect(pick.loadAware?.reason).toMatch(/at capacity \(1\/1 running\) vs 0\/2/);
  });

  it("prefers the lowest running/limit ratio and gives ties to the normal order", () => {
    const a = agent({ _id: "a", name: "A", role: "frontend", capabilities: ["frontend-development"], priority: 9, maxConcurrency: 4 });
    const b = agent({ _id: "b", name: "B", role: "frontend", capabilities: ["frontend-development"], priority: 8, maxConcurrency: 2 });
    // a: 2/4 = .5, b: 1/2 = .5 → tie → a (normal order) stays.
    expect(pickLoadAware(a, "frontend-development", [a, b], (x) => (x._id === "a" ? 2 : 1)).agent?._id).toBe("a");
    // a: 3/4, b: 1/2 → b.
    expect(pickLoadAware(a, "frontend-development", [a, b], (x) => (x._id === "a" ? 3 : 1)).agent?._id).toBe("b");
  });

  it("keeps the normal pick when every capable agent is full", () => {
    const pick = pickLoadAware(fe1, "frontend-development", team, (a) => (a._id === "fe1" ? 1 : a._id === "fe2" ? 2 : 0));
    expect(pick.agent?._id).toBe("fe1");
    expect(pick.loadAware).toBeUndefined();
  });

  it("never routes to an agent that lacks the capability, however idle", () => {
    // Backend and QA are idle with big limits; only Frontends declare the capability.
    const pick = pickLoadAware(fe1, "frontend-development", team, (a) => (a.role === "frontend" ? 1 : 0));
    expect(pick.agent?._id).not.toBe("be");
    expect(pick.agent?._id).not.toBe("qa");
    // fe2 has 1/2 → spare → chosen; still a frontend agent.
    expect(pick.agent?._id).toBe("fe2");
  });

  it("leaves fallback (no exact match) picks alone", () => {
    const fallback = routeCapability("data-science", team);
    expect(fallback).not.toBeNull();
    const pick = pickLoadAware(fallback, "data-science", team, () => 99);
    expect(pick.agent?._id).toBe(fallback!._id);
    expect(pick.loadAware).toBeUndefined();
  });

  it("skips disabled agents", () => {
    const off = agent({ ...fe2, isEnabled: false });
    const pick = pickLoadAware(fe1, "frontend-development", [fe1, off], (a) => (a._id === "fe1" ? 1 : 0));
    expect(pick.agent?._id).toBe("fe1");
  });
});

describe("loadAwareRoutingEnabled", () => {
  it("project setting wins, else the env/policy default, else off", () => {
    expect(loadAwareRoutingEnabled({}, undefined)).toBe(false);
    expect(loadAwareRoutingEnabled({}, true)).toBe(true);
    expect(loadAwareRoutingEnabled({ loadAwareRouting: false }, true)).toBe(false);
    expect(loadAwareRoutingEnabled({ loadAwareRouting: true }, false)).toBe(true);
    expect(loadAwareRoutingEnabled(null, undefined)).toBe(false);
  });
});

describe("runContext.assign with load-aware routing", () => {
  const plan = {
    version: 1,
    subtasks: [
      { key: "ui1", title: "UI 1", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 1 },
      { key: "ui2", title: "UI 2", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 2 },
      { key: "api", title: "API", description: "d", kind: "code_change", capability: "backend-development", dependencies: [], order: 3 },
    ],
  };
  const build = (opts: { projectSetting?: boolean; policy?: boolean }) =>
    createRunContext(
      {
        deps: { policy: { loadAwareRouting: opts.policy }, api: {}, workerId: "w" },
        task: { _id: "t1" },
        project: { _id: "p1", ...(opts.projectSetting !== undefined ? { loadAwareRouting: opts.projectSetting } : {}) },
        plan,
        state: { feedback: [], priorOutputs: new Map(), reviewVerdicts: {} },
        agents: team,
        completedKeys: new Set<string>(),
        workspacePath: "/tmp",
        approvalMode: "ask",
      } as unknown as ExecutePlanInput,
      {} as WebClient
    );

  it("off (default): picks are unchanged even when the first agent is busy", () => {
    const ctx = build({});
    expect(ctx.loadAwareRouting).toBe(false);
    ctx.activeByAgent.set("fe1", 1);
    ctx.loadSnapshot.set("fe1", 5);
    expect(ctx.assign("ui1")?._id).toBe("fe1");
    expect(ctx.assign("ui2")?._id).toBe("fe1");
    expect(ctx.loadAwareByKey.size).toBe(0);
  });

  it("on: the busy agent's work goes to the capable agent with spare capacity and is recorded", () => {
    const ctx = build({ projectSetting: true });
    expect(ctx.loadAwareRouting).toBe(true);
    // Cross-task snapshot says Frontend is already running its one slot.
    ctx.loadSnapshot.set("fe1", 1);
    expect(ctx.assign("ui1")?._id).toBe("fe2");
    expect(ctx.loadAwareByKey.get("ui1")).toMatchObject({ from: "Frontend", to: "Frontend B" });
    // Backend has no capable peer: never moved.
    ctx.loadSnapshot.set("be", 99);
    expect(ctx.assign("api")?._id).toBe("be");
    expect(ctx.loadAwareByKey.has("api")).toBe(false);
  });

  it("on via env default, but the project can turn it off", () => {
    expect(build({ policy: true }).loadAwareRouting).toBe(true);
    const ctx = build({ policy: true, projectSetting: false });
    ctx.loadSnapshot.set("fe1", 1);
    expect(ctx.assign("ui1")?._id).toBe("fe1");
  });

  it("this run's own running count counts as load", () => {
    const ctx = build({ projectSetting: true });
    expect(ctx.assign("ui1")?._id).toBe("fe1");
    ctx.activeByAgent.set("fe1", 1); // ui1 started
    expect(ctx.assign("ui2")?._id).toBe("fe2");
  });
});
