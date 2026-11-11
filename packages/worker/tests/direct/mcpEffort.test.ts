// Nuphos N10: MCP servers and effort in direct (ACP) threads.
// - the MCP set hash ignores header and secret values;
// - a set change mid-turn waits for the turn to end, then releases;
// - a header-only change does not restart;
// - the effort is re-applied on resume, and a change between turns is
//   applied before the next prompt, never mid-turn.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptApiKey } from "@/api/convex/lib/llmCrypto";
import { mcpSetHashFor, normalizeDirectEffort, type McpDeclarationRow } from "@/api/convex/lib/mcpDeclaration";
import { resetEncryptionKeyCache } from "@/llm/crypto";
import { AcpEngine, effortOption, effortValueFor } from "@/direct/acpSession";
import { DirectThreads, MCP_CHANGED_NOTE, type DirectThreadsDeps } from "@/direct/index";
import { buildDirectMcpSet, declarableServers, mcpRestartDue } from "@/direct/mcpDeclare";
import { ThreadRunner, type DirectStatePatch, type DirectStore, type StoredEvent } from "@/direct/threadRunner";
import type { McpServerConfig } from "@/mcp/types";
import { redactText } from "@/utils/redact";
import { silentLogger } from "@/vendor/threadbear/acp/connection";

const FAKE = path.resolve(import.meta.dirname, "fakeAcpAgent.mjs");
const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.PROVIDER_ENCRYPTION_KEY;
  process.env.PROVIDER_ENCRYPTION_KEY = TEST_KEY;
  resetEncryptionKeyCache();
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.PROVIDER_ENCRYPTION_KEY;
  else process.env.PROVIDER_ENCRYPTION_KEY = previousKey;
  resetEncryptionKeyCache();
});

type Row = { seq: number; type: string; payload: Record<string, unknown>; eventKey?: string };

class Store implements DirectStore {
  events: Row[] = [];
  patches: DirectStatePatch[] = [];
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
    if (state) this.patches.push(state);
    return seqs;
  }
  async flushStream() {}
  async clearStreams() {}
  async requestApproval() {
    return { status: "auto" as const, approvalId: "a1", reason: "Full access" };
  }
  async approvalState() {
    return null;
  }
  async cancelApproval() {}
  async loadEvents() {
    return this.events.map((e) => ({ type: e.type, sequence: e.seq, payload: e.payload }));
  }
  async recordUsage() {}
  of(type: string) {
    return this.events.filter((e) => e.type === type);
  }
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-n10-"));
  tmpDirs.push(dir);
  return dir;
}
const runners: ThreadRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.close("test end");
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeEngine(cwd: string, env: Record<string, string> = {}) {
  return new AcpEngine({ binary: process.execPath, args: [FAKE], env: { ...process.env, ...env }, log: silentLogger, workspaceRoot: cwd });
}

function readLog(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const local = (over: Partial<McpDeclarationRow> = {}): McpDeclarationRow => ({
  _id: "m1",
  name: "files",
  type: "local",
  command: "npx",
  args: JSON.stringify(["-y", "server", "{workspace}", "{env:TOKEN}"]),
  envKeys: ["TOKEN"],
  ...over,
});
const remote = (over: Partial<McpDeclarationRow> = {}): McpDeclarationRow => ({ _id: "m2", name: "docs", type: "remote", url: "https://mcp.example.com/mcp", envKeys: ["Authorization"], ...over });

describe("MCP set hash (Nuphos N10)", () => {
  it("ignores header and secret values; counts what the agent is started with", () => {
    const base = mcpSetHashFor([local(), remote()], "developer");
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    // Header-only / secret-only: the ciphertext changes, the identity does not.
    const rotated = [local({ envCiphertext: "v2" } as never), remote({ envCiphertext: "other-header" } as never)];
    expect(mcpSetHashFor(rotated, "developer")).toBe(base);
    // Order of rows doesn't matter.
    expect(mcpSetHashFor([remote(), local()], "developer")).toBe(base);
    // Real changes.
    expect(mcpSetHashFor([local({ args: '["other"]' }), remote()], "developer")).not.toBe(base);
    expect(mcpSetHashFor([local({ envKeys: ["TOKEN", "EXTRA"] }), remote()], "developer")).not.toBe(base);
    expect(mcpSetHashFor([local(), remote({ url: "https://mcp.example.com/v2" })], "developer")).not.toBe(base);
    expect(mcpSetHashFor([local(), remote({ enabled: false })], "developer")).not.toBe(base);
    expect(mcpSetHashFor([local()], "developer")).not.toBe(base);
    // Role allowlist: a server for another role is not in this thread's set.
    expect(mcpSetHashFor([local(), remote({ agentRoles: ["designer"] })], "developer")).toBe(mcpSetHashFor([local()], "developer"));
    expect(mcpSetHashFor([], "developer")).toBe("");
  });

  it("mcpRestartDue: waits mid-turn, releases between turns, never for an unchanged set or the API loop", () => {
    expect(mcpRestartDue({ liveHash: "a", wantHash: "b", busy: true, closing: false })).toBe("wait");
    expect(mcpRestartDue({ liveHash: "a", wantHash: "b", busy: false, closing: false })).toBe("release");
    expect(mcpRestartDue({ liveHash: "a", wantHash: "a", busy: false, closing: false })).toBe("none");
    expect(mcpRestartDue({ liveHash: undefined, wantHash: "b", busy: false, closing: false })).toBe("none");
    expect(mcpRestartDue({ liveHash: "a", wantHash: undefined, busy: false, closing: false })).toBe("none");
    expect(mcpRestartDue({ liveHash: "a", wantHash: "b", busy: false, closing: true })).toBe("none");
  });

  it("builds stdio and http declarations, registers the secret values with the redactor, and skips a row it can't build", async () => {
    const cwd = tmp();
    const secret = "ghp_N10secretTokenValue0123456789abcdefXYZ";
    const header = "Bearer n10-header-value-abcdefghijklmnop";
    const rows: McpServerConfig[] = [
      { _id: "m1", name: "files", type: "local", command: "node", args: JSON.stringify(["srv.js", "{workspace}", "{env:TOKEN}"]), envKeys: ["TOKEN"], envCiphertext: await encryptApiKey(JSON.stringify({ TOKEN: secret })) },
      { _id: "m2", name: "docs", type: "remote", url: "https://mcp.example.com/mcp", envKeys: ["Authorization"], envCiphertext: await encryptApiKey(JSON.stringify({ Authorization: header })) },
      { _id: "m3", name: "broken", type: "local", command: "node", args: JSON.stringify(["{env:MISSING}"]) },
      { _id: "m4", name: "designer-only", type: "local", command: "node", agentRoles: ["designer"] },
    ];
    const set = await buildDirectMcpSet(rows, "developer", cwd);
    expect(set.servers).toEqual([
      { name: "files", command: "node", args: ["srv.js", cwd, secret], env: [{ name: "TOKEN", value: secret }] },
      { type: "http", name: "docs", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: header }] },
    ]);
    expect(set.skipped.map((s) => s.name)).toEqual(["broken"]);
    expect(set.hash).toBe(mcpSetHashFor(rows.map((r) => ({ ...r })), "developer"));
    // L2: an agent echoing either value is masked wherever text is redacted.
    expect(redactText(`token ${secret} and ${header}`)).not.toContain(secret);
    expect(redactText(`h: ${header}`)).not.toContain("n10-header-value-abcdefghijklmnop");
    // Without the http capability the remote one isn't declared.
    expect(declarableServers(set.servers, undefined)).toEqual({ declared: [set.servers[0]], dropped: ["docs"] });
    expect(declarableServers(set.servers, { http: true }).declared).toHaveLength(2);
  });

  it("the agent is started with the declared servers on new and on resume", async () => {
    const cwd = tmp();
    const log = path.join(cwd, "acp.log");
    const store = new Store();
    const mcpServers = [
      { name: "files", command: "node", args: ["srv.js"], env: [{ name: "TOKEN", value: "x" }] },
      { type: "http" as const, name: "docs", url: "https://mcp.example.com/mcp", headers: [] },
    ];
    const runner = new ThreadRunner({ taskId: "t-new", cwd, engine: fakeEngine(cwd, { FAKE_ACP_LOG: log }), store, mcpServers, streamFlushMs: 20 });
    runners.push(runner);
    await runner.deliver(store.userMessage("hello"));
    await runner.idle();
    await runner.drain();
    const opened = readLog(log).find((e) => e.method === "session/new")!;
    expect((opened.mcpServers as Array<{ name: string }>).map((s) => s.name)).toEqual(["files"]);
    expect(store.of("system.note").map((e) => String(e.payload.text)).join("\n")).toMatch(/doesn't take HTTP MCP servers, so docs isn't available/);

    const log2 = path.join(cwd, "acp2.log");
    const resumed = new ThreadRunner({ taskId: "t-res", cwd, engine: fakeEngine(cwd, { FAKE_ACP_LOG: log2, FAKE_ACP_HTTP: "1" }), store: new Store(), sessionId: "ses_known", mcpServers, streamFlushMs: 20 });
    runners.push(resumed);
    await resumed.deliver({ seq: 1, text: "again" });
    await resumed.idle();
    const r = readLog(log2).find((e) => e.method === "session/resume")!;
    expect((r.mcpServers as Array<{ name: string }>).map((s) => s.name)).toEqual(["files", "docs"]);
  }, 20_000);
});

describe("MCP set change in DirectThreads.pollOnce (Nuphos N10)", () => {
  type FakeRunner = { readonly busy: boolean; close: (reason?: string) => Promise<void>; setEffort?: (e: string | null) => void; deliver?: (m: { seq: number; text: string }) => Promise<void> };
  function harness(liveHash: string, runner: FakeRunner) {
    const released: string[] = [];
    const notes: string[] = [];
    let wantHash = liveHash;
    let messages: Array<{ seq: number; text: string }> = [];
    const api = {
      pollDirectThread: vi.fn(async () => ({ owned: true, status: "running", interruptRequestedAt: null, messages, mcpSetHash: wantHash, effort: null })),
      appendDirectEvents: vi.fn(async ({ events }: { events: Array<{ payload: { text: string } }> }) => {
        for (const e of events) notes.push(e.payload.text);
        return { seqs: [] };
      }),
      releaseDirectThread: vi.fn(async ({ taskId }: { taskId: string }) => {
        released.push(String(taskId));
        return { status: "queued" };
      }),
    };
    const deps = {
      api,
      workerId: "w1",
      workspaceRoot: tmp(),
      policy: {},
      leaseMs: 60_000,
      log: () => undefined,
      shutdownSignal: new AbortController().signal,
      agentPids: { installExitHook() {}, sweep: async () => [], reapOwn: async () => undefined },
    } as unknown as DirectThreadsDeps;
    const dt = new DirectThreads(deps);
    const inner = dt as unknown as { live: Map<string, { closing: boolean; timer?: NodeJS.Timeout }>; pollOnce: (l: unknown) => Promise<void> };
    const live: { taskId: string; runner: FakeRunner; lastActivity: number; handledInterrupt: number; deliveredSeq: number; closing: boolean; mcpHash: string; timer?: NodeJS.Timeout } = {
      taskId: "t1",
      runner,
      lastActivity: Date.now(),
      handledInterrupt: 0,
      deliveredSeq: 0,
      closing: false,
      mcpHash: liveHash,
    };
    inner.live.set("t1", live);
    const poll = async () => {
      await inner.pollOnce(live);
      if (live.timer) clearTimeout(live.timer);
    };
    return {
      dt,
      live,
      poll,
      released,
      notes,
      setWant: (h: string) => void (wantHash = h),
      setMessages: (m: Array<{ seq: number; text: string }>) => void (messages = m),
    };
  }

  it("a set change mid-turn waits for the turn to end, then releases between turns", async () => {
    const cwd = tmp();
    const log = path.join(cwd, "acp.log");
    const store = new Store();
    const runner = new ThreadRunner({ taskId: "t1", cwd, engine: fakeEngine(cwd, { FAKE_ACP_LOG: log }), store, streamFlushMs: 20 });
    runners.push(runner);
    const before = mcpSetHashFor([local()], "developer");
    const h = harness(before, runner);

    await runner.deliver(store.userMessage("slow"));
    expect(runner.busy).toBe(true);
    h.setWant(mcpSetHashFor([local(), remote()], "developer"));
    await h.poll();
    // Mid-turn: nothing released, the turn goes on.
    expect(h.released).toEqual([]);
    expect(h.live.closing).toBe(false);
    expect(runner.busy).toBe(true);

    await runner.idle();
    await runner.drain();
    expect(store.of("turn.completed").pop()?.payload.outcome).toBe("completed");
    await h.poll();
    expect(h.notes).toEqual([MCP_CHANGED_NOTE]);
    expect(h.released).toEqual(["t1"]);
    expect(h.dt.activeTaskIds()).toEqual([]);
  }, 20_000);

  it("a set change does not deliver a waiting message to the old session: the release re-queues it", async () => {
    const delivered: unknown[] = [];
    const runner = { busy: false, close: async () => undefined, setEffort: () => undefined, deliver: async (m: { seq: number; text: string }) => void delivered.push(m) };
    const h = harness("aaaa", runner);
    h.setWant("bbbb");
    h.setMessages([{ seq: 5, text: "next" }]);
    await h.poll();
    expect(delivered).toEqual([]);
    expect(h.released).toEqual(["t1"]);
  });

  it("a header-only change does not restart the session", async () => {
    const delivered: unknown[] = [];
    const close = vi.fn(async () => undefined);
    const runner = { busy: false, close, setEffort: () => undefined, deliver: async (m: { seq: number; text: string }) => void delivered.push(m) };
    const rows = [local(), remote()];
    const h = harness(mcpSetHashFor(rows, "developer"), runner);
    // The remote server's Authorization header was rotated (new ciphertext, same key).
    h.setWant(mcpSetHashFor([local(), remote({ envCiphertext: "rotated" } as never)], "developer"));
    h.setMessages([{ seq: 2, text: "hi" }]);
    await h.poll();
    expect(close).not.toHaveBeenCalled();
    expect(h.released).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(delivered).toEqual([{ seq: 2, text: "hi" }]);
  });
});

describe("effort (Nuphos N10)", () => {
  it("normalizes and matches the advertised values", () => {
    expect(normalizeDirectEffort(" High ")).toBe("high");
    expect(normalizeDirectEffort("default")).toBeNull();
    expect(normalizeDirectEffort(null)).toBeNull();
    expect(() => normalizeDirectEffort("high; rm -rf")).toThrow();
    const opt = effortOption([{ id: "model", category: "model" }, { id: "x", category: "thought_level", options: [{ value: "hi", name: "High" }] }])!;
    expect(opt.id).toBe("x");
    expect(effortValueFor(opt, "high")).toBe("hi");
    expect(effortValueFor(opt, "low")).toBeUndefined();
    expect(effortOption([{ id: "reasoning_effort" }])?.id).toBe("reasoning_effort");
  });

  it("is re-applied on resume, and a change between turns is applied before the next prompt, never mid-turn", async () => {
    const cwd = tmp();
    const log = path.join(cwd, "acp.log");
    const env = { FAKE_ACP_LOG: log, FAKE_ACP_EFFORT: "1" };
    const store = new Store();
    const first = new ThreadRunner({ taskId: "t-eff", cwd, engine: fakeEngine(cwd, env), store, sessionId: "ses_known", effort: "high", streamFlushMs: 20 });
    runners.push(first);
    await first.deliver(store.userMessage("one"));
    await first.idle();
    await first.drain();
    let entries = readLog(log);
    const sets = () => entries.filter((e) => e.method === "session/set_config_option").map((e) => [e.configId, e.value]);
    expect(entries[0].method).toBe("session/resume");
    expect(sets()).toEqual([["effort", "high"]]);
    // Set before the prompt.
    expect(entries.findIndex((e) => e.method === "session/set_config_option")).toBeLessThan(entries.findIndex((e) => e.method === "session/prompt"));

    // Mid-turn change: not sent until the next prompt.
    await first.deliver(store.userMessage("slow"));
    first.setEffort("low");
    await new Promise((r) => setTimeout(r, 100));
    entries = readLog(log);
    expect(sets()).toEqual([["effort", "high"]]);
    await first.idle();
    await first.drain();
    await first.deliver(store.userMessage("two"));
    await first.idle();
    await first.drain();
    entries = readLog(log);
    expect(sets()).toEqual([
      ["effort", "high"],
      ["effort", "low"],
    ]);
    const lowAt = entries.findIndex((e) => e.method === "session/set_config_option" && e.value === "low");
    const prompts = entries.map((e, i) => [e, i] as const).filter(([e]) => e.method === "session/prompt");
    expect(prompts.map(([e]) => e.text)).toEqual(["one", "slow", "two"]);
    expect(lowAt).toBeGreaterThan(prompts[1][1]);
    expect(lowAt).toBeLessThan(prompts[2][1]);

    // Released (a new process), then resumed: the effort comes back with it.
    await first.close("idle");
    const log2 = path.join(cwd, "acp2.log");
    const second = new ThreadRunner({ taskId: "t-eff", cwd, engine: fakeEngine(cwd, { ...env, FAKE_ACP_LOG: log2 }), store, sessionId: "ses_known", effort: "low", streamFlushMs: 20 });
    runners.push(second);
    await second.deliver(store.userMessage("three"));
    await second.idle();
    await second.drain();
    const again = readLog(log2);
    expect(again[0].method).toBe("session/resume");
    expect(again.filter((e) => e.method === "session/set_config_option").map((e) => e.value)).toEqual(["low"]);
    expect(store.of("turn.completed").every((e) => e.payload.outcome === "completed")).toBe(true);
  }, 30_000);

  it("an agent without an effort option says so once and the turn still runs", async () => {
    const cwd = tmp();
    const store = new Store();
    const runner = new ThreadRunner({ taskId: "t-noeff", cwd, engine: fakeEngine(cwd), store, effort: "high", streamFlushMs: 20 });
    runners.push(runner);
    await runner.deliver(store.userMessage("a"));
    await runner.idle();
    await runner.deliver(store.userMessage("b"));
    await runner.idle();
    await runner.drain();
    expect(store.of("system.note").filter((e) => /no effort setting/.test(String(e.payload.text)))).toHaveLength(1);
    expect(store.of("turn.completed").map((e) => e.payload.outcome)).toEqual(["completed", "completed"]);
  }, 20_000);
});
