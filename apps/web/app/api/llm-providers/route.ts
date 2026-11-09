import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/api/convex/_generated/api";
import { rejectUnsafeRequest } from "@/lib/apiGuard";
import { isHttpUrl, pickFields, readJsonObject } from "@/lib/proxyArgs";

/**
 * Server-side admin route for LLM provider writes and model discovery.
 *
 * The provider mutations/actions in Convex require the service token
 * (see apps/api/convex/llmProviders.ts). The token must never reach the
 * browser bundle, so the Settings UI calls this route instead; the route
 * reads CONVEX_SERVICE_TOKEN from the web server's own environment and
 * injects it into the Convex call. If the token is not configured on the
 * server, provider writes fail closed with a clear error.
 *
 * Release audit P0-3/P0-4: the route only answers same-origin requests on
 * an allowed Host (lib/requestGuard.ts), and each op forwards a fixed set
 * of fields; nothing else in the body travels next to the token. The
 * backend additionally refuses platform-secret `apiKeyEnv` names and sends
 * a stored key only to the connection's stored baseUrl.
 */
const PROVIDER_FIELDS = [
  "name",
  "provider",
  "model",
  "baseUrl",
  "apiKeyEnv",
  "apiKey",
  "priority",
  "weight",
  "modelPatterns",
  "isEnabled",
] as const;
const MODEL_FIELDS = [
  "modelId",
  "displayName",
  "contextWindow",
  "supportsTools",
  "supportsReasoning",
  "inputPricePer1k",
  "outputPricePer1k",
  "isAvailable",
] as const;

const OP_FIELDS: Record<string, readonly string[]> = {
  create: PROVIDER_FIELDS,
  update: ["id", ...PROVIDER_FIELDS],
  remove: ["id"],
  fetchModels: ["baseUrl", "providerId", "apiKey"],
  createModel: ["providerId", ...MODEL_FIELDS],
  updateModel: ["id", ...MODEL_FIELDS],
  removeModel: ["id"],
  probeModel: ["providerId", "modelId", "projectId"],
};

export async function POST(request: NextRequest) {
  const rejected = rejectUnsafeRequest(request);
  if (rejected) return rejected;

  const token = process.env.CONVEX_SERVICE_TOKEN;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!token) {
    return NextResponse.json(
      {
        error:
          "CONVEX_SERVICE_TOKEN is not configured on the web server; provider writes are disabled.",
      },
      { status: 500 }
    );
  }
  if (!convexUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_CONVEX_URL is not configured on the web server." },
      { status: 500 }
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const op = typeof body.op === "string" ? body.op : "";
  const fields = OP_FIELDS[op];
  if (!fields) {
    return NextResponse.json({ error: `Unknown op: ${op.slice(0, 40)}` }, { status: 400 });
  }
  const payload = pickFields(body, fields);
  if (payload.baseUrl !== undefined && !isHttpUrl(payload.baseUrl)) {
    return NextResponse.json({ error: "Base URL must be an http(s) URL" }, { status: 400 });
  }

  const client = new ConvexHttpClient(convexUrl);
  try {
    // Convex validators enforce the argument types at runtime; the field
    // names were fixed above, so TS only loses the per-field types here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = { ...payload, token } as any;
    switch (op) {
      case "create": {
        const id = await client.mutation(api.llmProviders.create, callArgs);
        return NextResponse.json({ id });
      }
      case "update": {
        await client.mutation(api.llmProviders.updateProvider, callArgs);
        return NextResponse.json({ ok: true });
      }
      case "remove": {
        await client.mutation(api.llmProviders.remove, callArgs);
        return NextResponse.json({ ok: true });
      }
      case "fetchModels": {
        const models = await client.action(api.llmProviders.fetchModels, callArgs);
        return NextResponse.json({ models });
      }
      // Model Registry operations (Phase 2) — same token gate, backend-side.
      case "createModel": {
        const id = await client.mutation(api.llmModels.create, callArgs);
        return NextResponse.json({ id });
      }
      case "updateModel": {
        await client.mutation(api.llmModels.update, callArgs);
        return NextResponse.json({ ok: true });
      }
      case "removeModel": {
        await client.mutation(api.llmModels.remove, callArgs);
        return NextResponse.json({ ok: true });
      }
      // Plan 027: manual capability probe (two tiny calls, backend-side key).
      case "probeModel": {
        const probe = await client.action(api.modelCapabilities.probe, callArgs);
        return NextResponse.json({ probe });
      }
      default:
        return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Provider operation failed",
      },
      { status: 400 }
    );
  }
}
