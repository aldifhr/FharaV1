/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import * as integrationsModule from "./integrations";
import schema from "./schema";

/**
 * Phase 6 backend harness (convex-test) — minimal, invariant-focused.
 *
 * Covers the three backend invariants the worker suite cannot reach
 * (PLAN §C "Security" rows, previously untestable for lack of a harness):
 *  (a) the write-layer terminal guard: a late worker must not overwrite
 *      a task that already reached a terminal status;
 *  (b) provider mutations are gated by the service token;
 *  (c) getRunContext never forwards credential material to the worker:
 *      legacy agent key fields are stripped, and a provider's plaintext
 *      key column never crosses — only the ciphertext does.
 */

const modules = import.meta.glob("./**/*.ts");

const SERVICE_TOKEN = "phase6-harness-token";

describe("completeTask terminal guard (Phase 4 hardening)", () => {
  test("a late completion cannot overwrite a terminal task", async () => {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        name: "P",
        workspacePath: "/tmp/p",
      });
      return await ctx.db.insert("tasks", {
        projectId,
        title: "T",
        command: "do the thing",
        status: "done",
        completedAt: 111,
        errorMessage: "original outcome",
      });
    });

    const res = await t.mutation(internal.orchestration.completeTask, {
      taskId,
      status: "failed",
      errorMessage: "late worker overwrote this",
    });
    expect(res.applied).toBe(false);
    if (!res.applied) {
      expect(res.reason).toBe("task_already_terminal");
      expect(res.status).toBe("done");
    }

    const after = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(after?.status).toBe("done");
    expect(after?.errorMessage).toBe("original outcome");
    expect(after?.completedAt).toBe(111);
  });

  test("a non-terminal task still completes normally", async () => {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        name: "P",
        workspacePath: "/tmp/p",
      });
      return await ctx.db.insert("tasks", {
        projectId,
        title: "T",
        command: "do the thing",
        status: "running",
      });
    });

    const res = await t.mutation(internal.orchestration.completeTask, {
      taskId,
      status: "done",
    });
    expect(res.applied).toBe(true);

    const after = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(after?.status).toBe("done");
    expect(after?.completedAt).toBeTypeOf("number");
  });
});

describe("provider mutation token gate (Phase 1)", () => {
  test("create rejects a wrong token and accepts the configured one", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    const t = convexTest(schema, modules);
    const args = {
      name: "Conn",
      provider: "openai-compatible",
      model: "model-1",
      baseUrl: "http://127.0.0.1:9",
      apiKeyEnv: "SOME_PROVIDER_KEY",
      priority: 1,
    };

    await expect(
      t.mutation(api.llmProviders.create, { ...args, token: "wrong-token" })
    ).rejects.toThrow("Worker authentication required");

    const id = await t.mutation(api.llmProviders.create, {
      ...args,
      token: SERVICE_TOKEN,
    });
    expect(id).toBeTruthy();

    // The accepted write seeded the model registry (Phase 2 behavior).
    const models = await t.run(async (ctx) =>
      ctx.db.query("llmModels").collect()
    );
    expect(models).toHaveLength(1);
    expect(models[0].modelId).toBe("model-1");
  });
});

describe("integrations token store is internal-only (Phase 6 fix)", () => {
  test("upsertGithubIntegration is registered internal and works via internal calls", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) =>
      ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" })
    );
    const args = {
      projectId,
      accessToken: "gho_test_token",
      refreshToken: undefined,
      expiresIn: undefined,
    };

    // This mutation stores a GitHub OAuth token, yet before Phase 6 it
    // was declared a PUBLIC mutation while its only call site used the
    // internal reference — an unauthenticated credential-write hole, and
    // the reason `convex dev`'s deploy typecheck failed (TS2551).
    // Function references are untyped path proxies at runtime (the
    // generated api.js exports anyApi for both `api` and `internal`), so
    // visibility is asserted where it actually lives: the registration
    // marker the Convex builder stamps on internal functions, plus the
    // generated public types omitting it (covered by the api typecheck).
    const registration = integrationsModule.upsertGithubIntegration as {
      isInternal?: boolean;
    };
    expect(registration.isInternal).toBe(true);

    const id = await t.mutation(
      internal.integrations.upsertGithubIntegration,
      args
    );
    expect(id).toBeTruthy();
    const stored = await t.run(async (ctx) => await ctx.db.get(id));
    expect(stored?.accessToken).toBe("gho_test_token");
  });
});

describe("getRunContext credential hygiene (Phase 1 + 2)", () => {
  test("legacy agent keys are stripped; provider plaintext never crosses", async () => {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("agents", {
        name: "A",
        role: "executor",
        status: "idle",
        llmApiKey: "sk-legacy-plaintext",
        llmApiKeyEnv: "LEGACY_ENV_NAME",
        llmProvider: "openai",
        llmModel: "legacy-model",
        llmBaseUrl: "https://legacy.example",
      });
      const projectId = await ctx.db.insert("projects", {
        name: "P",
        workspacePath: "/tmp/p",
        agentIds: [agentId],
      });
      // A provider row that still carries a legacy plaintext column value
      // alongside its ciphertext (pre-migration shape): the pool payload
      // must forward ONLY the ciphertext.
      await ctx.db.insert("llmProviders", {
        name: "Conn",
        provider: "openai-compatible",
        model: "model-1",
        baseUrl: "http://127.0.0.1:9",
        apiKeyEnv: "SOME_PROVIDER_KEY",
        apiKey: "sk-provider-plaintext",
        apiKeyCiphertext: "v1:aaaa:bbbb:cccc",
        priority: 1,
        weight: 100,
        isEnabled: true,
        createdAt: 1,
      });
      return await ctx.db.insert("tasks", {
        projectId,
        title: "T",
        command: "do the thing",
        status: "queued",
        assignedAgentIds: [agentId],
      });
    });

    const result = await t.query(internal.orchestration.getRunContext, {
      taskId,
    });
    expect(result).not.toBeNull();

    const agent = result!.agents[0];
    expect(agent).toBeDefined();
    for (const field of [
      "llmApiKey",
      "llmApiKeyEnv",
      "llmProvider",
      "llmModel",
      "llmBaseUrl",
    ]) {
      expect(field in agent).toBe(false);
    }

    expect(result!.llmProviders).toHaveLength(1);
    const conn = result!.llmProviders[0];
    expect("apiKey" in conn).toBe(false);
    expect(conn.apiKeyCiphertext).toBe("v1:aaaa:bbbb:cccc");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-legacy-plaintext");
    expect(serialized).not.toContain("sk-provider-plaintext");
  });
});
