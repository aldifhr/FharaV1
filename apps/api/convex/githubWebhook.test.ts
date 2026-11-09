/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { encryptApiKey } from "./lib/llmCrypto";
import { signGithubPayload, verifyGithubSignature } from "./lib/githubWebhook";

/**
 * GitHub webhook guard: HMAC-SHA256 over the raw body (x-hub-signature-256),
 * fail closed without a secret, per-integration secret first and
 * GITHUB_WEBHOOK_SECRET second, and replay dedupe on x-github-delivery.
 */

const modules = import.meta.glob("./**/*.ts");
// 32 zero bytes, base64 — test-only key.
const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SECRET = "integration-secret-0123456789";
const ENV_SECRET = "env-fallback-secret";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["PROVIDER_ENCRYPTION_KEY", "GITHUB_WEBHOOK_SECRET"]) saved[key] = process.env[key];
  process.env.PROVIDER_ENCRYPTION_KEY = TEST_KEY;
  delete process.env.GITHUB_WEBHOOK_SECRET;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function seed(t: ReturnType<typeof convexTest>, opts: { secret?: string } = {}) {
  const ciphertext = opts.secret ? await encryptApiKey(opts.secret) : undefined;
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const integrationId = await ctx.db.insert("integrations", {
      projectId,
      type: "github",
      name: "GitHub",
      githubOwner: "acme",
      githubRepo: "app",
      status: "active",
      createdAt: 1,
      ...(ciphertext ? { webhookSecret: ciphertext, webhookSecretSetAt: 1 } : {}),
    });
    return { projectId, integrationId };
  });
}

const PAYLOAD = JSON.stringify({ action: "opened", repository: { full_name: "acme/app" }, issue: { number: 7 } });

async function deliver(
  t: ReturnType<typeof convexTest>,
  path: string,
  opts: { body?: string; signature?: string | null; secret?: string; delivery?: string; event?: string } = {}
) {
  const body = opts.body ?? PAYLOAD;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event ?? "issues",
    "x-github-delivery": opts.delivery ?? "delivery-1",
  };
  const signature =
    opts.signature === undefined ? await signGithubPayload(opts.secret ?? SECRET, PAYLOAD) : opts.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return await t.fetch(path, { method: "POST", headers, body });
}

async function eventCount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => (await ctx.db.query("integrationEvents").collect()).length);
}

describe("verifyGithubSignature", () => {
  test("accepts GitHub's documented test vector", async () => {
    // https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
    const res = await verifyGithubSignature(
      "It's a Secret to Everybody",
      "Hello, World!",
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
    );
    expect(res).toEqual({ ok: true });
  });

  test("rejects malformed headers without throwing", async () => {
    expect(await verifyGithubSignature("s", "b", "sha1=abc")).toEqual({ ok: false, reason: "malformed_signature" });
    expect(await verifyGithubSignature("s", "b", "sha256=zz")).toEqual({ ok: false, reason: "malformed_signature" });
    expect(await verifyGithubSignature("", "b", "sha256=00")).toEqual({ ok: false, reason: "no_secret" });
  });
});

describe("POST /integrations/github/webhook/<integrationId>", () => {
  test("a valid signature passes and the delivery is recorded", async () => {
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t, { secret: SECRET });
    const res = await deliver(t, `/integrations/github/webhook/${integrationId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await eventCount(t)).toBe(1);
  });

  test("a tampered body fails with 401", async () => {
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t, { secret: SECRET });
    const tampered = PAYLOAD.replace('"opened"', '"closed"');
    const res = await deliver(t, `/integrations/github/webhook/${integrationId}`, { body: tampered });
    expect(res.status).toBe(401);
    expect(await eventCount(t)).toBe(0);
  });

  test("a missing signature header fails with 401", async () => {
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t, { secret: SECRET });
    const res = await deliver(t, `/integrations/github/webhook/${integrationId}`, { signature: null });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason?: string }).reason).toBe("missing_signature");
  });

  test("no secret configured fails closed with 401", async () => {
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t);
    const res = await deliver(t, `/integrations/github/webhook/${integrationId}`);
    expect(res.status).toBe(401);
    expect(await eventCount(t)).toBe(0);
  });

  test("a duplicate delivery id is acknowledged and ignored", async () => {
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t, { secret: SECRET });
    const first = await deliver(t, `/integrations/github/webhook/${integrationId}`, { delivery: "dup-1" });
    expect(await first.json()).toEqual({ ok: true });
    const again = await deliver(t, `/integrations/github/webhook/${integrationId}`, { delivery: "dup-1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(await eventCount(t)).toBe(1);
  });

  test("falls back to GITHUB_WEBHOOK_SECRET when the integration has none", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = ENV_SECRET;
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t);
    const ok = await deliver(t, `/integrations/github/webhook/${integrationId}`, { secret: ENV_SECRET });
    expect(ok.status).toBe(200);
    // The per-integration secret wins when both exist: the env secret no longer verifies.
    const t2 = convexTest(schema, modules);
    const seeded = await seed(t2, { secret: SECRET });
    const wrong = await deliver(t2, `/integrations/github/webhook/${seeded.integrationId}`, { secret: ENV_SECRET });
    expect(wrong.status).toBe(401);
  });

  test("an unknown integration id answers 401 like a bad signature", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = ENV_SECRET;
    const t = convexTest(schema, modules);
    const res = await deliver(t, `/integrations/github/webhook/not-an-id`, { secret: ENV_SECRET });
    expect(res.status).toBe(401);
  });

  test("a verified delivery without x-github-event is a 400", async () => {
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t, { secret: SECRET });
    const body = PAYLOAD;
    const res = await t.fetch(`/integrations/github/webhook/${integrationId}`, {
      method: "POST",
      headers: { "x-hub-signature-256": await signGithubPayload(SECRET, body), "x-github-delivery": "d" },
      body,
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /integrations/github/webhook (env secret)", () => {
  test("verifies with the env secret and resolves the integration from the repository", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = ENV_SECRET;
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await deliver(t, "/integrations/github/webhook", { secret: ENV_SECRET });
    expect(res.status).toBe(200);
    expect(await eventCount(t)).toBe(1);
  });

  test("without any secret the bare route is 401", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await deliver(t, "/integrations/github/webhook");
    expect(res.status).toBe(401);
  });
});

describe("webhook setup query", () => {
  test("never returns the secret, only whether it is set", async () => {
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t, { secret: SECRET });
    const setup = await t.query(api.integrations.getWebhookSetup, { integrationId });
    expect(setup?.hasSecret).toBe(true);
    expect(JSON.stringify(setup)).not.toContain(SECRET);
    const listed = await t.run(async (ctx) => await ctx.db.get(integrationId));
    expect(listed?.webhookSecret?.startsWith("v1:")).toBe(true);
  });

  test("generateWebhookSecret returns the plaintext once and stores only ciphertext", async () => {
    const t = convexTest(schema, modules);
    const { integrationId } = await seed(t);
    const { secret } = await t.action(api.integrations.generateWebhookSecret, { integrationId });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const row = await t.run(async (ctx) => await ctx.db.get(integrationId));
    expect(row?.webhookSecret).not.toContain(secret);
    const res = await deliver(t, `/integrations/github/webhook/${integrationId}`, { secret });
    expect(res.status).toBe(200);
  });
});
