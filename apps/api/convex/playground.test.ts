/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Every table a playground run must never write. */
const GUARDED_TABLES = [
  "tasks",
  "subtasks",
  "executions",
  "plans",
  "fileChanges",
  "approvals",
  "taskEvents",
  "messages",
  "taskInputs",
  "contextSnapshots",
  "memories",
] as const;

async function counts(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of GUARDED_TABLES) out[table] = (await ctx.db.query(table as any).collect()).length;
    return out;
  });
}

function stubLlm(reply: string) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return calls;
}

describe("Agent Playground", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("a run has no side effects beyond one playground usage row and one audit row", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_API_KEY", "sk-test-abcdefghijklmnopqrstu");
    vi.stubEnv("LLM_MODEL", "gpt-test");
    // A reply that LOOKS like a tool call (write a file / run a command): it
    // is shown, never executed.
    const calls = stubLlm('{"tool":"write_file","arguments":{"path":"x.ts","content":"rm -rf /"}}');
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "done" });
      return projectId;
    });
    const before = await counts(t);
    const result = await t.action(api.playground.run, {
      projectId,
      sections: [
        { key: "system", content: "You are QA." },
        { key: "tools", content: "## Repo tools\n- write_file {\"path\": file}" },
        { key: "user", content: "Check the page" },
      ],
      temperature: 0.3,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("write_file");
    expect(result.model).toBe("gpt-test");
    expect(result.inputTokens).toBeGreaterThan(0);

    // Exactly one LLM request, with no tools parameter and tool text off by default.
    expect(calls).toHaveLength(1);
    expect(calls[0].body).not.toHaveProperty("tools");
    expect(calls[0].body).not.toHaveProperty("tool_choice");
    expect(calls[0].body.temperature).toBe(0.3);
    expect(JSON.stringify(calls[0].body.messages)).not.toContain("write_file {");

    // Nothing in the guarded tables changed.
    expect(await counts(t)).toEqual(before);
    const { usage, audit } = await t.run(async (ctx) => ({
      usage: await ctx.db.query("tokenUsage").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: "playground", agentName: "Playground", model: "gpt-test" });
    expect(usage[0].taskId).toBeUndefined();
    expect(audit.filter((a) => a.action === "playground.run")).toHaveLength(1);
  });

  test("tool definitions ride along as prompt text only when toggled on", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_API_KEY", "sk-test-abcdefghijklmnopqrstu");
    const calls = stubLlm("ok");
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" }));
    await t.action(api.playground.run, {
      projectId,
      sections: [
        { key: "tools", content: "TOOL-CATALOG" },
        { key: "user", content: "hi" },
      ],
      toolsEnabled: true,
    });
    expect(JSON.stringify(calls[0].body.messages)).toContain("TOOL-CATALOG");
    expect(calls[0].body).not.toHaveProperty("tools");
  });

  test("a provider failure is reported, audited and still writes nothing else", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_API_KEY", "sk-test-abcdefghijklmnopqrstu");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" }));
    const before = await counts(t);
    const result = await t.action(api.playground.run, { projectId, sections: [{ key: "user", content: "hi" }] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
    expect(await counts(t)).toEqual(before);
  });

  test("saving a variant makes an unpinned project note (never injected)", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" }));
    await t.mutation(api.playground.saveVariant, { projectId, title: "Shorter QA prompt", content: "token=abcd1234efgh" });
    const notes = await t.run((ctx) => ctx.db.query("memories").collect());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ pinned: false, scope: "project", tags: ["playground"] });
    expect(notes[0].content).not.toContain("abcd1234efgh");
  });
});
