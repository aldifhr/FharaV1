import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/api/convex/_generated/api";
import { isStrictSameOrigin, rejectUnsafeRequest } from "@/lib/apiGuard";
import { pickFields, readJsonObject } from "@/lib/proxyArgs";
import { setsLocalCommand } from "@/lib/mcpPolicy";
import { publicConvexUrl } from "@/lib/env.client";
import { serverEnv } from "@/lib/env.server";

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
 *
 * Release audit P0-3/P0-4:
 *  - same-origin requests on an allowed Host only (lib/requestGuard.ts);
 *  - each action forwards a fixed set of fields next to the token;
 *  - a server whose command line the caller chooses (type "local" via
 *    `add`, the `custom` preset with a local command, or an `update` that
 *    sets command/commandArgs/type local) is refused unless the operator
 *    sets FHARA_ALLOW_LOCAL_MCP=1, and even then only when the request
 *    carries an Origin header naming this server. The built-in presets
 *    (fixed commands) are unaffected.
 */
const EDITABLE_FIELDS = [
  "name",
  "fields",
  "env",
  "agentRoles",
  "toolAllowlist",
  "enabled",
  "autoConnect",
  "useGithubOAuth",
  "type",
  "command",
  "commandArgs",
  "url",
] as const;

const ACTION_FIELDS: Record<string, readonly string[]> = {
  add: ["projectId", "name", "type", "url", "command", "args", "enabled", "autoConnect", "transport", "allowedDirectories"],
  create: ["presetId", "projectId", ...EDITABLE_FIELDS],
  update: ["serverId", "projectId", "removeEnvKeys", ...EDITABLE_FIELDS],
  toggle: ["serverId", "enabled"],
  test: ["serverId"],
  remove: ["serverId"],
};

function localMcpAllowed(): boolean {
  return serverEnv("FHARA_ALLOW_LOCAL_MCP");
}

export async function POST(request: NextRequest) {
  const rejected = rejectUnsafeRequest(request);
  if (rejected) return rejected;

  const token = serverEnv("CONVEX_SERVICE_TOKEN");
  const convexUrl = publicConvexUrl();
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

  const body = await readJsonObject(request);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const fields = ACTION_FIELDS[action];
  if (!fields) {
    return NextResponse.json({ error: `Unknown action: ${action.slice(0, 40) || "(missing)"}` }, { status: 400 });
  }
  const payload = pickFields(body, fields);

  if (setsLocalCommand(action, payload)) {
    if (!localMcpAllowed()) {
      return NextResponse.json(
        {
          error:
            "Custom local (stdio) MCP commands are disabled on this server. Set FHARA_ALLOW_LOCAL_MCP=1 in .env and restart to allow them, or use a built-in preset or a remote server.",
        },
        { status: 403 }
      );
    }
    if (!isStrictSameOrigin(request)) {
      return NextResponse.json(
        { error: "Local MCP commands can only be added from the Fhara UI (same origin)." },
        { status: 403 }
      );
    }
  }

  const client = new ConvexHttpClient(convexUrl);
  try {
    // Convex validators enforce the argument types at runtime; the field
    // names were fixed above. `workerToken` is the service token worker.ts
    // actions expect.
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
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
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
