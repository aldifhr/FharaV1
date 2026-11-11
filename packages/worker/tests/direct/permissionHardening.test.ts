// Nuphos N5: permission hardening for direct (ACP) threads. Every
// "cancelled" answer to a permission request carries a named reason, written
// as approval.resolved {decision: "cancelled", reason}; a card nobody answers
// within the bound expires and the turn goes on with the agent told no.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpEngine } from "@/direct/acpSession";
import { directApprovalMaxMs } from "@/direct";
import {
  APPROVAL_MAX_MS,
  expiredMessage,
  ThreadRunner,
  type DirectStatePatch,
  type DirectStore,
  type StoredEvent,
  type TurnWatchdogConfig,
} from "@/direct/threadRunner";
import type { ApprovalCancelReason } from "@/direct/types";
import { silentLogger } from "@/vendor/threadbear/acp/connection";

const FAKE = path.resolve(import.meta.dirname, "fakeAcpAgent.mjs");

type Row = { seq: number; type: string; payload: Record<string, unknown>; eventKey?: string };
type Card = { status: string; itemId: string; reason?: ApprovalCancelReason };

/** In-memory stand-in for directThreads.ts, closing cards the way the backend does. */
class MemoryStore implements DirectStore {
  events: Row[] = [];
  state: DirectStatePatch = {};
  cards = new Map<string, Card>();
  mode: "ask" | "full" = "ask";
  failRequest = false;
  cancels: { approvalId: string; reason: ApprovalCancelReason; message: string }[] = [];
  private n = 0;
  userMessage(text: string) {
    const seq = this.events.length + 1;
    this.events.push({ seq, type: "user.message", payload: { text } });
    return { seq, text };
  }
  async appendEvents(events: StoredEvent[], state?: DirectStatePatch) {
    const seqs: number[] = [];
    for (const e of events) {
      const dup = e.eventKey ? this.events.find((r) => r.eventKey === e.eventKey) : undefined;
      if (dup) {
        seqs.push(dup.seq);
        continue;
      }
      const seq = this.events.length + 1;
      this.events.push({ seq, type: e.type, payload: e.payload, eventKey: e.eventKey });
      seqs.push(seq);
    }
    if (state) this.state = { ...this.state, ...state };
    return seqs;
  }
  async flushStream() {}
  async clearStreams() {}
  async requestApproval(input: { itemId: string }) {
    if (this.failRequest) throw new Error("store unavailable");
    const approvalId = `ap${++this.n}`;
    if (this.mode === "full") {
      this.cards.set(approvalId, { status: "approved", itemId: input.itemId });
      return { status: "auto" as const, approvalId, reason: "Full access" };
    }
    this.cards.set(approvalId, { status: "pending", itemId: input.itemId });
    return { status: "pending" as const, approvalId, reason: "Supervised" };
  }
  async approvalState(approvalId: string) {
    const c = this.cards.get(approvalId);
    return c ? { status: c.status, decision: null, note: null, taskStatus: "running", reason: c.reason ?? null } : null;
  }
  /** Like directThreads.cancelApproval: closes a pending card and writes the event once. */
  async cancelApproval(approvalId: string, reason: ApprovalCancelReason, message: string) {
    this.cancels.push({ approvalId, reason, message });
    const c = this.cards.get(approvalId);
    if (!c || c.status !== "pending") return;
    c.status = "cancelled";
    c.reason = reason;
    await this.appendEvents([{ type: "approval.resolved", payload: { approvalId, itemId: c.itemId, decision: "cancelled", reason, message } }]);
  }
  async loadEvents() {
    return this.events.map((e) => ({ type: e.type, sequence: e.seq, payload: e.payload }));
  }
  async recordUsage() {}
  resolved() {
    return this.events.filter((e) => e.type === "approval.resolved").map((e) => e.payload);
  }
  completed() {
    return this.events.filter((e) => e.type === "turn.completed").map((e) => e.payload);
  }
  agentText() {
    return this.events.filter((e) => e.type === "assistant.text").map((e) => String(e.payload.text)).join(" ");
  }
}

const dirs: string[] = [];
const runners: ThreadRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.close("test end");
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function make(store: MemoryStore, extra: { approvalMaxMs?: number; watchdog?: TurnWatchdogConfig } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-n5-"));
  dirs.push(cwd);
  const engine = new AcpEngine({ binary: process.execPath, args: [FAKE], env: { ...process.env }, log: silentLogger, workspaceRoot: cwd });
  const r = new ThreadRunner({ taskId: "t1", cwd, engine, store, approvalPollMs: 20, streamFlushMs: 20, interruptGraceMs: 2000, ...extra });
  runners.push(r);
  return r;
}

const waitFor = async (pred: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const settle = async (r: ThreadRunner) => {
  await r.idle();
  await r.drain();
};

describe("each cancel branch writes approval.resolved {decision: cancelled, reason}", () => {
  it("interrupt: Stop while a card waits closes it with reason interrupt, written once", async () => {
    const store = new MemoryStore();
    const r = make(store);
    await r.deliver(store.userMessage("run npm test"));
    await waitFor(() => store.cards.size === 1);
    await r.interrupt();
    await settle(r);
    expect(store.resolved()).toEqual([{ approvalId: "ap1", itemId: expect.any(String), decision: "cancelled", reason: "interrupt", message: "Stopped." }]);
    expect(store.cards.get("ap1")).toMatchObject({ status: "cancelled", reason: "interrupt" });
    expect(store.completed()).toEqual([expect.objectContaining({ outcome: "interrupted" })]);
  }, 20_000);

  it("interrupt: a card the backend closed (Stop from the UI) is not written twice", async () => {
    const store = new MemoryStore();
    const r = make(store);
    await r.deliver(store.userMessage("run npm test"));
    await waitFor(() => store.cards.size === 1);
    // directThreads.interrupt: expireDirectCards(…, "interrupt", "Stopped by the user.")
    await store.cancelApproval("ap1", "interrupt", "Stopped by the user.");
    await settle(r);
    expect(store.resolved()).toEqual([expect.objectContaining({ decision: "cancelled", reason: "interrupt", message: "Stopped by the user." })]);
  }, 20_000);

  it("gate_error: the card can't be recorded → the agent gets cancelled, and the runner writes the reason", async () => {
    const store = new MemoryStore();
    store.failRequest = true;
    const r = make(store);
    await r.deliver(store.userMessage("run npm test"));
    await settle(r);
    const [ev] = store.resolved();
    expect(store.resolved()).toHaveLength(1);
    expect(ev).toMatchObject({ decision: "cancelled", reason: "gate_error" });
    expect(String(ev.message)).toMatch(/could not be recorded \(store unavailable\)/);
    expect(ev.approvalId).toBeUndefined();
  }, 20_000);

  it("no_option: allowed, but the agent offered no allow_once → cancelled with reason no_option", async () => {
    const store = new MemoryStore();
    store.mode = "full";
    const r = make(store);
    await r.deliver(store.userMessage("run-noopt npm test"));
    await settle(r);
    expect(store.resolved()).toEqual([expect.objectContaining({ approvalId: "ap1", decision: "cancelled", reason: "no_option" })]);
    // Never "always": nothing the agent would remember goes ahead.
    expect(store.agentText()).not.toContain("ran it");
  }, 20_000);

  it("no_option: denied, but no reject_once on offer → cancelled with reason no_option", async () => {
    const store = new MemoryStore();
    const r = make(store);
    await r.deliver(store.userMessage("run-noopt npm test"));
    await waitFor(() => store.cards.size === 1);
    store.cards.get("ap1")!.status = "rejected";
    await settle(r);
    expect(store.resolved()).toEqual([expect.objectContaining({ decision: "cancelled", reason: "no_option" })]);
  }, 20_000);

  it("a plain answer writes no cancel", async () => {
    const store = new MemoryStore();
    const r = make(store);
    await r.deliver(store.userMessage("run npm test"));
    await waitFor(() => store.cards.size === 1);
    store.cards.get("ap1")!.status = "approved";
    await settle(r);
    expect(store.resolved()).toEqual([]);
    expect(store.agentText()).toContain("ran it");
  }, 20_000);
});

describe("bounded approval wait (DIRECT_APPROVAL_MAX_MIN)", () => {
  it("expired: unanswered past the bound, the card expires, the agent is told no and the turn goes on", async () => {
    const store = new MemoryStore();
    const r = make(store, { approvalMaxMs: 300 });
    const started = Date.now();
    await r.deliver(store.userMessage("run npm test"));
    await settle(r);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(store.cards.get("ap1")).toMatchObject({ status: "cancelled", reason: "expired" });
    expect(store.resolved()).toEqual([{ approvalId: "ap1", itemId: expect.any(String), decision: "cancelled", reason: "expired", message: expiredMessage(300) }]);
    // Told no with reject_once, not cancelled: the agent carries on.
    expect(store.agentText()).toContain("did not run (selected:reject)");
    expect(store.completed()).toEqual([expect.objectContaining({ outcome: "completed" })]);
    expect(store.events.some((e) => e.type === "system.note" && e.payload.text === expiredMessage(300))).toBe(true);
    expect(store.state.status).not.toBe("waiting");
  }, 20_000);

  it("the card's bound fires before the watchdog's approval exemption", async () => {
    const store = new MemoryStore();
    const r = make(store, { approvalMaxMs: 300, watchdog: { inactivityMs: 5000, progressMs: 5000, approvalCapMs: 1500 } });
    await r.deliver(store.userMessage("run npm test"));
    await settle(r);
    expect(store.resolved()).toEqual([expect.objectContaining({ reason: "expired" })]);
    expect(store.completed()).toEqual([expect.objectContaining({ outcome: "completed" })]);
  }, 20_000);

  it("an answer inside the bound is used, and the next card gets its own full bound", async () => {
    const store = new MemoryStore();
    const r = make(store, { approvalMaxMs: 1500 });
    await r.deliver(store.userMessage("run npm test"));
    await waitFor(() => store.cards.size === 1);
    await new Promise((res) => setTimeout(res, 400));
    store.cards.get("ap1")!.status = "approved";
    await settle(r);
    expect(store.resolved()).toEqual([]);
    expect(store.agentText()).toContain("ran it");
  }, 20_000);

  it("the default bound is 30 minutes", () => {
    expect(APPROVAL_MAX_MS).toBe(30 * 60_000);
    expect(directApprovalMaxMs({})).toBe(30 * 60_000);
    expect(directApprovalMaxMs({ DIRECT_APPROVAL_MAX_MIN: "5" })).toBe(5 * 60_000);
    expect(directApprovalMaxMs({ DIRECT_APPROVAL_MAX_MIN: "" })).toBe(30 * 60_000);
  });
});
