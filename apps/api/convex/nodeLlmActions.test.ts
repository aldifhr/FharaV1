/// <reference types="vite/client" />
/**
 * Magic prompt (llmProvidersNode.enhancePrompt) and Self-Improvement Lab
 * "Suggest fix" (improveNode.runSuggestion) run in the Node runtime and go
 * through the shared endpoint helper (lib/chat/llm + llmEndpoint): a plain
 * http://<ip>:<port> gateway without /v1 that 404s on the bare path is
 * retried with /v1, and a failure names kind + host, never the key.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { enhancementUserMessage } from "./lib/prompts/enhance";

const modules = import.meta.glob("./**/*.ts");

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const notFound = () => new Response("404 page not found", { status: 404 });

const TOKEN = "svc-token-node-llm";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  process.env.CONVEX_SERVICE_TOKEN = TOKEN;
  process.env.GATEWAY_KEY = "gw-secret-key";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CONVEX_SERVICE_TOKEN;
  delete process.env.GATEWAY_KEY;
});

async function withGateway() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const now = Date.now();
    const providerId = await ctx.db.insert("llmProviders", {
      name: "Gateway", provider: "openai-compatible", model: "qwen", baseUrl: "http://10.0.0.5:8080",
      apiKeyEnv: "GATEWAY_KEY", priority: 0, weight: 1, isEnabled: true, createdAt: now,
    });
    await ctx.db.insert("llmModels", { providerId, modelId: "qwen", isAvailable: true, createdAt: now, updatedAt: now });
  });
  return t;
}

describe("magic prompt (enhancePrompt) in the Node runtime", () => {
  test("a gateway that 404s on the bare base is retried with /v1 and the rewrite is returned", async () => {
    const t = await withGateway();
    const calls: Array<{ url: string; body: any; auth: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
        return String(url) === "http://10.0.0.5:8080/v1/chat/completions" ? ok("  Add a dark mode toggle.  ") : notFound();
      })
    );
    const enhanced = await t.action(api.llmProvidersNode.enhancePrompt, { token: TOKEN, prompt: "dark mode" });
    expect(enhanced).toBe("Add a dark mode toggle.");
    expect(calls.map((c) => c.url)).toEqual([
      "http://10.0.0.5:8080/chat/completions",
      "http://10.0.0.5:8080/v1/chat/completions",
    ]);
    expect(calls[1].body.model).toBe("qwen");
    expect(calls[1].body.messages[1]).toEqual({ role: "user", content: enhancementUserMessage("dark mode") });
    expect(calls[1].auth).toBe("Bearer gw-secret-key");
  });

  test("an empty answer keeps the draft; a failure names kind and host, never the key", async () => {
    const t = await withGateway();
    vi.stubGlobal("fetch", vi.fn(async () => ok("")));
    expect(await t.action(api.llmProvidersNode.enhancePrompt, { token: TOKEN, prompt: "keep me" })).toBe("keep me");
    vi.stubGlobal("fetch", vi.fn(async () => notFound()));
    const error = await t.action(api.llmProvidersNode.enhancePrompt, { token: TOKEN, prompt: "x" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("openai-compatible @ 10.0.0.5:8080");
    expect((error as Error).message).not.toContain("gw-secret-key");
  });

  test("requires the service token", async () => {
    const t = await withGateway();
    await expect(t.action(api.llmProvidersNode.enhancePrompt, { token: "nope", prompt: "x" })).rejects.toThrow(/authentication/);
  });
});

describe("Suggest fix (runSuggestion) in the Node runtime", () => {
  test("reaches a /v1-less gateway through the endpoint helper and stores the diff", async () => {
    const t = await withGateway();
    const { taskId, agentId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const agentId = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", systemPrompt: "Build UI." });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "failed", errorMessage: "typecheck failed" });
      await ctx.db.insert("subtasks", {
        taskId, projectId, key: "impl", title: "Impl", description: "d", kind: "code_change", capability: "frontend-development",
        dependencies: [], order: 1, status: "failed", attempts: 1, assignedAgentId: agentId, assignedAgentName: "Frontend",
      });
      await ctx.db.insert("taskEvents", { taskId, projectId, type: "subtask.failed", subtaskKey: "impl", payload: { error: "typecheck failed" }, level: "error" });
      return { taskId, agentId };
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return String(url).endsWith("/v1/chat/completions")
          ? ok(JSON.stringify({ targetId: agentId, rationale: "Typecheck first.", edits: [{ find: "Build UI.", replace: "Build UI. Run the typecheck." }] }))
          : notFound();
      })
    );
    const suggestionId = await t.mutation(api.improve.requestSuggestion, { taskId });
    await t.action(internal.improveNode.runSuggestion, { suggestionId });
    const row = await t.run((ctx) => ctx.db.get(suggestionId));
    expect(row).toMatchObject({ status: "ready", targetKind: "agent_prompt", model: "qwen" });
    expect(row?.diff).toContain("+Build UI. Run the typecheck.");
    expect(urls).toContain("http://10.0.0.5:8080/v1/chat/completions");
  });
});
