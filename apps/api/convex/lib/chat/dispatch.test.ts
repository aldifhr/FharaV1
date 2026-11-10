import { describe, expect, it } from "vitest";
import { dispatchHandoffLine, looksIndonesian, routeCtoQuestion } from "./dispatch";

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
];
const without = (...roles: string[]) => full.filter((a) => !roles.includes(a.role));
const route = (text: string, team: M[] = full, extra: Partial<Parameters<typeof routeCtoQuestion>[0]> = {}) =>
  routeCtoQuestion<M>({ text, team, orchestratorId: "cto", ...extra });
const to = (r: ReturnType<typeof route>) => (r.kind === "specialist" ? r.agent.role : "cto");

describe("CTO dispatch: domain routing (EN/ID)", () => {
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

describe("CTO dispatch: light questions stay with the CTO", () => {
  it.each([
    "halo",
    "thanks!",
    "status task sekarang gimana?",
    "what's the status of the release",
    "prioritas kita minggu ini apa?",
    "what should we work on next",
    "mulai dari mana ya",
    "cara restart worker?",
    "how do I add an agent",
    "",
    "menurutmu nama produk ini bagus?",
  ])("%s → CTO", (text) => {
    expect(route(text).kind).toBe("light");
  });

  it("a short how-to that asks for depth is not light", () => {
    expect(to(route("how do I audit the auth code"))).toBe("reviewer");
  });
});

describe("CTO dispatch: missing roles", () => {
  it("custom security agent wins over the reviewer", () => {
    const team = [...full, { _id: "sec", name: "Sentinel", role: "Security" }];
    expect(to(route("cek keamanan endpoint login", team))).toBe("Security");
  });
  it("security falls back to the reviewer", () => {
    expect(to(route("cek celah keamanan di login"))).toBe("reviewer");
  });
  it("security with no reviewer and no security role → CTO", () => {
    expect(route("cek celah keamanan di login", without("reviewer")).kind).toBe("light");
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
  it("role missing entirely → CTO", () => {
    expect(route("bandingkan zod vs valibot", without("researcher")).kind).toBe("light");
  });
  it("roles are matched case-insensitively with suffixes", () => {
    const team = [{ _id: "cto", name: "CTO", role: "cto" }, { _id: "q", name: "Tester", role: "QA Engineer" }];
    expect(to(route("what is our test coverage", team))).toBe("QA Engineer");
  });
  it("never routes to the CTO itself", () => {
    const team = [{ _id: "cto", name: "CTO", role: "reviewer" }];
    expect(route("please review the code", team).kind).toBe("light");
  });
  it("code audit without repo tools → CTO", () => {
    expect(route("tolong audit fungsi parseConfig", full, { repoToolsAvailable: false }).kind).toBe("light");
  });
  it("research does not need repo tools", () => {
    expect(to(route("bandingkan zod vs valibot", full, { repoToolsAvailable: false }))).toBe("researcher");
  });
});

describe("CTO dispatch: follow-ups", () => {
  const afterReviewer = [
    { authorType: "user", content: "tolong audit lib/config.ts" },
    { authorType: "agent", agentId: "cto", content: "Saya serahkan ke @Reviewer untuk audit `lib/config.ts`." },
    { authorType: "agent", agentId: "rev", content: "Ada 2 masalah di parseConfig..." },
  ];
  const afterCtoOnly = (q: string, a: string) => [
    { authorType: "user", content: q },
    { authorType: "agent", agentId: "cto", content: a },
  ];
  const ask = (history: Array<{ authorType: string; content: string; agentId?: string }>, text: string, opts = {}) =>
    route(text, full, { history: [...history, { authorType: "user", content: text }], ...opts });

  it.each(["coba cek lebih dalam", "lebih detail dong", "cek lagi"])(
    "'%s' goes back to the specialist who answered",
    (text) => {
      const r = ask(afterReviewer, text);
      expect(to(r)).toBe("reviewer");
      if (r.kind === "specialist") {
        expect(r.followUp).toBe(true);
        expect(r.topic).toBe("lib/config.ts");
      }
    }
  );

  it("'cek lagi' after a CTO-only answer is the CTO re-checking itself", () => {
    expect(ask(afterCtoOnly("prioritas minggu ini apa?", "Fokus ke login."), "cek lagi").kind).toBe("light");
  });

  it("'lebih detail' routes by the previous question's domain", () => {
    const h = afterCtoOnly("bandingkan zod vs valibot", "Zod lebih populer.");
    expect(to(ask(h, "lebih detail"))).toBe("researcher");
  });

  it("'cek lebih dalam' on code the CTO talked about → reviewer", () => {
    const h = afterCtoOnly("menurutmu gimana struktur ini?", "File `apps/api/convex/chat.ts` agak panjang.");
    const r = ask(h, "cek lebih dalam");
    expect(to(r)).toBe("reviewer");
    if (r.kind === "specialist") expect(r.topic).toBe("apps/api/convex/chat.ts");
  });

  it("follow-up with no previous turn stays with the CTO", () => {
    expect(ask([], "lebih detail").kind).toBe("light");
  });

  it("follow-up after a light question with no code stays with the CTO", () => {
    expect(ask(afterCtoOnly("prioritas minggu ini apa?", "Fokus login."), "lebih detail").kind).toBe("light");
  });

  it("a follow-up phrase with its own domain routes by that domain", () => {
    expect(to(ask(afterReviewer, "cek lebih dalam tesnya"))).toBe("qa");
  });

  it("follow-up back to the reviewer is skipped without repo tools", () => {
    expect(ask(afterReviewer, "cek lebih dalam", { repoToolsAvailable: false }).kind).toBe("light");
  });
});

describe("CTO dispatch: handoff line", () => {
  it("Indonesian with topic", () => {
    expect(dispatchHandoffLine({ name: "Reviewer" }, "reviewer", { topic: "lib/config.ts", indonesian: true })).toBe(
      "Saya serahkan ke @Reviewer untuk audit `lib/config.ts`."
    );
  });
  it("Indonesian without topic", () => {
    expect(dispatchHandoffLine({ name: "QA" }, "qa", { indonesian: true })).toBe("Saya serahkan ke @QA untuk pengecekan tes ini.");
  });
  it("English with and without topic", () => {
    expect(dispatchHandoffLine({ name: "Reviewer" }, "security", { topic: "auth.ts", indonesian: false })).toBe(
      "Handing this to @Reviewer for a security check of `auth.ts`."
    );
    expect(dispatchHandoffLine({ name: "Researcher" }, "researcher", { indonesian: false })).toBe(
      "Handing this to @Researcher for research."
    );
  });
  it("strips backticks from the topic", () => {
    expect(dispatchHandoffLine({ name: "R" }, "reviewer", { topic: "a`b", indonesian: false })).toBe("Handing this to @R for a code audit of `ab`.");
  });
  it("detects Indonesian copy", () => {
    expect(looksIndonesian("tolong audit kode ini")).toBe(true);
    expect(looksIndonesian("please review the code")).toBe(false);
  });
});
