/// <reference types="vite/client" />
import { runtimeTest } from "@fhara/runtime/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "@fhara/runtime/api";
import schema from "./schema";
import { encryptApiKey } from "./lib/llmCrypto";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * Release audit P0-3 (plan 072): a stored key must only ever be sent to the
 * connection's stored baseUrl, and a connection with no stored key must fail
 * explicitly instead of reading a credential from the environment.
 */
const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "p0-3-harness-token";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PROVIDER_ENCRYPTION_KEY;
});

describe("fetchModels with a saved provider", () => {
  test("ignores the caller's baseUrl and uses the stored one", async () => {
    process.env.FHARA_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.PROVIDER_ENCRYPTION_KEY = TEST_KEY;
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), auth: init?.headers?.authorization ?? null });
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    });
    const t = runtimeTest(schema, modules);
    const providerId = await t.run(async (ctx) =>
      ctx.db.insert("llmProviders", {
        name: "Stored",
        provider: "openai-compatible",
        model: "m1",
        baseUrl: "https://stored.example/v1",
        apiKeyCiphertext: await encryptApiKey("sk-stored"),
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

  test("a connection with no stored key fails without calling out", async () => {
    process.env.FHARA_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.P03_TEST_API_KEY = "sk-must-not-be-used";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = runtimeTest(schema, modules);
    const providerId = await t.run(async (ctx) =>
      ctx.db.insert("llmProviders", {
        name: "Keyless",
        provider: "openai-compatible",
        model: "m1",
        baseUrl: "https://stored.example/v1",
        priority: 1,
        weight: 100,
        isEnabled: true,
        createdAt: 1,
      })
    );
    await expect(
      t.action(api.llmProviders.fetchModels, { token: SERVICE_TOKEN, baseUrl: "https://x.example", providerId })
    ).rejects.toThrow(/No API key is stored/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
