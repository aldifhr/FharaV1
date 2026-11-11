import { describe, expect, it, vi } from "vitest";
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

const owner = (text: string, opts: { team?: M[]; history?: any[]; optionPick?: boolean; choose?: (pool: M[]) => Promise<string | null> } = {}) =>
  resolveChatOwner<M>({
    text,
    team: opts.team ?? team,
    history: [...(opts.history ?? []), { authorType: "user", content: text }],
    repoToolsAvailable: true,
    optionPick: opts.optionPick ?? false,
    choose: opts.choose ?? (async () => null),
  });
const who = async (p: ReturnType<typeof owner>) => {
  const r = await p;
  return r?.kind === "agent" ? r.agent.name : r?.kind ?? null;
};

describe("O3 chat owner: System routes, the topic owner answers", () => {
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
  ])("%s → %s", async (text, name) => {
    expect(await who(owner(text))).toBe(name);
  });

  it("status → a System status line (no agent, no chooser call)", async () => {
    const choose = vi.fn(async () => "be");
    expect(await who(owner("sampai mana?", { choose }))).toBe("status");
    expect(choose).not.toHaveBeenCalled();
  });

  it("no domain: the chooser picks from the team without the CTO", async () => {
    const choose = vi.fn(async (pool: M[]) => {
      expect(pool.map((a) => a.role)).not.toContain("cto");
      return "fe";
    });
    expect(await who(owner("menurutmu nama produk ini bagus?", { choose }))).toBe("Frontend");
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("chooser unavailable → Support; never the CTO by default", async () => {
    expect(await who(owner("menurutmu nama produk ini bagus?"))).toBe("Support");
    const noSupport = team.filter((a) => a.role !== "support" && a.role !== "researcher");
    expect(await who(owner("menurutmu nama produk ini bagus?", { team: noSupport }))).not.toBe("CTO");
  });

  it("an option pick goes back to the agent that offered the options", async () => {
    const history = [
      { authorType: "user", content: "kasih 3 opsi layout dashboard" },
      { authorType: "agent", voice: "system", content: "Sent to Designer" },
      { authorType: "agent", agentId: "des", content: "[options]..." },
    ];
    expect(await who(owner("I choose B: Split view", { history, optionPick: true }))).toBe("Designer");
  });

  it("a team with only the CTO still gets an answer", async () => {
    expect(await who(owner("menurutmu nama produk ini bagus?", { team: [team[0]] }))).toBe("CTO");
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
