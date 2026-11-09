/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  describeEndpoint,
  endpointCandidates,
  errorBodyExcerpt,
  llmHttpError,
  wireProtocolFor,
} from "./lib/chat/llmEndpoint";
import { completeWithAgent, completeWithFallback, resolveConfigChain } from "./lib/chat/llm";
import type { PoolConnectionPayload } from "./lib/llmResolver";

const modules = import.meta.glob("./**/*.ts");

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const notFound = () => new Response("404 page not found", { status: 404 });

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe("llm endpoint helpers", () => {
  test("only Anthropic kinds speak the Messages API; everything else is OpenAI chat completions", () => {
    expect(wireProtocolFor("anthropic")).toBe("anthropic");
    expect(wireProtocolFor("Anthropic")).toBe("anthropic");
    expect(wireProtocolFor("claude")).toBe("anthropic");
    expect(wireProtocolFor("openai")).toBe("openai");
    expect(wireProtocolFor("openai-compatible")).toBe("openai");
    expect(wireProtocolFor("openrouter")).toBe("openai");
    expect(wireProtocolFor("ollama")).toBe("openai");
    expect(wireProtocolFor("groq")).toBe("openai");
    expect(wireProtocolFor("", "https://api.anthropic.com/v1")).toBe("anthropic");
  });

  test("base URL with /v1: as configured first, then without /v1", () => {
    expect(endpointCandidates("http://10.0.0.5:8080/v1", "/chat/completions")).toEqual([
      "http://10.0.0.5:8080/v1/chat/completions",
      "http://10.0.0.5:8080/chat/completions",
    ]);
    expect(endpointCandidates("http://10.0.0.5:8080/v1/", "/chat/completions")[0]).toBe("http://10.0.0.5:8080/v1/chat/completions");
  });

  test("base URL without /v1: as configured first, then with /v1", () => {
    expect(endpointCandidates("http://10.0.0.5:8080", "/chat/completions")).toEqual([
      "http://10.0.0.5:8080/chat/completions",
      "http://10.0.0.5:8080/v1/chat/completions",
    ]);
    expect(endpointCandidates("https://api.anthropic.com", "/messages")).toEqual([
      "https://api.anthropic.com/messages",
      "https://api.anthropic.com/v1/messages",
    ]);
  });

  test("a full endpoint URL or a versioned non-/v1 path is used as-is", () => {
    expect(endpointCandidates("http://gw:4000/v1/chat/completions", "/chat/completions")).toEqual([
      "http://gw:4000/v1/chat/completions",
    ]);
    expect(endpointCandidates("https://generativelanguage.googleapis.com/v1beta/openai", "/chat/completions")).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    ]);
  });

  test("error names status, provider kind, host and model — never the key", () => {
    const err = llmHttpError(
      404,
      { provider: "openai-compatible", baseUrl: "http://user:pw@10.0.0.5:8080/v1", model: "qwen" },
      '{"error":"not found","api_key":"sk-supersecretvalue123"}',
      ["http://10.0.0.5:8080/v1/chat/completions"]
    );
    expect(err.message).toContain("LLM request failed: 404");
    expect(err.message).toContain("openai-compatible @ 10.0.0.5:8080");
    expect(err.message).toContain('model "qwen"');
    expect(err.message).not.toContain("sk-supersecretvalue123");
    expect(err.message).not.toContain("pw");
    expect((err as any).status).toBe(404);
    expect(describeEndpoint({ provider: "anthropic", baseUrl: "nonsense" })).toBe("anthropic @ invalid base URL");
    expect(errorBodyExcerpt("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  });
});

// ─── Client behavior ───────────────────────────────────────────────────────

describe("completeWithAgent routing", () => {
  test("a 404 on the configured base retries once with /v1 added", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return String(url).includes("/v1/") ? ok("hello") : notFound();
      })
    );
    const result = await completeWithAgent("sys", [{ role: "user", content: "hi" }], {
      provider: "openai-compatible",
      model: "m",
      baseUrl: "http://10.0.0.5:8080",
      apiKey: "k-secret-123456",
    });
    expect(result.content).toBe("hello");
    expect(urls).toEqual(["http://10.0.0.5:8080/chat/completions", "http://10.0.0.5:8080/v1/chat/completions"]);
  });

  test("a 404 on every candidate fails with kind + host, not the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => notFound()));
    await expect(
      completeWithAgent("sys", [{ role: "user", content: "hi" }], {
        provider: "openai-compatible",
        model: "m",
        baseUrl: "http://10.0.0.5:8080/v1",
        apiKey: "k-secret-123456",
      })
    ).rejects.toThrow(/LLM request failed: 404 \(openai-compatible @ 10\.0\.0\.5:8080, model "m"; tried \/v1\/chat\/completions, \/chat\/completions\)/);
  });

  test("a network failure names the endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(
      completeWithAgent("sys", [{ role: "user", content: "hi" }], { provider: "openai", model: "m", baseUrl: "http://1.2.3.4:9/v1", apiKey: "k" })
    ).rejects.toThrow(/fetch failed \(openai @ 1\.2\.3\.4:9, model "m"\)/);
  });

  test("a non-openai, non-anthropic kind (openrouter) speaks chat completions with a bearer key", async () => {
    const seen: Array<{ url: string; headers: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), headers: init.headers });
        return ok("routed");
      })
    );
    const result = await completeWithAgent("sys", [{ role: "user", content: "hi" }], {
      provider: "openrouter",
      model: "m",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "k",
    });
    expect(result.content).toBe("routed");
    expect(seen[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen[0].headers.authorization).toBe("Bearer k");
  });

  test("completeWithFallback answers from the second config when the first fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).startsWith("http://primary") ? notFound() : ok("from fallback")))
    );
    const result = await completeWithFallback("sys", [{ role: "user", content: "hi" }], [
      { provider: "openai-compatible", model: "a", baseUrl: "http://primary:1/v1", apiKey: "k" },
      { provider: "openai-compatible", model: "b", baseUrl: "http://secondary:2/v1", apiKey: "k" },
    ]);
    expect(result.content).toBe("from fallback");
    expect(result.fellBack).toBe(true);
    expect(result.config.model).toBe("b");
    expect(result.primaryError).toContain("openai-compatible @ primary:1");
  });

  test("resolveConfigChain: primary then the agent's fallback; same model is not repeated", async () => {
    const pool = [
      { _id: "p1", name: "A", provider: "openai-compatible", model: "a", baseUrl: "http://a/v1", apiKeyEnv: "X_A", priority: 0, weight: 1, models: [{ _id: "m1", modelId: "a", isAvailable: true }] },
      { _id: "p2", name: "B", provider: "openai-compatible", model: "b", baseUrl: "http://b/v1", apiKeyEnv: "X_B", priority: 1, weight: 1, models: [{ _id: "m2", modelId: "b", isAvailable: true }] },
    ] as unknown as PoolConnectionPayload[];
    const env = { provider: "openai", model: "g", baseUrl: "http://g/v1", apiKey: "global" };
    const chain = await resolveConfigChain(pool, env, { llmProviderId: "p1", llmModelId: "m1", llmFallbackProviderId: "p2", llmFallbackModelId: "m2" });
    expect(chain.map((c) => c.model)).toEqual(["a", "b"]);
    const single = await resolveConfigChain(pool, env, { llmProviderId: "p1", llmModelId: "m1", llmFallbackProviderId: "p1", llmFallbackModelId: "m1" });
    expect(single.map((c) => c.model)).toEqual(["a"]);
    expect((await resolveConfigChain(pool, env, { llmProviderId: "p1" })).length).toBe(1);
  });
});

// ─── Reviewer uses its fallback model ──────────────────────────────────────

describe("reviewer fallback model", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    process.env.REVIEW_KEY_A = "key-a";
    process.env.REVIEW_KEY_B = "key-b";
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.REVIEW_KEY_A;
    delete process.env.REVIEW_KEY_B;
  });

  test("a primary that 404s falls back to the Reviewer's fallback model", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await t.run(async (ctx) => {
      const now = Date.now();
      const primary = await ctx.db.insert("llmProviders", {
        name: "Gateway", provider: "openai-compatible", model: "qwen", baseUrl: "http://10.0.0.5:8080/v1",
        apiKeyEnv: "REVIEW_KEY_A", priority: 0, weight: 1, isEnabled: true, createdAt: now,
      });
      const backup = await ctx.db.insert("llmProviders", {
        name: "Backup", provider: "openai", model: "gpt-backup", baseUrl: "https://backup.example/v1",
        apiKeyEnv: "REVIEW_KEY_B", priority: 1, weight: 1, isEnabled: true, createdAt: now,
      });
      const primaryModel = await ctx.db.insert("llmModels", { providerId: primary, modelId: "qwen", isAvailable: true, createdAt: now, updatedAt: now });
      const backupModel = await ctx.db.insert("llmModels", { providerId: backup, modelId: "gpt-backup", isAvailable: true, createdAt: now, updatedAt: now });
      await ctx.db.insert("agents", {
        name: "Reviewer", role: "reviewer", status: "idle", systemPrompt: "You review code.",
        llmProviderId: primary, llmModelId: primaryModel, llmFallbackProviderId: backup, llmFallbackModelId: backupModel,
      });
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const asked = await ctx.db.insert("messages", { projectId, authorType: "user", content: "Is this right?" });
      const messageId = await ctx.db.insert("messages", { projectId, authorType: "agent", content: "Yes.", replyToMessageId: asked });
      return { messageId };
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return String(url).startsWith("https://backup.example") ? ok('{"verdict":"agree","reason":"Fine.","evidence":[]}') : notFound();
      })
    );
    const opinionId = await t.mutation(api.reviewer.requestMessageOpinion, { messageId });
    await t.action(internal.reviewerNode.runReview, { opinionId });
    const row = await t.run((ctx) => ctx.db.get(opinionId));
    expect(row).toMatchObject({ status: "done", verdict: "agree", model: "gpt-backup" });
    expect(urls[0]).toBe("http://10.0.0.5:8080/v1/chat/completions");
    expect(urls[urls.length - 1]).toBe("https://backup.example/v1/chat/completions");
  });

  test("when every model fails, the stored error names kind and host (no key)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await t.run(async (ctx) => {
      const now = Date.now();
      const primary = await ctx.db.insert("llmProviders", {
        name: "Gateway", provider: "openai-compatible", model: "qwen", baseUrl: "http://10.0.0.5:8080/v1",
        apiKeyEnv: "REVIEW_KEY_A", priority: 0, weight: 1, isEnabled: true, createdAt: now,
      });
      await ctx.db.insert("llmModels", { providerId: primary, modelId: "qwen", isAvailable: true, createdAt: now, updatedAt: now });
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const asked = await ctx.db.insert("messages", { projectId, authorType: "user", content: "Q" });
      const messageId = await ctx.db.insert("messages", { projectId, authorType: "agent", content: "A", replyToMessageId: asked });
      return { messageId };
    });
    vi.stubGlobal("fetch", vi.fn(async () => notFound()));
    const opinionId = await t.mutation(api.reviewer.requestMessageOpinion, { messageId });
    await t.action(internal.reviewerNode.runReview, { opinionId });
    const row = await t.run((ctx) => ctx.db.get(opinionId));
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("openai-compatible @ 10.0.0.5:8080");
    expect(row?.error).not.toContain("key-a");
  });
});
