import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/api/convex/_generated/api";

/**
 * Server-side admin route for LLM provider writes and model discovery.
 *
 * The provider mutations/actions in Convex require the service token
 * (see apps/api/convex/llmProviders.ts). The token must never reach the
 * browser bundle, so the Settings UI calls this route instead; the route
 * reads CONVEX_SERVICE_TOKEN from the web server's own environment and
 * injects it into the Convex call. If the token is not configured on the
 * server, provider writes fail closed with a clear error.
 */
export async function POST(request: NextRequest) {
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

  let body: { op?: unknown; [key: string]: unknown };
  try {
    body = (await request.json()) as { op?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { op, ...payload } = body;

  const client = new ConvexHttpClient(convexUrl);
  try {
    switch (op) {
      case "create": {
        const id = await client.mutation(api.llmProviders.create, {
          ...payload,
          token,
        });
        return NextResponse.json({ id });
      }
      case "update": {
        await client.mutation(api.llmProviders.updateProvider, {
          ...payload,
          token,
        });
        return NextResponse.json({ ok: true });
      }
      case "remove": {
        await client.mutation(api.llmProviders.remove, { ...payload, token });
        return NextResponse.json({ ok: true });
      }
      case "fetchModels": {
        const models = await client.action(api.llmProviders.fetchModels, {
          ...payload,
          token,
        });
        return NextResponse.json({ models });
      }
      // Model Registry operations (Phase 2) — same token gate, backend-side.
      case "createModel": {
        const id = await client.mutation(api.llmModels.create, {
          ...payload,
          token,
        });
        return NextResponse.json({ id });
      }
      case "updateModel": {
        await client.mutation(api.llmModels.update, { ...payload, token });
        return NextResponse.json({ ok: true });
      }
      case "removeModel": {
        await client.mutation(api.llmModels.remove, { ...payload, token });
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json(
          { error: `Unknown op: ${String(op)}` },
          { status: 400 }
        );
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
