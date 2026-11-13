import { describe, expect, it } from "vitest";
import { buildTaskStatusLine, fallbackOwner, resolveChatOwner } from "./owner";
import { buildChatMessages } from "../prompts/chat";

type M = { _id: string; name: string; role: string };
const team: M[] = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "des", name: "Designer", role: "designer" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
  { _id: "qa", name: "QA", role: "qa" },
  { _id: "ops", name: "DevOps", role: "devops" },
  { _id: "res", name: "Researcher", role: "researcher" },
  { _id: "sup", name: "Support", role: "support" },
];

const owner = (text: string, opts: { team?: M[]; history?: any[] } = {}) =>
  resolveChatOwner<M>({
    text,
    team: opts.team ?? team,
    history: [...(opts.history ?? []), { authorType: "user", content: text }],
    repoToolsAvailable: true,
  });
const who = (r: ReturnType<typeof owner>) => (r?.kind === "agent" ? r.agent.name : r?.kind ?? null);

describe("chat owner: deterministic, no LLM chooser", () => {
  it.each([
    ["kenapa query lambat?", "Backend"],
    ["warna ini cocok?", "Designer"],
    ["monorepo atau polyrepo?", "CTO"],
    ["CI gagal terus", "DevOps"],
    ["bandingkan prisma vs drizzle", "Researcher"],
    ["halo", "Support"],
    ["cara pakai Fhara?", "Support"],
    ["user tidak bisa login", "Support"],
    ["buatkan file ultimate.html dengan teks 'Ultimate is a new vision' dengan background yang menarik", "Frontend"],
  ])("%s → %s", (text, name) => {
    expect(who(owner(text))).toBe(name);
  });

  it("status → a System status line (no agent)", () => {
    expect(who(owner("sampai mana?"))).toBe("status");
  });

  it("no domain and no previous responder → Support; never the CTO by default", () => {
    expect(who(owner("menurutmu nama produk ini bagus?"))).toBe("Support");
    const noSupport = team.filter((a) => a.role !== "support" && a.role !== "researcher");
    expect(who(owner("menurutmu nama produk ini bagus?", { team: noSupport }))).not.toBe("CTO");
  });

  it("priority: previous responder > domain > Support", () => {
    const afterQa = [
      { authorType: "user", content: "tes apa yang kurang?" },
      { authorType: "agent", voice: "system", content: "Sent to QA" },
      { authorType: "agent", agentId: "qa", content: "main.js belum dites." },
    ];
    // The previous responder wins over a domain match, a greeting and the Support fallback.
    expect(owner("kenapa query lambat?", { history: afterQa })).toMatchObject({ agent: { name: "QA" }, via: "previous" });
    expect(owner("baca semua", { history: afterQa })).toMatchObject({ agent: { name: "QA" }, via: "previous" });
    expect(owner("halo", { history: afterQa })).toMatchObject({ agent: { name: "QA" }, via: "previous" });
    // No previous responder: the domain, then Support.
    expect(owner("kenapa query lambat?")).toMatchObject({ agent: { name: "Backend" }, via: "route" });
    expect(owner("baca semua")).toMatchObject({ agent: { name: "Support" }, via: "fallback" });
  });

  it("a previous responder no longer on the team is skipped", () => {
    const history = [
      { authorType: "user", content: "audit semua file" },
      { authorType: "agent", agentId: "gone", content: "..." },
    ];
    expect(owner("baca semua", { history })).toMatchObject({ agent: { name: "Support" }, via: "fallback" });
  });

  it("an option pick goes back to the agent that offered the options", () => {
    const history = [
      { authorType: "user", content: "kasih 3 opsi layout dashboard" },
      { authorType: "agent", voice: "system", content: "Sent to Designer" },
      { authorType: "agent", agentId: "des", content: "[options]..." },
    ];
    expect(who(owner("I choose B: Split view", { history }))).toBe("Designer");
  });

  it("a team with only the CTO still gets an answer", () => {
    expect(who(owner("menurutmu nama produk ini bagus?", { team: [team[0]] }))).toBe("CTO");
  });

  it("fallback order: Support, General, Researcher, then anyone but the CTO", () => {
    expect(fallbackOwner(team)?.name).toBe("Support");
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
