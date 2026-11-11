import { describe, expect, test } from "vitest";
import { codeRoleForRequest, findOfferedTask, wantsCodeInChat } from "./intent";
import { planWriteOffer } from "./writeOffer";
import { collectRepoEvidence, findUnverifiedRefs } from "./refCheck";
import { buildPlanningGuidance } from "../prompts/chat";

const team = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
  { _id: "ds", name: "Designer", role: "designer" },
];
const intent = { kind: "task", subtype: "implementation" };
const plan = (speaker: (typeof team)[number], text: string, extra: Partial<Parameters<typeof planWriteOffer>[0]> = {}) =>
  planWriteOffer({ speaker, isCto: speaker.role === "cto", addressed: true, team, text, taskIntent: intent, optionPick: false, ...extra });

describe("codeRoleForRequest", () => {
  test("files and words pick the role", () => {
    expect(codeRoleForRequest("buatkan file ultimate.html dengan background yang menarik")).toBe("frontend");
    expect(codeRoleForRequest("tolong buatkan bold.html dengan css dan js")).toBe("frontend");
    expect(codeRoleForRequest("tambah endpoint /users ke api")).toBe("backend");
    expect(codeRoleForRequest("buat migrasi schema.sql")).toBe("backend");
    expect(codeRoleForRequest("tambahkan tes untuk main.js")).toBeNull();
  });
});

describe("wantsCodeInChat", () => {
  test("only an explicit ask to see the code", () => {
    expect(wantsCodeInChat("tampilkan kodenya di sini")).toBe(true);
    expect(wantsCodeInChat("show me the code for a bold heading")).toBe(true);
    expect(wantsCodeInChat("contoh kode bold.html")).toBe(true);
    expect(wantsCodeInChat("tolong buatkan bold.html dengan teks Hello World")).toBe(false);
  });
});

describe("planWriteOffer", () => {
  test("an @mentioned code role takes its own request", () => {
    const p = plan(team[1], "tolong buatkan bold.html");
    expect(p.offer).toEqual({ kind: "implementation", assigneeAgentId: "fe" });
    expect(p.assignee?.name).toBe("Frontend");
  });
  test("the CTO routes an HTML file to Frontend", () => {
    expect(plan(team[0], "buatkan file ultimate.html").offer).toEqual({ kind: "implementation", assigneeAgentId: "fe" });
  });
  test("a non-code role routes by files; unclear requests carry no assignee", () => {
    expect(plan(team[3], "buatkan landing.html").offer?.assigneeAgentId).toBe("fe");
    expect(plan(team[0], "tambahkan tes untuk main.js").offer).toEqual({ kind: "implementation" });
  });
  test("no offer for chat, option picks, or a teammate the user did not address", () => {
    expect(plan(team[1], "bold.html?", { taskIntent: { kind: "chat" } }).offer).toBeNull();
    expect(plan(team[0], "buat x.html", { optionPick: true }).offer).toBeNull();
    expect(plan(team[1], "buat x.html", { addressed: false }).offer).toBeNull();
  });
  test("a run request keeps its commands and no assignee", () => {
    expect(plan(team[0], "tolong jalankan tes", { taskIntent: { kind: "task", subtype: "testing", runCommands: ["npm run test"] } }).offer).toEqual({
      kind: "testing",
      commands: ["npm run test"],
    });
  });
});

describe("findOfferedTask with a teammate's stored offer", () => {
  const roleOf = (id: string | undefined) => team.find((a) => a._id === id)?.role;
  test("'gas' after @Frontend's offer starts it, assigned to Frontend", () => {
    const history = [
      { authorType: "user", content: "@Frontend tolong buatkan bold.html" },
      { authorType: "agent", agentId: "fe", content: "Siap, lewat task.", taskOffer: { kind: "implementation", assigneeAgentId: "fe" } },
      { authorType: "user", content: "gas" },
    ];
    const offer = findOfferedTask(history, roleOf);
    expect(offer?.command).toContain("bold.html");
    expect(offer?.assigneeAgentId).toBe("fe");
  });
  test("a teammate reply that only says 'create task' offers nothing", () => {
    const history = [
      { authorType: "user", content: "@Frontend apa itu flexbox" },
      { authorType: "agent", agentId: "fe", content: "Kalau mau, create task saja." },
      { authorType: "user", content: "gas" },
    ];
    expect(findOfferedTask(history, roleOf)).toBeNull();
  });
});

describe("buildPlanningGuidance for write requests", () => {
  const ti = { kind: "task", frontend: true, backend: false, testing: false, security: false };
  test("CTO: one line in the user's language, handing it to the assignee; no fixed English plan line", () => {
    const text = buildPlanningGuidance({ role: "cto" }, { isOrchestrator: true, taskIntent: ti, assigneeName: "Frontend" }).join("\n");
    expect(text).toContain("hand it to Frontend as a task");
    expect(text).toContain("entirely in the user's language");
    expect(text).not.toContain("To execute this plan");
    expect(text).not.toMatch(/Propose a brief plan/);
  });
  test("specialist: short reply, no code dump, unless the user asked for code", () => {
    const short = buildPlanningGuidance({ role: "frontend" }, { isOrchestrator: false, taskIntent: ti, assigneeName: "Frontend" }).join("\n");
    expect(short).toContain("Do not paste the file");
    expect(short).toContain("never tell the user to save or create the file themselves");
    const code = buildPlanningGuidance({ role: "frontend" }, { isOrchestrator: false, taskIntent: ti, codeInChat: true }).join("\n");
    expect(code).toContain("show it");
    expect(code).not.toContain("Do not paste the file");
  });
});

describe("Unverified refs skip files the user asked for", () => {
  test("a requested file is not an artifact claim", () => {
    const empty = collectRepoEvidence([]);
    expect(findUnverifiedRefs("Saya buat bold.html dan style.css.", empty, null, 8, "tolong buatkan bold.html")).toEqual(["style.css"]);
    expect(findUnverifiedRefs("Lihat bold.html:12.", empty, null, 8, "buatkan bold.html")).toEqual(["bold.html:12"]);
  });
});
