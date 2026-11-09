/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  MAX_REPO_TOOL_CALLS,
  REPO_TOOL_CAPS,
  TOOL_BUDGET_EXHAUSTED,
  capToolOutput,
  mayBeToolCall,
  parseRepoToolCall,
  runRepoToolLoop,
  type RepoToolCall,
} from "./lib/chat/repoTools";
import {
  buildChatPersonaLines,
  buildGroundingGuidance,
  buildRepoToolProtocol,
  buildSelfReviewGuidance,
} from "./lib/prompts/chat";
import { classifyChatIntent, hasAskShape, isSelfReviewRequest, previousReplyOf } from "./lib/chat/intent";

const modules = import.meta.glob("./**/*.ts");

describe("repo tool call parsing and caps", () => {
  test("a bare JSON object (or fenced / tagged) is a tool call; prose is an answer", () => {
    expect(parseRepoToolCall('{"tool":"grep","arguments":{"pattern":"foo"}}')).toEqual({
      tool: "grep",
      args: { pattern: "foo" },
    });
    expect(parseRepoToolCall('```json\n{"tool":"read_file","arguments":{"path":"a.ts"}}\n```')?.tool).toBe("read_file");
    expect(parseRepoToolCall('<tool_call>{"name":"list_files","arguments":{}}</tool_call>')?.tool).toBe("list_files");
    expect(parseRepoToolCall('Here is the config: {"tool":"grep"}')).toBeNull();
    expect(parseRepoToolCall("orchestration.ts is 91 KB")).toBeNull();
    expect(parseRepoToolCall('{"answer":"x"}')).toBeNull();
  });

  test("partial replies that may still become a tool call are held back", () => {
    expect(mayBeToolCall('{"tool":"gr')).toBe(true);
    expect(mayBeToolCall("```json")).toBe(true);
    expect(mayBeToolCall("Sudah saya cek")).toBe(false);
  });

  test("capToolOutput clips with a visible marker and never exceeds the cap", () => {
    const long = "x".repeat(REPO_TOOL_CAPS.resultMaxChars * 2);
    const capped = capToolOutput(long);
    expect(capped.length).toBeLessThanOrEqual(REPO_TOOL_CAPS.resultMaxChars);
    expect(capped).toMatch(/truncated: \d+ more chars/);
    expect(capToolOutput("short")).toBe("short");
  });
});

describe("repo tool loop (mocked LLM)", () => {
  test("grep → read_file → answer: results are fed back and read files are recorded", async () => {
    const replies = [
      '{"tool":"grep","arguments":{"pattern":"replyToChat","path":"apps/api/convex"}}',
      '{"tool":"read_file","arguments":{"path":"apps/api/convex/chat.ts","maxLines":40}}',
      "Sudah saya cek: `replyToChat` ada di apps/api/convex/chat.ts (721 baris).",
    ];
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const calls: RepoToolCall[] = [];
    const result = await runRepoToolLoop({
      messages: [{ role: "user", content: "orchestration.ts 91KB, chat reply dibuat di worker kan?" }],
      step: async (messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        return { content: replies[seen.length - 1] };
      },
      callTool: async (call) => {
        calls.push(call);
        if (call.tool === "grep") return { ok: true, text: "apps/api/convex/chat.ts:412: export const replyToChat = internalAction({" };
        return { ok: true, text: "apps/api/convex/chat.ts: 30000 bytes, 721 lines\n1: \"use node\";", files: ["apps/api/convex/chat.ts"] };
      },
    });
    expect(calls.map((c) => c.tool)).toEqual(["grep", "read_file"]);
    expect(result.answer).toContain("Sudah saya cek");
    expect(result.checkedFiles).toEqual(["apps/api/convex/chat.ts"]);
    expect(result.calls).toHaveLength(2);
    // Step 2 saw the grep result; step 3 saw both results.
    expect(seen[1].at(-1)?.content).toMatch(/^\[tool result: grep "replyToChat" in apps\/api\/convex\]/);
    expect(seen[2].at(-1)?.content).toMatch(/^\[tool result: read_file apps\/api\/convex\/chat.ts\]/);
    expect(seen[0]).toHaveLength(1); // the caller's array is not mutated
  });

  test("tools that are not read-only are refused locally, never executed", async () => {
    const replies = ['{"tool":"write_file","arguments":{"path":"a.ts","content":"x"}}', "Saya tidak bisa menulis file."];
    let i = 0;
    const executed: string[] = [];
    const result = await runRepoToolLoop({
      messages: [{ role: "user", content: "ubah a.ts" }],
      step: async () => ({ content: replies[i++] }),
      callTool: async (call) => {
        executed.push(call.tool);
        return { ok: true, text: "" };
      },
    });
    expect(executed).toEqual([]);
    expect(result.calls[0]).toEqual({ call: { tool: "write_file", args: { path: "a.ts", content: "x" } }, ok: false });
    expect(result.answer).toBe("Saya tidak bisa menulis file.");
  });

  test("the loop stops after the call budget and asks for a tool-free answer", async () => {
    let steps = 0;
    let lastMessages: Array<{ role: string; content: string }> = [];
    const result = await runRepoToolLoop({
      messages: [{ role: "user", content: "cek semua" }],
      step: async (messages) => {
        steps += 1;
        lastMessages = messages;
        return {
          content: messages.at(-1)?.content === TOOL_BUDGET_EXHAUSTED ? "Ringkasan; sisanya belum saya cek." : '{"tool":"list_files","arguments":{}}',
        };
      },
      callTool: async () => ({ ok: true, text: "a.ts (1 bytes)" }),
    });
    expect(result.calls).toHaveLength(MAX_REPO_TOOL_CALLS);
    expect(steps).toBe(MAX_REPO_TOOL_CALLS + 1);
    expect(lastMessages.at(-1)?.content).toBe(TOOL_BUDGET_EXHAUSTED);
    expect(result.answer).toContain("belum saya cek");
  });
});

describe("grounding prompt assembly", () => {
  test("no tools → the prompt requires 'belum saya cek' and forbids unverified code claims", () => {
    const lines = buildGroundingGuidance(false).join("\n");
    expect(lines).toContain("belum saya cek");
    expect(lines).toMatch(/no repo access/i);
    expect(lines).toMatch(/pasted is a claim to verify/);
    expect(lines).not.toMatch(/Check with the repo tools/);
  });

  test("with tools → check first, re-check on pushback, still say 'belum saya cek' when unchecked", () => {
    const lines = buildGroundingGuidance(true).join("\n");
    expect(lines).toMatch(/Check with the repo tools/);
    expect(lines).toMatch(/re-check with the tools/);
    expect(lines).toMatch(/Never agree just because the user said so/);
    expect(lines).toContain("belum saya cek");
  });

  test("tool protocol lists only read-only tools and the call cap", () => {
    const protocol = buildRepoToolProtocol(6);
    expect(protocol).toMatch(/list_files/);
    expect(protocol).toMatch(/grep/);
    expect(protocol).toMatch(/read_file/);
    expect(protocol).toMatch(/At most 6 tool calls/);
    expect(protocol).toMatch(/cannot write files or run commands/);
  });

  test("snapshot line no longer says 'cannot read other files' when tools are on", () => {
    const agent = { name: "Atlas", role: "cto" };
    expect(buildChatPersonaLines(agent, "P", [agent], "tree", false).join("\n")).toMatch(/cannot run commands or read other files/);
    expect(buildChatPersonaLines(agent, "P", [agent], "tree", true).join("\n")).toMatch(/repo tools described below/);
  });

  test("self-review quotes the agent's own previous reply and says it is not about skills", () => {
    const text = buildSelfReviewGuidance("orchestration.ts is 91KB and owns chat replies.", true);
    expect(text).toContain("orchestration.ts is 91KB and owns chat replies.");
    expect(text).toMatch(/YOUR previous reply/);
    expect(text).toMatch(/not to re-read your skills/);
    expect(text).toMatch(/repo tools/);
  });
});

describe("self-review requests", () => {
  test("'baca ulang' / 'cek lagi' / 'koreksi' are chat, not tasks", () => {
    for (const text of ["baca ulang jawabanmu", "cek lagi", "koreksi yang tadi", "re-read your last answer"]) {
      expect(isSelfReviewRequest(text)).toBe(true);
      expect(hasAskShape(text)).toBe(true);
      expect(classifyChatIntent(text).kind).toBe("chat");
    }
  });

  test("a self-review that also asks for a change stays a change request", () => {
    expect(isSelfReviewRequest("cek lagi lalu perbaiki bug di login")).toBe(false);
    expect(classifyChatIntent("cek lagi lalu perbaiki bug di login").kind).toBe("task");
  });

  test("previousReplyOf picks the speaker's own last reply before the user's message", () => {
    const history = [
      { authorType: "user", content: "q1" },
      { authorType: "agent", content: "cto answer", agentId: "cto" },
      { authorType: "agent", content: "frontend answer", agentId: "fe" },
      { authorType: "user", content: "koreksi" },
    ];
    expect(previousReplyOf(history, "cto")).toBe("cto answer");
    expect(previousReplyOf(history, "qa")).toBe("frontend answer");
    expect(previousReplyOf([{ authorType: "user", content: "koreksi" }], "cto")).toBeNull();
  });
});

describe("repoToolCalls queue", () => {
  const SERVICE_TOKEN = "test-service-token";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CONVEX_SERVICE_TOKEN;
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CONVEX_SERVICE_TOKEN;
    else process.env.CONVEX_SERVICE_TOKEN = prev;
  });

  async function seed(t: ReturnType<typeof convexTest>, workspacePath?: string) {
    return await t.run(async (ctx) =>
      ctx.db.insert("projects", { name: "P", workspacePath: workspacePath ?? "" })
    );
  }

  test("enqueue → claim → complete → get, fenced by worker id; tokens required", async () => {
    const t = convexTest(schema, modules);
    const projectId = await seed(t, "/repo");
    const callId = await t.mutation(internal.repoTools.enqueue, {
      projectId,
      tool: "grep",
      args: JSON.stringify({ pattern: "x" }),
    });
    await expect(
      t.action(api.worker.claimRepoToolCall, { workerToken: "wrong", workerId: "w1" })
    ).rejects.toThrow();
    const claim = await t.action(api.worker.claimRepoToolCall, { workerToken: SERVICE_TOKEN, workerId: "w1" });
    expect(claim).toMatchObject({ callId, tool: "grep", workspacePath: "/repo" });
    // Nothing else is pending.
    expect(await t.mutation(internal.repoTools.claimNext, { workerId: "w2" })).toBeNull();
    // Another worker cannot complete it.
    expect(
      await t.mutation(internal.repoTools.complete, { callId, workerId: "w2", ok: true, result: "hijack" })
    ).toBe(false);
    expect(
      await t.action(api.worker.completeRepoToolCall, {
        workerToken: SERVICE_TOKEN,
        callId,
        workerId: "w1",
        ok: true,
        result: "a.ts:1: x",
        files: [],
      })
    ).toBe(true);
    expect(await t.query(internal.repoTools.get, { callId })).toMatchObject({ status: "done", result: "a.ts:1: x" });
    await t.mutation(internal.repoTools.remove, { callId });
    expect(await t.query(internal.repoTools.get, { callId })).toBeNull();
  });

  test("availability needs a workspace and a fresh online worker that serves repo tools", async () => {
    const t = convexTest(schema, modules);
    const withRepo = await seed(t, "/repo");
    const noRepo = await seed(t);
    expect(await t.query(internal.repoTools.availability, { projectId: withRepo })).toEqual({
      available: false,
      reason: "no_worker",
    });
    // An online worker from before repo tools (no capability) never polls the queue.
    const old = await t.run(async (ctx) =>
      ctx.db.insert("workers", {
        workerId: "w0",
        capacity: 1,
        activeTasks: 0,
        status: "online",
        lastHeartbeatAt: Date.now(),
      })
    );
    expect(await t.query(internal.repoTools.availability, { projectId: withRepo })).toEqual({
      available: false,
      reason: "worker_outdated",
    });
    // A stale heartbeat does not count either.
    await t.run(async (ctx) =>
      ctx.db.insert("workers", {
        workerId: "w-stale",
        capacity: 1,
        activeTasks: 0,
        status: "online",
        lastHeartbeatAt: Date.now() - 10 * 60_000,
        capabilities: ["repoTools"],
      })
    );
    expect((await t.query(internal.repoTools.availability, { projectId: withRepo })).available).toBe(false);
    await t.run(async (ctx) => ctx.db.patch(old, { capabilities: ["repoTools"] }));
    expect(await t.query(internal.repoTools.availability, { projectId: withRepo })).toEqual({ available: true });
    expect(await t.query(internal.repoTools.availability, { projectId: noRepo })).toEqual({
      available: false,
      reason: "no_workspace",
    });
  });
});
