// N1 (secret-safe agent errors): the redacted stderr tail, the cause of
// death, and chunk-safe redaction of a direct thread's stream and events.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpEngine } from "@/direct/acpSession";
import { DirectStreamRedactor } from "@/direct/streamRedactor";
import { ThreadRunner, type DirectStatePatch, type DirectStore, type StoredEvent } from "@/direct/threadRunner";
import type { DirectEngine, SessionSink } from "@/direct/types";
import { registerSecretValues, resetKnownSecretsForTests } from "@/utils/redact";
import { AcpRpcError, silentLogger } from "@/vendor/threadbear/acp/connection";
import { describeProcessDeath, memoryLimit, oomKills, ownCgroup } from "@/vendor/nuphos/processDeath";
import { PROCESS_DEATH_PREFIX, STDERR_TAIL_LINES, StderrTail, WITHHELD_LINE, redactStderrLine } from "@/vendor/nuphos/stderrTail";

const FAKE = path.resolve(import.meta.dirname, "fakeAcpAgent.mjs");
const KEY = "sk-proj-FAKEsecretKEY0123456789abcdef";
const BODY = "FAKEsecretKEY0123456789"; // any of it in a row is a leak

afterEach(() => resetKnownSecretsForTests());

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-n1-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("redacted stderr tail", () => {
  it("withholds a credential-like line whole (sk-, ghp_, Bearer, key=value)", () => {
    for (const line of [
      `Error: bad key ${KEY}`,
      "fatal: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rejected",
      "Error: Authorization: Bearer abc123",
      "failed: OPENAI_API_KEY=whatever",
      "Error: could not reach https://user:hunter2@example.com/x",
    ]) {
      expect(redactStderrLine(line)).toBe(WITHHELD_LINE);
    }
  });

  it("withholds a line carrying a registered secret value of any shape", () => {
    registerSecretValues(["zq81-opaque-provider-value"]);
    expect(redactStderrLine("Error: upstream said zq81-opaque-provider-value")).toBe(WITHHELD_LINE);
  });

  it("drops a non-error line and keeps an error-like one", () => {
    expect(redactStderrLine("loading plugins")).toBeNull();
    expect(redactStderrLine("Error: provider returned 500")).toBe("Error: provider returned 500");
    expect(redactStderrLine("connect ECONNREFUSED 127.0.0.1:4096")).toContain("ECONNREFUSED");
    expect(redactStderrLine("    at run (/srv/agent.js:12:3)")).toContain("agent.js:12");
  });

  it("masks a 64-char mixed run, keeps a pure hex-free word run, hashes session ids, defuses fences", () => {
    const run = "a1".repeat(32);
    const out = redactStderrLine(`Error: checksum ${run} mismatch`)!;
    expect(out).not.toContain(run);
    expect(out).toContain("[redacted]");
    const letters = "abcdefghijklmnopqrstuvwxyzabcdefghij";
    expect(redactStderrLine(`Error: ${letters}`)).toContain(letters);
    const sid = redactStderrLine("Error: cannot resume ses_0f8c2b9e0000")!;
    expect(sid).not.toContain("0f8c2b9e");
    expect(sid).toMatch(/#[0-9a-f]{8}/);
    expect(redactStderrLine("Error: ```injected")).not.toContain("```");
  });

  it("caps a line at 500 chars and the tail at 20 lines / 2 KB", () => {
    const long = redactStderrLine(`Error: ${"x ".repeat(600)}`)!;
    expect([...long].length).toBeLessThanOrEqual(501);
    const tail = new StderrTail();
    for (let i = 0; i < 30; i++) tail.push(`Error: step ${i} failed`);
    expect(tail.list()).toHaveLength(STDERR_TAIL_LINES);
    expect(tail.list()[0]).toBe("Error: step 10 failed");
    for (let i = 0; i < 20; i++) tail.push(`Error: ${"y ".repeat(200)}`);
    expect(tail.list().reduce((n, l) => n + l.length + 1, 0)).toBeLessThanOrEqual(2000);
  });

  it("keeps the agent's own death note, unless it looks like a secret", () => {
    const tail = new StderrTail();
    tail.push(`${PROCESS_DEATH_PREFIX}OpenCode ran out of disk space.`);
    expect(tail.processDeath).toBe("OpenCode ran out of disk space.");
    const bad = new StderrTail();
    bad.push(`${PROCESS_DEATH_PREFIX}died with token=${KEY}`);
    expect(bad.processDeath).toBeUndefined();
  });

  it("a bare internal error carries the redacted tail; the agent's own message is masked", () => {
    const bare = new AcpRpcError("session/prompt", { code: -32603, message: "Internal error" }, `Error: provider returned 500\n${WITHHELD_LINE}`);
    expect(bare.message).toContain("The agent gave no error details");
    expect(bare.message).toContain("provider returned 500");
    const detailed = new AcpRpcError("session/prompt", { code: -32603, message: "Internal error", data: { message: "quota" } }, "Error: x failed");
    expect(detailed.message).toBe("Internal error");
    const leaky = new AcpRpcError("session/prompt", { code: -32000, message: `bad key ${KEY}` });
    expect(leaky.message).not.toContain(BODY);
  });
});

describe("cause of death", () => {
  function fakeCgroup(oomKill: number, max?: number) {
    const root = tmp();
    const scope = path.join(root, "agents.slice", "worker.scope");
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(path.join(scope, "memory.events"), `low 0\nhigh 0\nmax 9\noom 1\noom_kill ${oomKill}\n`);
    if (max) fs.writeFileSync(path.join(root, "agents.slice", "memory.max"), `${max}\n`);
    return { root, scope };
  }

  it("reads its own cgroup v2 path and counts OOM kills", () => {
    expect(ownCgroup("0::/user.slice/agents.slice/worker.scope\n")).toBe("/sys/fs/cgroup/user.slice/agents.slice/worker.scope");
    expect(ownCgroup(null)).toBeNull();
    expect(oomKills(fakeCgroup(3).scope)).toBe(3);
    expect(oomKills(null)).toBe(0);
  });

  it("a SIGKILL while the OOM kill count rose names the memory limit", () => {
    const { root, scope } = fakeCgroup(1, 3_500_000_000);
    expect(memoryLimit(scope, root)).toBe("3.5 GB");
    const text = describeProcessDeath({ agent: "OpenCode", code: null, signal: "SIGKILL", cgroup: scope, oomKillsBefore: 0, cgroupRoot: root });
    expect(text).toBe(
      "OpenCode ran out of memory: this computer's agents reached their memory limit (3.5 GB) and the system stopped it. Send a message to continue."
    );
  });

  it("a SIGKILL without an OOM kill, and any other death, keep their own reason", () => {
    const { scope } = fakeCgroup(2);
    expect(describeProcessDeath({ agent: "OpenCode", code: null, signal: "SIGKILL", cgroup: scope, oomKillsBefore: 2 })).toBe(
      "OpenCode stopped unexpectedly (process terminated by signal SIGKILL). Send a message to continue."
    );
    expect(describeProcessDeath({ agent: "The agent", code: 1, signal: null, cgroup: null })).toBe(
      "The agent stopped unexpectedly (process exited with code 1). Send a message to continue."
    );
  });
});

describe("chunk-safe stream redaction", () => {
  const splits = (s: string, cuts: number[]) => {
    const out: string[] = [];
    let at = 0;
    for (const c of cuts) {
      out.push(s.slice(at, c));
      at = c;
    }
    out.push(s.slice(at));
    return out;
  };

  it("a secret split over 2 or 3 chunks never appears in the emitted text", () => {
    const text = `Here it is: ${KEY} and done.`;
    const start = text.indexOf(KEY);
    for (const cuts of [[start + 4], [start + 3, start + 15], [start + 9, start + 22], [start + 1, start + 2]]) {
      const r = new DirectStreamRedactor();
      const emitted: string[] = [];
      for (const part of splits(text, cuts)) emitted.push(r.push("a", part));
      for (const rest of r.endAll().values()) emitted.push(rest);
      const all = emitted.join("");
      expect(all).not.toContain(BODY);
      expect(all).not.toContain(KEY.slice(0, 10));
      expect(all).toContain("Here it is:");
      expect(all).toContain("and done.");
    }
  });

  it("plain text is released by the end of the turn", () => {
    const r = new DirectStreamRedactor();
    const first = r.push("a", "Hello wor");
    expect(first).toBe("Hello ");
    expect(r.held("a")).toBe(3);
    expect(r.endAll().get("a")).toBe("wor");
    expect(r.held("a")).toBe(0);
  });
});

/** Records every stream flush and every append, so a leak in any intermediate row is caught. */
class RecordingStore implements DirectStore {
  events: { seq: number; type: string; payload: Record<string, unknown> }[] = [];
  state: DirectStatePatch = {};
  streams = new Map<string, string>();
  flushed: string[] = [];
  userMessage(text: string) {
    const seq = this.events.length + 1;
    this.events.push({ seq, type: "user.message", payload: { text } });
    return { seq, text };
  }
  async appendEvents(events: StoredEvent[], state?: DirectStatePatch) {
    const seqs: number[] = [];
    for (const e of events) {
      const seq = this.events.length + 1;
      this.events.push({ seq, type: e.type, payload: e.payload });
      seqs.push(seq);
    }
    if (state) this.state = { ...this.state, ...state };
    return seqs;
  }
  async flushStream(_seq: number, items: { itemId: string; text: string }[]) {
    for (const i of items) {
      this.streams.set(i.itemId, i.text);
      this.flushed.push(i.text);
    }
  }
  async clearStreams() {
    this.streams.clear();
  }
  async requestApproval() {
    return { status: "auto" as const, approvalId: "ap1", reason: "test" };
  }
  async approvalState() {
    return null;
  }
  async cancelApproval() {}
  async loadEvents() {
    return this.events.map((e) => ({ type: e.type, sequence: e.seq, payload: e.payload }));
  }
  async recordUsage() {}
}

const waitFor = async (pred: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("direct thread runner: nothing secret reaches a row", () => {
  it("a key split across deltas never appears in any flushed hot row or event", async () => {
    const store = new RecordingStore();
    const sinks: SessionSink[] = [];
    const engine: DirectEngine = {
      name: "opencode-acp",
      start(_o, sink) {
        sinks.push(sink);
        return { send() {}, async interrupt() {}, async end() {}, kill() {} };
      },
    };
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store, streamFlushMs: 5 });
    await runner.deliver(store.userMessage("go"));
    for (const part of ["Key: ", KEY.slice(0, 5), KEY.slice(5, 18), KEY.slice(18), " ok"]) {
      sinks[0].output({ kind: "delta", delta: { type: "assistant.text.delta", itemId: "a", text: part } });
      await new Promise((r) => setTimeout(r, 15));
    }
    await waitFor(() => (store.streams.get("a") ?? "").includes("[REDACTED]"));
    sinks[0].output({ kind: "event", event: { type: "tool.result", itemId: "t", ok: true, text: `cat .env\nAPI_KEY=${KEY}`, truncated: false } });
    sinks[0].output({ kind: "result", result: { outcome: "completed", durationMs: 1, queuedTurns: 0 } });
    await runner.idle();
    await runner.drain();
    for (const row of store.flushed) expect(row).not.toContain(BODY);
    expect(JSON.stringify(store.events)).not.toContain(BODY);
    await runner.close();
  });

  it("text still held when the turn ends is released, masked, with the last flush", async () => {
    const store = new RecordingStore();
    const sinks: SessionSink[] = [];
    const engine: DirectEngine = {
      name: "opencode-acp",
      start(_o, sink) {
        sinks.push(sink);
        return { send() {}, async interrupt() {}, async end() {}, kill() {} };
      },
    };
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store, streamFlushMs: 5 });
    await runner.deliver(store.userMessage("go"));
    sinks[0].output({ kind: "delta", delta: { type: "assistant.text.delta", itemId: "a", text: "Almost done" } });
    sinks[0].output({ kind: "result", result: { outcome: "failed", durationMs: 1, queuedTurns: 0, error: `boom ${KEY}` } });
    await waitFor(() => store.events.some((e) => e.type === "turn.completed"));
    await runner.drain();
    expect(store.flushed.at(-1)).toBe("Almost done");
    const done = store.events.find((e) => e.type === "turn.completed")!;
    expect(String(done.payload.error)).not.toContain(BODY);
    await runner.close();
  });

  it("an agent dying with a secret in stderr leaves no secret in the events, and says why it died", async () => {
    const cwd = tmp();
    const store = new RecordingStore();
    const engine = new AcpEngine({ binary: process.execPath, args: [FAKE], env: { ...process.env, FAKE_ACP_SECRET: KEY }, log: silentLogger, workspaceRoot: cwd });
    const runner = new ThreadRunner({ taskId: "t1", cwd, engine, store, streamFlushMs: 5 });
    await runner.deliver(store.userMessage("die-secret"));
    await waitFor(() => store.events.some((e) => e.type === "turn.completed"));
    await runner.drain();
    const done = store.events.find((e) => e.type === "turn.completed")!;
    const error = String(done.payload.error);
    expect(done.payload.outcome).toBe("failed");
    expect(error).toContain("OpenCode stopped unexpectedly (process exited with code 3). Send a message to continue.");
    expect(error).toContain("Error: provider returned 500");
    expect(error).toContain(WITHHELD_LINE);
    expect(error).not.toContain("loading plugins");
    expect(JSON.stringify(store.events)).not.toContain(BODY);
    for (const row of store.flushed) expect(row).not.toContain(BODY);
    await runner.close();
  });
});
