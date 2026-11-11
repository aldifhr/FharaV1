// Plan N7: native questions in direct (ACP) threads. OpenCode's question tool
// asks; its permission request becomes a question card, is answered
// "cancelled" with an answered-in-chat note, the agent ends its turn, and the
// answer (the user's, or the CTO's within policy) arrives as the next message.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpEngine } from "@/direct/acpSession";
import { directPreamble } from "@/direct";
import { ThreadRunner, type DirectStatePatch, type DirectStore, type StoredEvent } from "@/direct/threadRunner";
import { QUESTION_PREAMBLE, questionFromToolCall, type QuestionAskCall, type QuestionRouted } from "@/direct/nativeQuestion";
import { opencodeConfig } from "@/vendor/threadbear/acp/agents";
import { silentLogger } from "@/vendor/threadbear/acp/connection";
import { classifyQuestion } from "@/api/convex/lib/questionPolicy";

const FAKE = path.resolve(import.meta.dirname, "fakeAcpAgent.mjs");

type Row = { seq: number; type: string; payload: Record<string, unknown>; eventKey?: string };

/**
 * In-memory stand-in for directThreads.ts + directQuestions.ask: the card is
 * an approval.requested {kind: "question"} event, routed with the same
 * policy the backend runs (CTO-first when `cto` is on and the question is
 * inside the CTO's ceiling).
 */
class MemoryStore implements DirectStore {
  events: Row[] = [];
  state: DirectStatePatch = {};
  cto = false;
  asked: QuestionAskCall[] = [];
  approvals = 0;
  failAsk = false;
  userMessage(text: string) {
    const seq = this.events.length + 1;
    this.events.push({ seq, type: "user.message", payload: { text } });
    return { seq, text };
  }
  async appendEvents(events: StoredEvent[], state?: DirectStatePatch) {
    const seqs: number[] = [];
    for (const e of events) {
      const seq = this.events.length + 1;
      this.events.push({ seq, type: e.type, payload: e.payload, eventKey: e.eventKey });
      seqs.push(seq);
    }
    if (state) this.state = { ...this.state, ...state };
    return seqs;
  }
  async flushStream() {}
  async clearStreams() {}
  async requestApproval() {
    this.approvals += 1;
    return { status: "pending" as const, approvalId: `ap${this.approvals}`, reason: "Supervised" };
  }
  async approvalState() {
    return { status: "pending", decision: null, note: null, taskStatus: "running", reason: null };
  }
  async cancelApproval() {}
  async askQuestion(call: QuestionAskCall): Promise<QuestionRouted> {
    if (this.failAsk) throw new Error("store unavailable");
    this.asked.push(call);
    const policy = classifyQuestion({ question: call.question, options: call.options, permissionMode: "auto_edits" });
    const route = this.cto && policy.route === "cto" ? "cto" : "user";
    await this.appendEvents([
      {
        type: "approval.requested",
        eventKey: `question.${route}:${call.itemId}`,
        payload: { kind: "question", questionId: call.itemId, itemId: call.itemId, question: call.question, options: call.options, answerer: route, reason: policy.reason },
      },
    ]);
    return { route, questionId: call.itemId, reason: policy.reason };
  }
  async loadEvents() {
    return this.events.map((e) => ({ type: e.type, sequence: e.seq, payload: e.payload }));
  }
  async recordUsage() {}
  of(type: string) {
    return this.events.filter((e) => e.type === type).map((e) => e.payload);
  }
  agentText() {
    return this.of("assistant.text").map((p) => String(p.text)).join(" ");
  }
}

const dirs: string[] = [];
const runners: ThreadRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.close("test end");
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function make(store: MemoryStore) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-n7-"));
  dirs.push(cwd);
  const engine = new AcpEngine({ binary: process.execPath, args: [FAKE], env: { ...process.env }, log: silentLogger, workspaceRoot: cwd });
  const r = new ThreadRunner({ taskId: "t1", cwd, engine, store, approvalPollMs: 20, streamFlushMs: 20, interruptGraceMs: 2000 });
  runners.push(r);
  return r;
}

const settle = async (r: ThreadRunner) => {
  await r.idle();
  await r.drain();
};

describe("question → card → answer as the next message", () => {
  it("shows a question card with its options, answers the call cancelled, and ends the turn cleanly", async () => {
    const store = new MemoryStore();
    const r = make(store);
    await r.deliver(store.userMessage("ask Which layout should the settings page use?|Tabs|One long page"));
    await settle(r);

    expect(store.asked).toEqual([
      { itemId: expect.any(String), question: "Which layout should the settings page use?", options: ["Tabs", "One long page"] },
    ]);
    const [card] = store.of("approval.requested");
    expect(card).toMatchObject({ kind: "question", options: ["Tabs", "One long page"], answerer: "user" });
    // The tool never ran as a gated call: no permission card, no approval row.
    expect(store.approvals).toBe(0);
    expect(store.of("approval.resolved")).toEqual([]);
    // The agent saw "cancelled" and ended its turn; the note says why.
    expect(store.agentText()).toContain("Asked; waiting for the answer.");
    expect(store.of("system.note").map((n) => n.text)).toEqual([expect.stringMatching(/shown to the user.*answered in chat \(cancelled\).*next message/)]);
    const completed = store.of("turn.completed");
    expect(completed).toEqual([expect.objectContaining({ outcome: "completed" })]);
    expect(completed[0].error).toBeUndefined();
    const cardSeq = store.events.find((e) => e.type === "approval.requested")!.seq;
    const callSeq = store.events.find((e) => e.type === "tool.call")!.seq;
    expect(callSeq).toBeLessThan(cardSeq); // the tool row lands before its card

    // The user's answer is the next user.message: a new turn that carries it.
    await r.deliver(store.userMessage("One long page"));
    await settle(r);
    expect(store.agentText()).toContain("Echo:");
    expect(store.agentText()).toContain("One long page");
    expect(store.of("turn.completed")).toHaveLength(2);
    expect(store.of("turn.completed").every((c) => c.outcome === "completed")).toBe(true);
  }, 20_000);

  it("within policy the CTO answers: the card says so, and the CTO's answer arrives as the next message", async () => {
    const store = new MemoryStore();
    store.cto = true;
    const r = make(store);
    await r.deliver(store.userMessage("ask Should the CSV export live in its own module or in the orders query file?|Own module|Orders query file"));
    await settle(r);
    expect(store.of("approval.requested")).toEqual([expect.objectContaining({ kind: "question", answerer: "cto" })]);
    expect(store.of("system.note").map((n) => n.text)).toEqual([expect.stringMatching(/went to the CTO/)]);
    expect(store.of("turn.completed")).toEqual([expect.objectContaining({ outcome: "completed" })]);
    // decisionTurns.deliver → directQuestions.deliverCtoAnswer posts it as a user.message.
    await r.deliver(store.userMessage("CTO: Own module, next to the orders queries."));
    await settle(r);
    expect(store.agentText()).toContain("CTO: Own module");
  }, 20_000);

  it("secret and push questions go to the user even with CTO-first on", async () => {
    const store = new MemoryStore();
    store.cto = true;
    const r = make(store);
    await r.deliver(store.userMessage("ask Which API key should the payment module use?|Live key|Test key"));
    await settle(r);
    await r.deliver(store.userMessage("ask Should I push the module branch and open a pull request?|Yes|No"));
    await settle(r);
    expect(store.of("approval.requested").map((c) => c.answerer)).toEqual(["user", "user"]);
  }, 20_000);

  it("a card that can't be written refuses the call with gate_error and the turn still ends", async () => {
    const store = new MemoryStore();
    store.failAsk = true;
    const r = make(store);
    await r.deliver(store.userMessage("ask Which layout?|A|B"));
    await settle(r);
    expect(store.of("approval.resolved")).toEqual([
      expect.objectContaining({ decision: "cancelled", reason: "gate_error", message: expect.stringMatching(/could not be shown \(store unavailable\)/) }),
    ]);
    expect(store.of("turn.completed")).toEqual([expect.objectContaining({ outcome: "completed" })]);
  }, 20_000);
});

describe("question parsing, config and preamble", () => {
  it("reads OpenCode's question input; several questions become one card without options", () => {
    expect(questionFromToolCall({ title: "question", rawInput: { questions: [{ question: "Pick", header: "H", options: [{ label: "A" }, { label: "B" }, { label: "A" }] }] } })).toEqual({
      question: "Pick",
      options: ["A", "B"],
    });
    const many = questionFromToolCall({ rawInput: { questions: [{ question: "One?", header: "First" }, { question: "Two?", options: [{ label: "x" }] }] } });
    expect(many).toEqual({ question: "1. First: One?\n2. Two? (x)", options: [] });
    expect(questionFromToolCall({ title: "bash", rawInput: { command: "ls" } })).toBeNull();
    expect(questionFromToolCall({ title: "question", rawInput: {} })).toBeNull();
  });

  it("OpenCode's question tool asks (no longer denied) and the preamble says to end the turn after asking", () => {
    const cfg = opencodeConfig() as { permission: Record<string, unknown>; agent: Record<string, { permission: Record<string, unknown> }> };
    expect(cfg.permission.question).toBe("ask");
    expect(cfg.agent.build.permission.question).toBe("ask");
    expect((opencodeConfig({ noTools: true }) as { permission: Record<string, unknown> }).permission).toEqual({ "*": "deny" });
    expect(QUESTION_PREAMBLE).toMatch(/end your turn/);
    expect(directPreamble({ role: "backend", cwd: "/w", isolated: true })).toContain(QUESTION_PREAMBLE);
  });
});
