import { describe, expect, it } from "vitest";
import { chatPreRouteAllowed, isHandoffLine, looksIndonesian, routeQuestion, systemRoutingLine } from "./dispatch";

type M = { _id: string; name: string; role: string };
const full: M[] = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "des", name: "Designer", role: "designer" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
  { _id: "qa", name: "QA", role: "qa" },
  { _id: "ops", name: "DevOps", role: "devops" },
  { _id: "rev", name: "Reviewer", role: "reviewer" },
  { _id: "res", name: "Researcher", role: "researcher" },
  { _id: "sup", name: "Support", role: "support" },
];
const without = (...roles: string[]) => full.filter((a) => !roles.includes(a.role));
const route = (text: string, team: M[] = full, extra: Partial<Parameters<typeof routeQuestion>[0]> = {}) =>
  routeQuestion<M>({ text, team, ...extra });
/** The routed role, or "status" / "none". */
const to = (r: ReturnType<typeof route>) => (r.kind === "specialist" ? r.agent.role : r.kind);

describe("O3 routing table: every role owns its topics, no CTO default", () => {
  it.each([
    // §5 chat rows (role-flow-examples-2026-11-11.md)
    ["monorepo atau polyrepo untuk project ini?", "cto"],
    ["should we split the API into microservices?", "cto"],
    ["S3 vs local untuk upload file?", "cto"],
    ["warna ini cocok?", "designer"],
    ["kenapa query lambat?", "backend"],
    ["CI gagal di github actions", "devops"],
    ["bandingkan zod vs valibot", "researcher"],
    ["user tidak bisa login, kenapa?", "support"],
    ["users can't log in after the update", "support"],
    ["cara pakai fitur export?", "support"],
    // greetings and short how-to → Support
    ["halo", "support"],
    ["thanks!", "support"],
    ["how do I add an agent", "support"],
    ["cara restart worker?", "support"],
    // planning → CTO
    ["prioritas kita minggu ini apa?", "cto"],
    ["what should we work on next", "cto"],
    ["mulai dari mana ya", "cto"],
  ])("%s → %s", (text, role) => {
    expect(to(route(text))).toBe(role);
  });

  it("a short status question is a System status line, not an LLM reply", () => {
    expect(route("sampai mana?").kind).toBe("status");
    expect(route("status task sekarang gimana?").kind).toBe("status");
    expect(route("what's the status of the release").kind).toBe("status");
  });

  it("'status code 500' is a technical question, not a status check", () => {
    expect(route("kenapa API balikin status code 500?").kind).not.toBe("status");
  });

  it("nothing matched → none (the caller falls back to Support; never a CTO default)", () => {
    expect(route("menurutmu nama produk ini bagus?").kind).toBe("none");
    expect(to(route(""))).toBe("support");
  });

  it("greeting with no Support in the team → none (fallback picks, not the CTO)", () => {
    expect(route("halo", without("support")).kind).toBe("none");
  });

  it("planning with no CTO in the team → none", () => {
    expect(route("prioritas kita minggu ini apa?", without("cto")).kind).toBe("none");
  });
});

describe("routing: domains (EN/ID)", () => {
  it.each([
    ["tolong audit fungsi parseConfig di lib/config.ts", "reviewer"],
    ["please review the auth middleware code", "reviewer"],
    ["cek keamanan endpoint login", "reviewer"], // no security role → reviewer
    ["is there an XSS risk in the comment form?", "reviewer"],
    ["kenapa tes di packages/worker flaky?", "qa"],
    ["what is our unit test coverage like?", "qa"],
    ["pipeline CI gagal terus di github actions", "devops"],
    ["how should we set up the docker deploy for staging and prod", "devops"],
    ["bandingkan zod vs valibot untuk validasi", "researcher"],
    ["research the best library for PDF rendering", "researcher"],
    ["warna palet halaman landing kurang enak", "designer"],
    ["what do you think of the typography on the dashboard", "designer"],
    ["komponen modal di halaman settings nggak responsif", "frontend"],
    ["the react button component looks broken", "frontend"],
    ["skema database untuk tabel tasks perlu index apa", "backend"],
    ["which convex query does the inbox endpoint use", "backend"],
    ["desain tabel log bagusnya gimana?", "backend"],
    ["what do you think about the design api for uploads", "backend"],
  ])("%s → %s", (text, role) => {
    expect(to(route(text))).toBe(role);
  });

  it("a code path or identifier becomes the topic", () => {
    const r = route("tolong audit fungsi parseConfig di lib/config.ts");
    expect(r.kind).toBe("specialist");
    if (r.kind === "specialist") {
      expect(r.topic).toBe("lib/config.ts");
      expect(r.followUp).toBe(false);
    }
  });
});

describe("routing: how-to", () => {
  it("a short how-to on a topic goes to the topic owner", () => {
    expect(to(route("how do I deploy to vercel"))).toBe("devops");
  });
  it("a short how-to that asks for depth is not light", () => {
    expect(to(route("how do I audit the auth code"))).toBe("reviewer");
  });
});

describe("routing: missing roles", () => {
  it("custom security agent wins over the reviewer", () => {
    const team = [...full, { _id: "sec", name: "Sentinel", role: "Security" }];
    expect(to(route("cek keamanan endpoint login", team))).toBe("Security");
  });
  it("security falls back to the reviewer", () => {
    expect(to(route("cek celah keamanan di login"))).toBe("reviewer");
  });
  it("security with no reviewer and no security role → none", () => {
    expect(route("cek celah keamanan di login", without("reviewer")).kind).toBe("none");
  });
  it("designer question goes to frontend when there is no designer", () => {
    expect(to(route("warna palet halaman landing kurang enak", without("designer")))).toBe("frontend");
  });
  it("frontend question goes to designer when there is no frontend", () => {
    expect(to(route("the react button component looks broken", without("frontend")))).toBe("designer");
  });
  it("a ui-ux role counts as designer", () => {
    const team = [...without("designer", "frontend"), { _id: "ux", name: "UX", role: "UI UX" }];
    expect(to(route("what do you think of the typography", team))).toBe("UI UX");
  });
  it("role missing entirely → none", () => {
    expect(route("bandingkan zod vs valibot", without("researcher")).kind).toBe("none");
  });
  it("roles are matched case-insensitively with suffixes", () => {
    const team = [{ _id: "cto", name: "CTO", role: "cto" }, { _id: "q", name: "Tester", role: "QA Engineer" }];
    expect(to(route("what is our test coverage", team))).toBe("QA Engineer");
  });
  it("routes by role, not by name", () => {
    const team = [{ _id: "cto", name: "CTO", role: "reviewer" }];
    expect(to(route("please review the code", team))).toBe("reviewer");
  });
  it("code audit without repo tools still goes to its owner (no CTO fallback)", () => {
    expect(to(route("tolong audit fungsi parseConfig", full, { repoToolsAvailable: false }))).toBe("reviewer");
  });
  it("without repo tools a domain that needs no repo wins over a code-bound one", () => {
    expect(to(route("bandingkan library untuk fungsi parseConfig", full, { repoToolsAvailable: false }))).toBe("researcher");
  });
  it("research does not need repo tools", () => {
    expect(to(route("bandingkan zod vs valibot", full, { repoToolsAvailable: false }))).toBe("researcher");
  });
});

describe("routing: the previous responder keeps the conversation", () => {
  const afterReviewer = [
    { authorType: "user", content: "tolong audit lib/config.ts" },
    { authorType: "agent", agentId: "cto", content: "Saya serahkan ke @Reviewer untuk audit `lib/config.ts`." },
    { authorType: "agent", agentId: "rev", content: "Ada 2 masalah di parseConfig..." },
  ];
  const ask = (history: Array<{ authorType: string; content: string; agentId?: string; voice?: string }>, text: string, opts = {}) =>
    route(text, full, { history: [...history, { authorType: "user", content: text }], ...opts });

  it.each(["baca semua", "kan saya minta semua dibaca kocak", "coba cek lebih dalam", "lanjut", "sisanya?"])(
    "'%s' goes back to the agent who answered (no phrase list)",
    (text) => {
      const r = ask(afterReviewer, text);
      expect(to(r)).toBe("reviewer");
      expect(r.kind === "specialist" && r.followUp).toBe(true);
    }
  );

  it("wins over a domain match (switch with an @mention)", () => {
    expect(to(ask(afterReviewer, "cek lebih dalam tesnya"))).toBe("reviewer");
    expect(to(ask(afterReviewer, "bandingkan zod vs valibot"))).toBe("reviewer");
  });

  it("a status question is still a System status line", () => {
    expect(ask(afterReviewer, "sampai mana?").kind).toBe("status");
  });

  it("System lines and old handoff lines are skipped", () => {
    const h = [
      { authorType: "user", content: "kenapa query lambat?" },
      { authorType: "agent", voice: "system", content: "Sent to Backend" },
      { authorType: "agent", agentId: "be", content: "Index users belum ada." },
    ];
    expect(to(ask(h, "lebih detail"))).toBe("backend");
    expect(to(ask([{ authorType: "user", content: "x" }, { authorType: "agent", agentId: "cto", content: "Saya serahkan ke @Reviewer untuk audit `x`." }], "lebih detail"))).toBe("none");
  });

  it("no previous responder → the usual rules", () => {
    expect(ask([], "lebih detail").kind).toBe("none");
    expect(to(ask([], "cek lebih dalam tesnya"))).toBe("qa");
  });

  it("works without repo tools too", () => {
    expect(to(ask(afterReviewer, "cek lebih dalam", { repoToolsAvailable: false }))).toBe("reviewer");
  });

  it("a custom role with no domain keeps the conversation with a null domain", () => {
    const team = [...full, { _id: "gen", name: "Helper", role: "general" }];
    const r = route("terus?", team, { history: [{ authorType: "user", content: "hi" }, { authorType: "agent", agentId: "gen", content: "Hello" }, { authorType: "user", content: "terus?" }] });
    expect(r.kind === "specialist" && r.agent.name).toBe("Helper");
    expect(r.kind === "specialist" && r.domain).toBeNull();
  });
});

describe("System routing line (§2.5: English, no @name)", () => {
  it("one and several owners", () => {
    expect(systemRoutingLine([{ name: "Backend" }])).toBe("Sent to Backend");
    expect(systemRoutingLine([{ name: "Backend" }, { name: "Designer" }])).toBe("Sent to Backend and Designer");
    expect(systemRoutingLine([{ name: "A" }, { name: "B" }, { name: "C" }])).toBe("Sent to A, B and C");
    expect(systemRoutingLine([])).toBe("");
    expect(systemRoutingLine([{ name: "Backend" }])).not.toContain("@");
  });
  it("old CTO handoff rows are still recognised (kept out of transcripts)", () => {
    expect(isHandoffLine("Saya serahkan ke @Reviewer untuk audit `lib/config.ts`.")).toBe(true);
    expect(isHandoffLine("Handing this to @Researcher for research.")).toBe(true);
  });
  it("detects Indonesian copy", () => {
    expect(looksIndonesian("tolong audit kode ini")).toBe(true);
    expect(looksIndonesian("please review the code")).toBe(false);
  });
});

describe("chat pre-route gate (deterministic, live2 3a/3f)", () => {
  const base = { optionPick: false, pasted: false, workShaped: false, runRequest: false };
  const gate = (text: string, intent: { intent: string; subtype: string }, extra: Partial<typeof base> = {}) =>
    chatPreRouteAllowed({ text, intent, ...base, ...extra });

  it("routes whatever the LLM's audit/review/research label says", () => {
    expect(gate("tolong audit kode src/", { intent: "task", subtype: "audit" })).toBe(true);
    expect(gate("tolong audit kode src/", { intent: "task", subtype: "research" })).toBe(true);
    expect(gate("tolong audit kode src/", { intent: "ask", subtype: "explanation" })).toBe(true);
  });

  it("work stays with the CTO: change requests, run requests, pastes, option picks, LLM implementation", () => {
    expect(gate("tambahkan tes login", { intent: "task", subtype: "implementation" }, { workShaped: true })).toBe(false);
    expect(gate("tolong jalankan tes", { intent: "task", subtype: "testing" }, { runRequest: true })).toBe(false);
    expect(gate("kata dia: audit", { intent: "ask", subtype: "explanation" }, { pasted: true })).toBe(false);
    expect(gate("I choose A: x", { intent: "ask", subtype: "recommendation" }, { optionPick: true })).toBe(false);
    expect(gate("halaman checkout lambat sekali", { intent: "task", subtype: "implementation" })).toBe(false);
  });
});

