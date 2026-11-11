import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "@/llm";
import { validatePlan } from "@/orchestrator/planValidator";
import { parseIntentResult } from "@/router/semantic";
import { parseFileBlocks } from "@/utils/draftLenient";
import { parseReview } from "@/utils/json";
import { chunkText, loadScript, pickRule, startMockLlm } from "../../../scripts/mock-llm/server";
import { buildChatPersonaLines, buildTurnContextSection } from "../../../apps/api/convex/lib/prompts/chat";

/**
 * The mock LLM (scripts/mock-llm, `npm run mock:llm`) driven through the
 * worker's real OpenAI-compatible provider, and its default script checked
 * against the worker's real parsers, so a prompt or parser change that
 * would break the scripted end-to-end run fails here.
 */
const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function mock(options: Parameters<typeof startMockLlm>[0] = {}) {
  const server = await startMockLlm({ speed: 0, quiet: true, token: "test-token", ...options });
  servers.push(server);
  return server;
}

const script = loadScript();
const replyFor = (text: string, scenario = "default") => pickRule(script, text, scenario, new Map()).reply;

describe("mock LLM server", () => {
  it("answers a chat completion through OpenAICompatibleProvider with usage", async () => {
    const server = await mock();
    const provider = new OpenAICompatibleProvider("test-token", "mock/default", server.url);
    const result = await provider.complete([{ role: "user", content: "You are an intent classifier for a software engineering workspace.\nUser text: add a button" }]);
    expect(parseIntentResult(result.content)?.intent).toBe("task");
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(server.calls.at(-1)).toMatchObject({ role: "classifier", rule: "classifier", stream: false, status: 200 });
  });

  it("streams the scripted reply in 2-12 character SSE deltas", async () => {
    const server = await mock();
    const provider = new OpenAICompatibleProvider("test-token", "mock/default", server.url);
    const chunks: string[] = [];
    const result = await provider.stream([{ role: "user", content: "You are the CTO decision-maker for the multi-agent software engineering workspace." }], (d) => chunks.push(d));
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((c) => c.length >= 1 && c.length <= 12)).toBe(true);
    expect(chunks.join("")).toBe(result.content);
    expect(result.finishReason).toBe("stop");
    expect(validatePlan(JSON.parse(result.content), 6).ok).toBe(true);
  });

  it("replays at 30 Hz times the speed", async () => {
    const reply = replyFor("You are the decision advisor of a multi-agent software engineering orchestrator.");
    const ticks = chunkText(reply).length;
    const server = await mock({ speed: 4 });
    const provider = new OpenAICompatibleProvider("test-token", "mock/default", server.url);
    const started = Date.now();
    await provider.stream([{ role: "user", content: "You are the decision advisor of a multi-agent software engineering orchestrator." }], () => {});
    // ticks × (1000 / 30 / 4) ms, with slack for timer coarseness.
    expect(Date.now() - started).toBeGreaterThanOrEqual(Math.floor(ticks * (1000 / 30 / 4) * 0.7));
  });

  it("refuses a wrong token and lists the scenario models", async () => {
    const server = await mock();
    const provider = new OpenAICompatibleProvider("wrong", "mock/default", server.url);
    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/401/);
    const models = (await (await fetch(`${server.url}/models`, { headers: { authorization: "Bearer test-token" } })).json()) as { data: Array<{ id: string }> };
    expect(models.data.map((m) => m.id)).toEqual(expect.arrayContaining(["mock/default", "mock/held-resume", "mock/research-fanout"]));
  });

  it("scenario rules: held-resume answers 429 twice, then recovers", async () => {
    const server = await mock();
    const provider = new OpenAICompatibleProvider("test-token", "mock/held-resume", server.url);
    const ask = () => provider.complete([{ role: "user", content: "You are an intent classifier for a software engineering workspace." }]);
    await expect(ask()).rejects.toThrow(/429/);
    await expect(ask()).rejects.toThrow(/429/);
    expect(parseIntentResult((await ask()).content)?.intent).toBe("task");
    expect(server.calls.map((c) => c.status)).toEqual([429, 429, 200]);
  });

  it("only binds to loopback", async () => {
    const server = await mock();
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
  });
});

describe("default mock script matches the worker's parsers", () => {
  it("planner reply is a valid plan; the read-only variant only has research nodes", () => {
    expect(validatePlan(JSON.parse(replyFor("You are the CTO decision-maker …")), 6).ok).toBe(true);
    const research = validatePlan(JSON.parse(replyFor("You are the CTO decision-maker …\nREAD-ONLY TASK (classification: research)")), 6, { taskKind: "research" });
    expect(research.ok).toBe(true);
    expect(research.plan?.subtasks.every((s) => s.kind === "research")).toBe(true);
  });

  it("code change, review and classifier replies parse", () => {
    const files = parseFileBlocks(replyFor("Return your change in ONE of these formats: Format C …"))?.files ?? [];
    expect(files.map((f) => f.filePath)).toEqual(["docs/MOCK_LLM.md"]);
    expect(parseReview(replyFor('Return JSON only:\n{"verdict":"approved"|"changes_requested"}'))?.verdict).toBe("approved");
    expect(parseIntentResult(replyFor("You are an intent classifier"))?.intent).toBe("task");
  });

  it("the Convex chat reply (project CTO chat) has its own rule, not the fallback", () => {
    const system = [
      ...buildChatPersonaLines({ name: "CTO", role: "cto" } as any, "Demo", [], null),
      buildTurnContextSection({}),
    ].join("\n");
    const picked = pickRule(script, `${system}\nAdd a footer to index.html`, "default", new Map());
    expect(picked.rule?.id).toBe("chat-reply");
    expect(picked.reply).toMatch(/Create task/);
    expect(picked.reply).not.toMatch(/@\w/); // no @mention: it would pull a teammate into a reply loop
  });

  it("an unmatched request gets the fallback, not an error", () => {
    expect(pickRule(script, "something else entirely", "default", new Map())).toMatchObject({ rule: null, reply: script.fallback });
  });

  it("`times` lets a rule fall through after N uses", () => {
    const used = new Map<string, number>();
    const ids = [1, 2, 3].map(() => pickRule(script, "You are an intent classifier", "held-resume", used).rule?.id);
    expect(ids).toEqual(["held-429", "held-429", "classifier"]);
  });
});
