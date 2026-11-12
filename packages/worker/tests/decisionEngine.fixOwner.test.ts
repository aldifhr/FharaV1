/**
 * P1b phase 3 (L7): `decideFixOwner`, the one answer to a stage loop's
 * `fix_needed`. Every branch: exhausted, unowned, QA's UI preference, the
 * writer pin, per-stage fix nodes (key, title, scope, order). The loops'
 * event sequences are pinned by tests/decisionEngine.golden.test.ts
 * (fix-* scenarios).
 */
import { describe, expect, it } from "vitest";
import {
  attributeFinding,
  decideFixOwner,
  fixRoundsExhausted,
  pickQaFixOwner,
  verifyFixKey,
  type FixNeededFacts,
} from "@/orchestrator/decisionEngine";
import { ROLES } from "@/api/convex/lib/roles";
import type { AgentDefinition, PlanSubtask } from "@/types";
import type { ReviewFinding } from "@/utils/json";

function fixed(role: keyof typeof ROLES, id: string = role): AgentDefinition {
  return {
    _id: id,
    name: ROLES[role].label,
    role,
    capabilities: [...ROLES[role].capabilities],
    supportedTools: [...ROLES[role].defaultTools],
    priority: ROLES[role].priority,
    isEnabled: true,
  };
}

const team = (["frontend", "backend", "qa", "reviewer", "designer"] as const).map((role) => fixed(role));
const byRole = (role: string) => team.find((agent) => agent.role === role)!;

const sub = (key: string, capability: string, order: number, extra: Partial<PlanSubtask> = {}): PlanSubtask => ({
  key,
  title: key,
  description: "",
  kind: "code_change",
  capability,
  dependencies: [],
  order,
  ...extra,
});

const UI = sub("ui", "frontend-development", 0, { allowedPaths: ["web/"] });
const API = sub("api", "backend-development", 3, { allowedPaths: ["api/"] });
const REVIEW = sub("review", "code-review", 4, { kind: "review" });
const finding = (filePath: string): ReviewFinding => ({ severity: "high", filePath, description: `bad ${filePath}`, suggestion: "fix it" });

const facts = (over: Partial<FixNeededFacts> = {}): FixNeededFacts => ({
  stage: "review",
  round: 0,
  maxRounds: 1,
  findings: [finding("api/server.ts")],
  nodes: [UI, API, REVIEW],
  writerByKey: new Map(),
  agents: team,
  ...over,
});

const keys = (taken: string[]) => (base: string) => {
  let key = base;
  for (let suffix = 2; taken.includes(key); suffix += 1) key = `${base}_${suffix}`;
  return key;
};
const decide = (over: Partial<FixNeededFacts> = {}, taken: string[] = []) =>
  decideFixOwner({ kind: "fix_needed", facts: facts(over) }, keys(taken));

describe("decideFixOwner: when the loop stops", () => {
  it("blocks as exhausted once the rounds are spent, before looking for an owner", () => {
    let calls = 0;
    const out = decideFixOwner({ kind: "fix_needed", facts: facts({ round: 1, maxRounds: 1, nodes: [] }) }, (base) => {
      calls += 1;
      return base;
    });
    expect(out).toEqual({ kind: "block", reason: "exhausted" });
    expect(calls).toBe(0);
    expect(decide({ round: 3, maxRounds: 1 })).toEqual({ kind: "block", reason: "exhausted" });
  });

  it("a zero-round budget is exhausted at round 0", () => {
    expect(decide({ round: 0, maxRounds: 0 })).toEqual({ kind: "block", reason: "exhausted" });
    expect(fixRoundsExhausted(0, 1)).toBe(false);
    expect(fixRoundsExhausted(1, 1)).toBe(true);
  });

  it("blocks as unowned when no code_change exists", () => {
    expect(decide({ nodes: [REVIEW] })).toEqual({ kind: "block", reason: "unowned" });
  });

  it("blocks as unowned when the only owner is a role that may not write", () => {
    expect(decide({ nodes: [UI], agents: [byRole("reviewer"), byRole("qa")] })).toEqual({ kind: "block", reason: "unowned" });
  });
});

describe("decideFixOwner: who fixes", () => {
  it("review: the longest-prefix owner, routed by capability when no writer is recorded", () => {
    const out = decide();
    expect(out.kind).toBe("spawn_fix");
    if (out.kind !== "spawn_fix") return;
    expect(out.ownerNodeKey).toBe("api");
    expect(out.agent.role).toBe("backend");
    expect(out.ownerAgentId).toBe(out.agent._id);
  });

  it("the agent that wrote the owner node wins over capability routing", () => {
    const writer = { ...byRole("backend"), _id: "backend-2", name: "Backend 2" };
    const out = decide({ agents: [...team, writer], writerByKey: new Map([["api", writer]]) });
    expect(out.kind === "spawn_fix" && out.ownerAgentId).toBe("backend-2");
  });

  it("a writer no longer on the roster falls back to capability routing", () => {
    const gone = { ...byRole("backend"), _id: "gone" };
    const out = decide({ writerByKey: new Map([["api", gone]]) });
    expect(out.kind === "spawn_fix" && out.ownerAgentId).toBe(byRole("backend")._id);
  });

  it("no finding path: the last code_change owns it", () => {
    const out = decide({ findings: [finding("")] });
    expect(out.kind === "spawn_fix" && out.ownerNodeKey).toBe("api");
  });

  it("qa: a UI implementer owns the fix even when the path points elsewhere", () => {
    const out = decide({ stage: "qa", findings: [finding("api/server.ts")] });
    expect(out.kind === "spawn_fix" && out.ownerNodeKey).toBe("ui");
    expect(out.kind === "spawn_fix" && out.agent.role).toBe("frontend");
  });

  it("qa without a UI node falls back to the shared rule", () => {
    const out = decide({ stage: "qa", nodes: [API, REVIEW] });
    expect(out.kind === "spawn_fix" && out.ownerNodeKey).toBe("api");
  });

  it("verify: no UI preference, the path owner wins", () => {
    const out = decide({ stage: "verify", findings: [finding("api/server.ts")] });
    expect(out.kind === "spawn_fix" && out.ownerNodeKey).toBe("api");
  });
});

describe("decideFixOwner: the fix node", () => {
  it("review: review_fix_<n>, no path scope, ordered after every node", () => {
    const out = decide({ round: 0, maxRounds: 2 });
    if (out.kind !== "spawn_fix") throw new Error("expected spawn_fix");
    expect(out.nodes).toHaveLength(1);
    const [fix] = out.nodes;
    expect(fix).toMatchObject({ key: "review_fix_1", title: "Address review findings (iteration 1)", kind: "code_change", capability: "backend-development", order: 5, dependencies: [] });
    expect(fix.allowedPaths).toBeUndefined();
    expect(fix.description).toContain("bad api/server.ts");
  });

  it("qa: fix_qa_<n>, unique key, scoped to the owner's paths (a copy)", () => {
    const out = decide({ stage: "qa", round: 1, maxRounds: 2 }, ["fix_qa_2"]);
    if (out.kind !== "spawn_fix") throw new Error("expected spawn_fix");
    const [fix] = out.nodes;
    expect(fix).toMatchObject({ key: "fix_qa_2_2", title: "Address QA failures (iteration 2)", capability: "frontend-development", allowedPaths: ["web/"] });
    expect(fix.allowedPaths).not.toBe(UI.allowedPaths);
  });

  it("qa: an owner without paths gives an unscoped fix", () => {
    const out = decide({ stage: "qa", nodes: [sub("ui2", "frontend-development", 0)] });
    expect(out.kind === "spawn_fix" && out.nodes[0].allowedPaths).toBeUndefined();
  });

  it("verify phase 0: the legacy fix_verify_<n> key and title", () => {
    const out = decide({ stage: "verify" });
    if (out.kind !== "spawn_fix") throw new Error("expected spawn_fix");
    expect(out.nodes[0]).toMatchObject({ key: "fix_verify_1", title: "Address verification failures (iteration 1)", allowedPaths: ["api/"] });
  });

  it("verify after a QA fix round: the phase rides in key and title", () => {
    const out = decide({ stage: "verify", verifyPhase: 2, round: 0, maxRounds: 1 });
    if (out.kind !== "spawn_fix") throw new Error("expected spawn_fix");
    expect(out.nodes[0]).toMatchObject({ key: "fix_verify_qa2_1", title: "Address verification failures (after QA fix 2, iteration 1)" });
  });
});

describe("moved helpers keep their behaviour", () => {
  it("verifyFixKey", () => {
    expect(verifyFixKey(0, 3)).toBe("fix_verify_3");
    expect(verifyFixKey(1, 2)).toBe("fix_verify_qa1_2");
  });

  it("attributeFinding", () => {
    expect(attributeFinding({ files: ["x.ts", "a.ts"] }, ["a.ts"])).toBe("a.ts");
    expect(attributeFinding({}, [])).toBe("");
  });

  it("pickQaFixOwner prefers UI nodes, else the shared rule", () => {
    expect(pickQaFixOwner([UI, API], [{ filePath: "api/x.ts" }])?.key).toBe("ui");
    expect(pickQaFixOwner([API], [{ filePath: "api/x.ts" }])?.key).toBe("api");
    expect(pickQaFixOwner([REVIEW], [])).toBeUndefined();
  });
});
