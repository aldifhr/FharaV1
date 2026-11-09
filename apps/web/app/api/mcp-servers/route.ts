import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/api/convex/_generated/api";

/**
 * Server-side route for MCP server config writes (Plan 007 Phase 1, and the
 * /integrations page: create / update / toggle / test / remove).
 *
 * The worker actions in Convex require the service token
 * (see apps/api/convex/worker.ts — addMcpServer / removeMcpServer).
 * The token must never reach the browser bundle, so the MCP page calls
 * this route instead; the route reads CONVEX_SERVICE_TOKEN from the web
 * server's own environment and injects it into the Convex call.
 * If the token is not configured, writes fail closed with a clear error.
 */
export async function POST(request: NextRequest) {
  const token = process.env.CONVEX_SERVICE_TOKEN;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!token) {
    return NextResponse.json(
      {
        error:
          "CONVEX_SERVICE_TOKEN is not configured on the web server; MCP server writes are disabled.",
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

  let body: { action?: unknown } & Record<string, any>;
  try {
    body = (await request.json()) as { action?: unknown } & Record<string, any>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { action, ...payload } = body;
  if (!action || typeof action !== "string") {
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }

  const client = new ConvexHttpClient(convexUrl);
  try {
    // Proxy route: Convex validators enforce the real args at runtime, so
    // args pass through unchecked here (TS cannot prove them from an open
    // object). `workerToken` is the service token worker.ts actions expect.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = { ...payload, workerToken: token } as any;
    switch (action) {
      case "add": {
        await client.action(api.worker.addMcpServer, callArgs);
        return NextResponse.json({ ok: true });
      }
      case "remove": {
        await client.action(api.worker.removeMcpServer, callArgs);
        return NextResponse.json({ ok: true });
      }
      // Integrations page. Secret env values pass through this server route
      // to Convex, which encrypts them before storing; they are never
      // logged here and never returned.
      case "create": {
        const serverId = await client.action(api.worker.createMcpServerFromPreset, callArgs);
        return NextResponse.json({ ok: true, serverId });
      }
      case "update": {
        await client.action(api.worker.updateMcpServer, callArgs);
        return NextResponse.json({ ok: true });
      }
      case "toggle": {
        await client.action(api.worker.setMcpServerEnabled, callArgs);
        return NextResponse.json({ ok: true });
      }
      case "test": {
        const result = await client.action(api.worker.requestMcpServerTest, callArgs);
        return NextResponse.json({ ok: true, ...result });
      }
      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "MCP server operation failed",
      },
      { status: 400 }
    );
  }
}
