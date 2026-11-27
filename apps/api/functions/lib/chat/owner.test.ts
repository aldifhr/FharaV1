import { describe, expect, it } from "vitest";
import { buildTaskStatusLine, fallbackOwner, resolveChatOwner } from "./owner";
import { buildChatMessages } from "../prompts/chat";
import type { RoutingClassification } from "./routingClassification";

type M = { _id: string; name: string; role: string };
const team: M[] = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "des", name: "Designer", role: "designer" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
  { _id: "qa", name: "QA", role: "qa" },
  { _id: "ops", name: "DevOps", role: "devops" },
];

const routing = (role: RoutingClassification["role"], files: string[] = []): RoutingClassification => ({
  role,
  kind: "implementation",
  files,
  confidence: 0.9,
});
const owner = (text: string, opts: { team?: M[]; history?: any[]; routing?: RoutingClassification | null } = {}) =>
  resolveChatOwner<M>({
    text,
    team: opts.team ?? team,
    history: [...(opts.history ?? []), { authorType: "user", content: text }],
    routing: opts.routing,
  });
const who = (r: ReturnType<typeof owner>) => (r?.kind === "agent" ? r.agent.name : r?.kind ?? null);

describe("chat owner: structured routing only", () => {
  it("uses the validated classifier role, never the CTO as executor", () => {
    expect(who(owner("any language", { routing: routing("frontend") }))).toBe("Frontend");
    expect(who(owner("any language", { routing: routing("devops") }))).toBe("DevOps");
    expect(who(owner("any language", { routing: routing("cto") }))).toBe("CTO");
  });

  it("no classifier role falls back to a named file, then the CTO conversationally", () => {
    expect(who(owner("ubah ultimate.html", { routing: routing(null, ["ultimate.html"]) }))).toBe("Frontend");
    expect(who(owner("menurutmu nama produk ini bagus?"))).toBe("CTO");
    expect(who(owner("menurutmu nama produk ini bagus?", { team: team.filter((a) => a.role !== "cto") }))).toBe("Designer");
  });

  it("previous responder wins over a new classification", () => {
    const afterQa = [
      { authorType: "user", content: "tes apa yang kurang?" },
      { authorType: "agent", agentId: "qa", content: "main.js belum dites." },
    ];
    expect(owner("kenapa query lambat?", { history: afterQa, routing: routing("backend") })).toMatchObject({ agent: { name: "QA" }, via: "previous" });
  });

  it("a previous responder no longer on the team is skipped", () => {
    const history = [
      { authorType: "user", content: "audit semua file" },
      { authorType: "agent", agentId: "gone", content: "..." },
    ];
    expect(who(owner("baca semua", { history }))).toBe("CTO");
  });

  it("an option pick goes back to the agent that offered the options", () => {
    const history = [
      { authorType: "user", content: "kasih 3 opsi layout dashboard" },
      { authorType: "agent", agentId: "des", content: "[options]..." },
    ];
    expect(who(owner("I choose B: Split view", { history }))).toBe("Designer");
  });

  it("a team with only the CTO still gets an answer", () => {
    expect(who(owner("menurutmu nama produk ini bagus?", { team: [team[0]] }))).toBe("CTO");
  });

  it("fallback order: General, Researcher, then anyone but the CTO", () => {
    expect(fallbackOwner([{ _id: "g", name: "General", role: "general" }, team[0]])?.name).toBe("General");
    expect(fallbackOwner([{ _id: "r", name: "Researcher", role: "researcher" }, team[0]])?.name).toBe("Researcher");
    expect(fallbackOwner([team[0], team[3]])?.name).toBe("Backend");
    expect(fallbackOwner([])).toBeNull();
  });
});

describe("System status line (no LLM)", () => {
  it("running and waiting tasks, with owners", () => {
    expect(
      buildTaskStatusLine([
        { title: "CSV export", status: "running", assigneeNames: ["Backend"] },
        { title: "Login fix", status: "queued" },
        { title: "Profile page", status: "needs_approval", assigneeNames: ["Frontend"] },
        { title: "Old", status: "done" },
      ])
    ).toBe("2 tasks running: 'CSV export' (Backend), 'Login fix' · 1 waiting for approval: 'Profile page' (Frontend)");
  });
  it("nothing running", () => {
    expect(buildTaskStatusLine([{ title: "Old", status: "done" }])).toBe("Nothing running");
    expect(buildTaskStatusLine([])).toBe("Nothing running");
  });
});

describe("System lines never reach a model", () => {
  it("buildChatMessages drops System rows from a specialist's transcript", () => {
    const msgs = buildChatMessages(
      [
        { authorType: "user", content: "kenapa query lambat?" },
        { authorType: "agent", voice: "system", content: "Sent to Backend" },
        { authorType: "agent", agentId: "be", content: "Index users belum ada." },
        { authorType: "user", content: "lebih detail" },
      ],
      { selfAgentId: "be" }
    );
    expect(msgs.map((m) => m.content).join("\n")).not.toContain("Sent to");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "lebih detail" });
  });
});
