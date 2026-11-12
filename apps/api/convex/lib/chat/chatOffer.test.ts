import { describe, expect, test } from "vitest";
import { classifyChatIntent, findOfferedTask, GREETING, hasAskShape, isGoReply, type ChatTaskOffer } from "./intent";
import { buildOfferBrief, inferStack, isPoliteWriteRequest, offerPlanLine, replyNeedsTask } from "./offerBrief";
import { offerForReply, planWriteOffer } from "./writeOffer";
import { buildPersonalChatSystem, buildPlanningGuidance, buildChatPersonaLines } from "../prompts/chat";
import { ROLE_PROMPT_TEMPLATES } from "../prompts/rolePrompts.data";

// chat-offer lane: "can you create file index.html" in a project chat was routed to Frontend, which answered
// "I can't write files from this read-only session. Create a task for the worker…" and asked for the stack.
const team = [
  { _id: "cto", name: "CTO", role: "cto" },
  { _id: "fe", name: "Frontend", role: "frontend" },
  { _id: "be", name: "Backend", role: "backend" },
];
const fe = team[1];
const roleOf = (id: string | undefined) => team.find((a) => a._id === id)?.role;
const ASK = "can you create file index.html";
const EMPTY_SNAPSHOT = "Workspace snapshot (/repo):\n";

describe("a chat write request produces an offer with a brief", () => {
  test("the polite ask is a write request, not a capability question", () => {
    expect(isPoliteWriteRequest(ASK)).toBe(true);
    expect(isPoliteWriteRequest("could you add a login page?")).toBe(true);
    expect(isPoliteWriteRequest("bisa buatkan file index.html?")).toBe(true);
    expect(hasAskShape(ASK)).toBe(false);
    expect(classifyChatIntent(ASK).kind).toBe("task");
    for (const t of ["can you be CTO?", "can you create files?", "can you create a file?", "how can you create index.html?", "can you explain index.html?"]) {
      expect(isPoliteWriteRequest(t)).toBe(false);
    }
    expect(hasAskShape("can you be CTO?")).toBe(true);
  });

  test("routed to Frontend: offer assigned to Frontend with a plain HTML brief", () => {
    const write = planWriteOffer({ speaker: fe, isCto: false, addressed: true, team, text: ASK, taskIntent: { kind: classifyChatIntent(ASK).kind }, optionPick: false, repoSnapshot: EMPTY_SNAPSHOT });
    expect(write.plan).toBe("I'll add a plain HTML index.html at the repo root.");
    expect(write.offer).toEqual({
      kind: "implementation",
      assigneeAgentId: "fe",
      brief: `Add a plain HTML index.html at the repo root.\n\nRequest: ${ASK}`,
      // P1a: the routing hint the task inherits (owner, intent, plan line, files).
      hint: { source: "offer", role: "frontend", kind: "implementation", brief: "I'll add a plain HTML index.html at the repo root.", files: ["index.html"] },
    });
  });

  test("the stack comes from the repo; no framework means plain HTML", () => {
    expect(inferStack(EMPTY_SNAPSHOT)).toBe("plain HTML");
    expect(inferStack(null)).toBe("plain HTML");
    expect(inferStack('--- package.json ---\n{"dependencies":{"next":"15.0.0","react":"19"}}')).toBe("Next.js");
    expect(inferStack('{"dependencies":{"react":"19"},"devDependencies":{"vite":"6"}}')).toBe("React/Vite");
    expect(offerPlanLine("can you create file index.html", "Next.js")).toBe("I'll add index.html at the repo root, using this Next.js project's setup.");
    expect(offerPlanLine("can you fix src/app.ts", "plain HTML")).toBe("I'll update src/app.ts.");
    expect(offerPlanLine("add tests for main.js", "plain HTML")).toBeNull();
    expect(buildOfferBrief("x", null)).toBeUndefined();
  });

  test("the reply offers the task when the classifier missed the request", () => {
    const write = planWriteOffer({ speaker: fe, isCto: false, addressed: true, team, text: "tolong rapikan halaman login", taskIntent: { kind: "chat" }, optionPick: false });
    expect(write.offer).toBeNull();
    expect(offerForReply(write, "I'll tidy the login page. Chat can't change files. Want me to create a task for it?")).toEqual({
      kind: "implementation",
      assigneeAgentId: "fe",
      hint: { source: "offer", role: "frontend", kind: "implementation" },
    });
    expect(offerForReply(write, "Flexbox lays items out in one direction.")).toBeNull();
    expect(replyNeedsTask("I can't write files from this read-only session. Create a task for the worker to add index.html.")).toBe(true);
  });

  test("the role prompt states the plan and the plain wording", () => {
    const lines = buildPlanningGuidance(fe, { isOrchestrator: false, hasRepoTools: true, taskIntent: { kind: "task", frontend: true, backend: false, testing: false, security: false }, assigneeName: "Frontend", plan: "I'll add a plain HTML index.html at the repo root." }).join("\n");
    expect(lines).toContain("I'll add a plain HTML index.html at the repo root.");
    expect(lines).toContain("Chat can't change files. Want me to create a task for it?");
  });
});

describe("'gas' after the offer creates exactly one task", () => {
  const offer = { kind: "implementation", assigneeAgentId: "fe", brief: `Add a plain HTML index.html at the repo root.\n\nRequest: ${ASK}` };
  type Row = { authorType: string; content: string; agentId?: string; voice?: string; taskOffer?: ChatTaskOffer };
  const history = (go: string): Row[] => [
    { authorType: "user", content: ASK },
    { authorType: "agent", content: "Sent to Frontend", voice: "system" },
    { authorType: "agent", agentId: "fe", content: "I'll add a plain HTML index.html at the repo root. Chat can't change files. Want me to create a task for it?", taskOffer: offer },
    { authorType: "user", content: go },
  ];
  test.each(["gas", "lanjut", "yes", "ok"])("%s starts the prefilled brief", (go) => {
    expect(isGoReply(go)).toBe(true);
    const found = findOfferedTask(history(go), roleOf);
    expect(found?.command).toBe(offer.brief);
    expect(found?.assigneeAgentId).toBe("fe");
  });
  test("a used offer starts nothing more", () => {
    const h = history("gas");
    h[2] = { ...h[2], taskOffer: { ...offer, usedTaskId: "t1" } };
    expect(findOfferedTask(h, roleOf)).toBeNull();
  });
});

describe("a greeting does not create an offer", () => {
  test.each(["hi", "hello", "halo"])("%s", (text) => {
    expect(GREETING.test(text)).toBe(true);
    expect(classifyChatIntent(text).kind).toBe("chat");
    const write = planWriteOffer({ speaker: fe, isCto: false, addressed: true, team, text, taskIntent: { kind: "chat" }, optionPick: false });
    expect(write.offer).toBeNull();
    expect(offerForReply(write, "Hi! What are we building today?")).toBeNull();
  });
});

describe("prompt text never says 'read-only session'", () => {
  test("chat prompts and role templates", () => {
    const agent = { name: "Frontend", role: "frontend", systemPrompt: ROLE_PROMPT_TEMPLATES.frontend };
    const texts = [
      ...buildChatPersonaLines(agent, "demo", team, "snapshot", true),
      ...buildChatPersonaLines(agent, "demo", team, "snapshot", false),
      ...buildPlanningGuidance(fe, { isOrchestrator: false, hasRepoTools: true, taskIntent: { kind: "chat", frontend: true, backend: false, testing: false, security: false } }),
      ...buildPlanningGuidance(team[0], { isOrchestrator: true, taskIntent: { kind: "task", frontend: true, backend: false, testing: false, security: false } }),
      ...buildPersonalChatSystem(agent, { projectName: "demo", repoSnapshot: "snapshot", repoTools: true }),
      ...Object.values(ROLE_PROMPT_TEMPLATES),
    ].join("\n");
    expect(texts).not.toMatch(/read-only session/i);
    expect(ROLE_PROMPT_TEMPLATES.frontend).toContain("Chat can't change files. Want me to create a task for it?");
  });
});
