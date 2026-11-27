import { describe, expect, it } from "vitest";
import { chatPreRouteAllowed, codeTargetOf, mentionsCode, previousResponder, systemRoutingLine } from "./dispatch";

type M = { _id: string; name: string; role: string };
const team: M[] = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
];

describe("previous responder keeps the conversation", () => {
  const history = [
    { authorType: "user", content: "kenapa query lambat?" },
    { authorType: "agent", voice: "system", content: "Sent to Backend" },
    { authorType: "agent", agentId: "be", content: "Index users belum ada." },
    { authorType: "user", content: "lebih detail" },
  ];

  it("skips System lines and returns the last real answer", () => {
    expect(previousResponder(history, team)?._id).toBe("be");
  });

  it("ignores replies whose agent is no longer on the team", () => {
    expect(previousResponder([{ authorType: "user", content: "x" }, { authorType: "agent", agentId: "ghost", content: "y" }, { authorType: "user", content: "z" }], team)).toBeNull();
  });
});

describe("code targets are syntax detection, not owner routing", () => {
  it("finds a path, backticked name or identifier", () => {
    expect(codeTargetOf("tolong lihat lib/config.ts")).toBe("lib/config.ts");
    expect(codeTargetOf("periksa `parseConfig`")).toBe("parseConfig");
    expect(mentionsCode("ubah src/a.tsx")).toBe(true);
    expect(mentionsCode("halo")).toBe(false);
  });
});

describe("System routing line (English, no @name)", () => {
  it("one and several owners", () => {
    expect(systemRoutingLine([{ name: "Backend" }])).toBe("Sent to Backend");
    expect(systemRoutingLine([{ name: "Backend" }, { name: "Designer" }])).toBe("Sent to Backend and Designer");
    expect(systemRoutingLine([{ name: "A" }, { name: "B" }, { name: "C" }])).toBe("Sent to A, B and C");
    expect(systemRoutingLine([])).toBe("");
    expect(systemRoutingLine([{ name: "Backend" }])).not.toContain("@");
  });
});

describe("chat pre-route gate (deterministic)", () => {
  const base = { optionPick: false, pasted: false, workShaped: false, runRequest: false };
  const gate = (text: string, intent: { intent: string; subtype: string }, extra: Partial<typeof base> = {}) =>
    chatPreRouteAllowed({ text, intent, ...base, ...extra });

  it("lets questions through whatever the classifier label says", () => {
    expect(gate("tolong audit kode src/", { intent: "task", subtype: "audit" })).toBe(true);
    expect(gate("tolong audit kode src/", { intent: "ask", subtype: "explanation" })).toBe(true);
  });

  it("keeps work, run requests, pastes and option picks out of the pre-route", () => {
    expect(gate("tambahkan tes login", { intent: "task", subtype: "implementation" }, { workShaped: true })).toBe(false);
    expect(gate("tolong jalankan tes", { intent: "task", subtype: "testing" }, { runRequest: true })).toBe(false);
    expect(gate("kata dia: audit", { intent: "ask", subtype: "explanation" }, { pasted: true })).toBe(false);
    expect(gate("I choose A: x", { intent: "ask", subtype: "recommendation" }, { optionPick: true })).toBe(false);
  });
});
