/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const providerId = await t.run((ctx) =>
    ctx.db.insert("llmProviders", {
      name: "P",
      provider: "openai-compatible",
      model: "m",
      baseUrl: "https://p.example",
      apiKeyEnv: "LLM_API_KEY",
      priority: 1,
      weight: 100,
      createdAt: Date.now(),
    })
  );
  return { t, providerId };
}

describe("provider health circuit recovery", () => {
  test("an omitted circuitOpenUntil clears the stale open timestamp", async () => {
    const { t, providerId } = await setup();
    const report = (circuitOpenUntil?: number) =>
      t.mutation(internal.orchestration.reportProviderHealth, {
        providerId,
        providerName: "P",
        consecutiveTransientFailures: 1,
        totalSuccesses: 0,
        totalTransientFailures: 1,
        ...(circuitOpenUntil !== undefined ? { circuitOpenUntil } : {}),
      });

    await report(Date.now() + 60_000);
    const during = await t.run((ctx) =>
      ctx.db.query("providerHealth").withIndex("by_provider", (q) => q.eq("providerId", providerId)).first()
    );
    expect(during?.circuitOpenUntil).toBeTypeOf("number");

    await report();
    const after = await t.run((ctx) =>
      ctx.db.query("providerHealth").withIndex("by_provider", (q) => q.eq("providerId", providerId)).first()
    );
    expect(after?.circuitOpenUntil).toBeUndefined();
  });
});
