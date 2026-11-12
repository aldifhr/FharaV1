import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage, LLMProvider } from "@/llm";
import { readSpill, removeTaskSpill, spillIfLarge, sweepSpill, isSpillPreview, SPILL_READ_TOOL, type SpillConfig } from "@/context/toolOutputSpill";
import { runToolLoop } from "@/tools/toolLoop";
import { callWithOverflowRecovery } from "@/context/overflowRecovery";
import { LlmContextOverflowError } from "@/llm/errors";
import { withSnapshotScope } from "@/llm/snapshots";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function cfg(over: Partial<SpillConfig> = {}): SpillConfig {
  const root = mkdtempSync(path.join(os.tmpdir(), "spill-"));
  roots.push(root);
  return { maxChars: 16_384, root, headChars: 4096, tailChars: 1024, retentionMs: 72 * 3_600_000, ...over };
}
const KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** ~2 MB log with a unique middle line. */
const bigLog = () => Array.from({ length: 40_000 }, (_, i) => (i === 20_000 ? "MIDDLE-NEEDLE line\n" : `line ${i} ${"x".repeat(40)}\n`)).join("");

describe("spillIfLarge", () => {
  it("spills a 2 MB output: head + tail + notice under the D2 prune threshold, file 0600 outside the worktree", () => {
    const config = cfg();
    const text = bigLog();
    const out = spillIfLarge(text, { taskId: "task1", callId: "c1", config });
    expect(out.spilled?.locator).toBe("spill:task1/c1");
    expect(out.text.startsWith(text.slice(0, 4096))).toBe(true);
    expect(out.text).toContain(text.slice(-1024));
    expect(out.text).toContain(`(Full output saved as spill:task1/c1, ${text.length} chars`);
    expect(out.text).toContain(`${SPILL_READ_TOOL} {"id":"spill:task1/c1","offset":4096`);
    expect(out.text).not.toContain("MIDDLE-NEEDLE");
    expect(out.text.length).toBeLessThan(8192);
    expect(isSpillPreview(out.text)).toBe(true);
    const file = path.join(config.root, "task1", "c1.txt");
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("does not spill under the threshold, or when off", () => {
    const config = cfg();
    expect(spillIfLarge("x".repeat(16_384), { taskId: "t", callId: "c", config })).toEqual({ text: "x".repeat(16_384) });
    expect(spillIfLarge("x".repeat(50_000), { taskId: "t", callId: "c", config: { ...config, maxChars: 0 } }).spilled).toBeUndefined();
    expect(existsSync(path.join(config.root, "t"))).toBe(false);
  });

  it("masks secrets before writing the file (L2 redactText; whole text, so no chunk redactor is needed)", () => {
    const config = cfg();
    const text = `${"a".repeat(10_000)} key=${KEY} ${"b".repeat(10_000)}`;
    const out = spillIfLarge(text, { taskId: "t", callId: "c", config });
    const saved = readFileSync(path.join(config.root, "t", "c.txt"), "utf8");
    expect(saved).not.toContain(KEY);
    expect(out.text).not.toContain(KEY);
  });

  it("keeps the original text and logs when the write fails", () => {
    const config = cfg();
    const logs: string[] = [];
    const blocker = path.join(config.root, "file");
    writeFileSync(blocker, "");
    const out = spillIfLarge("y".repeat(20_000), { taskId: "t", callId: "c", config: { ...config, root: blocker }, log: (m) => logs.push(m) });
    expect(out).toEqual({ text: "y".repeat(20_000) });
    expect(logs[0]).toMatch(/could not save tool output .*kept inline/);
  });

  it("never splits a multibyte character at the head, tail or a range edge", () => {
    const config = cfg({ maxChars: 100, headChars: 11, tailChars: 11 });
    const text = "😀".repeat(200); // each is two UTF-16 units
    const out = spillIfLarge(text, { taskId: "t", callId: "emoji", config });
    expect(out.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    const read = readSpill("spill:t/emoji", { taskId: "t", offset: 3, limit: 5, config });
    expect(read.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("readSpill", () => {
  it("returns the omitted middle by offset + limit, with the next offset", () => {
    const config = cfg();
    const text = bigLog();
    spillIfLarge(text, { taskId: "task1", callId: "c1", config });
    const at = text.indexOf("MIDDLE-NEEDLE");
    const read = readSpill("spill:task1/c1", { taskId: "task1", offset: at, limit: 100, config });
    expect(read.ok).toBe(true);
    expect(read.text).toContain("MIDDLE-NEEDLE line");
    expect(read.text).toContain(`[spill:task1/c1 chars ${at}-${at + 100} of ${text.length}]`);
    expect(read.text).toContain(`"offset":${at + 100}`);
    expect(readSpill("spill:task1/c1", { taskId: "task1", offset: text.length - 5, config }).text).toContain("End of output");
    // limit is capped below the D2 threshold
    expect(readSpill("spill:task1/c1", { taskId: "task1", limit: 1e9, config }).text.length).toBeLessThan(8192);
  });

  it("refuses another task's locator, a malformed id and a traversal", () => {
    const config = cfg();
    spillIfLarge("z".repeat(20_000), { taskId: "other", callId: "c1", config });
    expect(readSpill("spill:other/c1", { taskId: "mine", config })).toMatchObject({ ok: false, isError: true, text: expect.stringMatching(/another task/) });
    expect(readSpill("spill:mine/../other/c1", { taskId: "mine", config }).ok).toBe(false);
    expect(readSpill("/etc/passwd", { taskId: "mine", config }).ok).toBe(false);
    expect(readSpill("spill:mine/none", { taskId: "mine", config }).text).toMatch(/No saved output/);
  });
});

describe("cleanup", () => {
  it("sweeps task dirs past retention, keeps fresh ones; removeTaskSpill drops one task", () => {
    const config = cfg({ retentionMs: 3_600_000 });
    spillIfLarge("o".repeat(20_000), { taskId: "old", callId: "c", config });
    spillIfLarge("n".repeat(20_000), { taskId: "new", callId: "c", config });
    const past = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(path.join(config.root, "old", "c.txt"), past, past);
    utimesSync(path.join(config.root, "old"), past, past);
    expect(sweepSpill(config)).toBe(1);
    expect(existsSync(path.join(config.root, "old"))).toBe(false);
    expect(existsSync(path.join(config.root, "new", "c.txt"))).toBe(true);
    removeTaskSpill("new", config);
    expect(existsSync(path.join(config.root, "new"))).toBe(false);
    expect(sweepSpill({ ...config, root: path.join(config.root, "missing") })).toBe(0);
  });
});

describe("tool loop wiring", () => {
  it("a big tool result reaches the model as a preview; read_tool_output pages the middle; the task comes from the snapshot scope", async () => {
    const config = cfg();
    vi.stubEnv("FHARA_SPILL_DIR", config.root);
    const text = bigLog();
    const seen: string[] = [];
    const at = text.indexOf("MIDDLE-NEEDLE");
    const replies = [
      JSON.stringify({ tool: "logs", arguments: {} }),
      JSON.stringify({ tool: SPILL_READ_TOOL, arguments: { id: "", offset: at, limit: 50 } }),
      JSON.stringify({ answer: "done" }),
    ];
    let locator = "";
    const result = await withSnapshotScope({ taskId: "taskA", subtaskKey: "s1" }, () =>
      runToolLoop({
        tools: [{ name: "logs" }],
        callTool: async () => ({ ok: true, text, isError: false }),
        messages: [{ role: "user", content: "task" }],
        stuckDetection: false,
        spill: undefined,
        runLlm: async (messages) => {
          const last = messages[messages.length - 1].content;
          seen.push(last);
          const reply = replies.shift()!;
          if (reply.includes(SPILL_READ_TOOL)) {
            locator = /spill:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/.exec(last)![0];
            return reply.replace('"id":""', `"id":"${locator}"`);
          }
          return reply;
        },
      })
    );
    expect(existsSync(path.join(config.root, "taskA"))).toBe(true);
    expect(result.answer).toBe("done");
    expect(locator.startsWith("spill:taskA/s1-")).toBe(true);
    expect(seen[1].length).toBeLessThan(9000);
    expect(seen[1]).not.toContain("MIDDLE-NEEDLE");
    expect(seen[2]).toContain("MIDDLE-NEEDLE");
  });

  it("no spill without a task, under the threshold, or with spill: false", async () => {
    vi.stubEnv("FHARA_SPILL_DIR", cfg().root);
    const run = async (spill: false | undefined, text: string) => {
      const seen: string[] = [];
      const replies = [JSON.stringify({ tool: "t", arguments: {} }), JSON.stringify({ answer: "ok" })];
      await runToolLoop({
        tools: [{ name: "t" }],
        callTool: async () => ({ ok: true, text, isError: false }),
        messages: [{ role: "user", content: "task" }],
        stuckDetection: false,
        spill,
        runLlm: async (m) => (seen.push(m[m.length - 1].content), replies.shift()!),
      });
      return seen[1];
    };
    expect(await run(undefined, "x".repeat(50_000))).toContain("x".repeat(50_000));
    expect(await withSnapshotScope({ taskId: "tB" }, () => run(false, "x".repeat(50_000)))).toContain("x".repeat(50_000));
    expect(await withSnapshotScope({ taskId: "tB" }, () => run(undefined, "short"))).toContain("short");
  });

  it("pruned spilled results keep the locator notice", async () => {
    const config = cfg({ maxChars: 1024 });
    const replies = [...Array(6)].map((_, i) => JSON.stringify({ tool: "t", arguments: { i } })).concat(JSON.stringify({ answer: "ok" }));
    let last: LLMMessage[] = [];
    await runToolLoop({
      tools: [{ name: "t" }],
      callTool: async ({ args }) => ({ ok: true, text: `${args.i}`.repeat(30_000), isError: false }),
      messages: [{ role: "user", content: "task" }],
      stuckDetection: false,
      maxIterations: 7,
      prune: { protect: 1000, minimum: 100 },
      spill: { taskId: "tP", config },
      runLlm: async (m) => ((last = [...m]), replies.shift()!),
    });
    const pruned = last.filter((m) => m.content.includes("[pruned]"));
    expect(pruned.length).toBeGreaterThan(0);
    for (const m of pruned) expect(m.content).toMatch(/\[pruned\] \(Full output saved as spill:tP\//);
  });
});

describe("D2 consistency", () => {
  it("overflow recovery does not re-prune a spill preview, and keeps its locator when it compacts", async () => {
    const config = cfg();
    const preview = spillIfLarge(bigLog(), { taskId: "t", callId: "c", config }).text;
    const messages: LLMMessage[] = [
      { role: "user", content: "task" },
      { role: "user", content: preview },
      { role: "user", content: "q".repeat(40_000) },
      { role: "user", content: "newest" },
    ];
    let calls = 0;
    await callWithOverflowRecovery({
      messages,
      call: async (m) => {
        calls++;
        if (calls === 1) throw new LlmContextOverflowError("maximum context length is 100000 tokens", { status: 400, contextLimit: 100_000 });
        return m;
      },
    });
    expect(messages[1].content).toBe(preview);
    expect(messages[2].content.length).toBeLessThan(8192);

    const again: LLMMessage[] = [{ role: "user", content: "task" }, { role: "user", content: preview }, { role: "user", content: "newest" }];
    let n = 0;
    await callWithOverflowRecovery({
      messages: again,
      call: async (m) => {
        if (n++ === 0) throw new LlmContextOverflowError("maximum context length is 10 tokens", { status: 400, contextLimit: 10 });
        return m;
      },
    });
    expect(again[1].content).toMatch(/removed to fit[\s\S]*Saved tool outputs still readable:\n\(Full output saved as spill:t\/c/);
  });
});

