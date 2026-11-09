/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { isSafeApiKeyEnv } from "./lib/apiKeyEnv";

/**
 * Release audit P0-3: a provider row must not be able to name a platform
 * secret as its key variable, and a stored key must only ever be sent to
 * the connection's stored baseUrl.
 */
const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "p0-3-harness-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiKeyEnv allowlist", () => {
  test("provider key names pass, platform secrets do not", () => {
    for (const name of ["LLM_API_KEY", "OPENAI_API_KEY", "OPENROUTER_KEY", "HF_TOKEN", "SOME_PROVIDER_KEY", "K"]) {
      expect(isSafeApiKeyEnv(name), name).toBe(true);
    }
    for (const name of [
      "CONVEX_SERVICE_TOKEN",
      "PROVIDER_ENCRYPTION_KEY",
      "PROVIDER_ENCRYPTION_KEY_OLD",
      "CONVEX_DEPLOY_KEY",
      "GITHUB_CLIENT_SECRET",
      "GITHUB_TOKEN",
      "OAUTH_STATE_SECRET",
      "AWS_SECRET_ACCESS_KEY",
      "JWT_PRIVATE_KEY",
      "lower_case",
      "",
    ]) {
      expect(isSafeApiKeyEnv(name), name).toBe(false);
    }
  });

  test("create and updateProvider refuse a platform-secret apiKeyEnv", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    const t = convexTest(schema, modules);
    const base = {
      token: SERVICE_TOKEN,
      name: "Conn",
      provider: "openai-compatible",
      model: "m",
      baseUrl: "https://provider.example/v1",
      priority: 1,
    };
    await expect(
      t.mutation(api.llmProviders.create, { ...base, apiKeyEnv: "CONVEX_SERVICE_TOKEN" })
    ).rejects.toThrow(/not allowed/);
    const id = await t.mutation(api.llmProviders.create, { ...base, apiKeyEnv: "LLM_API_KEY" });
    await expect(
      t.mutation(api.llmProviders.updateProvider, { token: SERVICE_TOKEN, id, apiKeyEnv: "PROVIDER_ENCRYPTION_KEY" })
    ).rejects.toThrow(/not allowed/);
  });
});

describe("fetchModels with a saved provider", () => {
  test("ignores the caller's baseUrl and uses the stored one", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.P03_TEST_API_KEY = "sk-stored";
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), auth: init?.headers?.authorization ?? null });
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    });
    const t = convexTest(schema, modules);
    const providerId = await t.run(async (ctx) =>
      ctx.db.insert("llmProviders", {
        name: "Stored",
        provider: "openai-compatible",
        model: "m1",
        baseUrl: "https://stored.example/v1",
        apiKeyEnv: "P03_TEST_API_KEY",
        priority: 1,
        weight: 100,
        isEnabled: true,
        createdAt: 1,
      })
    );
    const models = await t.action(api.llmProviders.fetchModels, {
      token: SERVICE_TOKEN,
      baseUrl: "https://attacker.example",
      providerId,
    });
    expect(models).toEqual(["m1"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://stored.example/v1/models");
    expect(seen[0].auth).toBe("Bearer sk-stored");
  });

  test("a legacy row naming a platform secret never sends it", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const providerId = await t.run(async (ctx) =>
      ctx.db.insert("llmProviders", {
        name: "Legacy",
        provider: "openai-compatible",
        model: "m1",
        baseUrl: "https://stored.example/v1",
        apiKeyEnv: "CONVEX_SERVICE_TOKEN",
        priority: 1,
        weight: 100,
        isEnabled: true,
        createdAt: 1,
      })
    );
    await expect(
      t.action(api.llmProviders.fetchModels, { token: SERVICE_TOKEN, baseUrl: "https://x.example", providerId })
    ).rejects.toThrow(/API key is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
