import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const webApiDir = path.join(repoRoot, "apps", "web", "app", "api");

const routeFiles = [
  "about",
  "integrations/github/callback",
  "llm-providers",
  "magic-prompt",
  "mcp-servers",
  "open-in",
  "project-files",
  "random-name",
];

type Handler = (request: any) => Promise<Response> | Response;
const routes = new Map<string, Partial<Record<"GET" | "POST", Handler>>>();

export async function loadWebApiRoutes(): Promise<void> {
  for (const name of routeFiles) {
    try {
      const file = path.join(webApiDir, name, "route.ts");
      const module = await import(pathToFileURL(file).href);
      routes.set(`/api/${name}`, {
        GET: typeof module.GET === "function" ? module.GET : undefined,
        POST: typeof module.POST === "function" ? module.POST : undefined,
      });
    } catch (error) {
      console.warn(`[local] could not load web API route /api/${name}:`, error);
    }
  }
}

export async function handleWebApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const route = routes.get(url.pathname);
  if (!route) return false;
  const handler = route[request.method as "GET" | "POST"];
  if (!handler) {
    response.writeHead(405).end("method not allowed");
    return true;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request as any) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(", ");
  }
  const { NextRequest } = await import(
    pathToFileURL(path.join(repoRoot, "apps", "web", "lib", "serverCompat.ts")).href
  );
  const incoming = new NextRequest(url.toString(), {
    method: request.method,
    headers,
    body: body.length > 0 && request.method !== "GET" ? body : undefined,
  });
  try {
    const result = await handler(incoming);
    response.writeHead(result.status, Object.fromEntries(result.headers as any));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}
