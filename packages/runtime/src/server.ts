import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: path.join(repoRoot, ".env") });

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { openLocalDatabase } from "./db";
import { registerModules } from "./runtime/registry";
import { LocalExecutor } from "./runtime/executor";
import { handleWebApiRoute, loadWebApiRoutes } from "./http/webApi";

const PORT = Number(process.env.LOCAL_BACKEND_PORT ?? 8787);
const HOST = process.env.LOCAL_BACKEND_HOST ?? "127.0.0.1";

function tokenMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request: http.IncomingMessage, limit = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(payload);
}

async function main(): Promise<void> {
  const db = openLocalDatabase();
  const bundled = await import("../dist/functions.mjs");
  registerModules(bundled.modules as Record<string, unknown>);
  const executor = new LocalExecutor(db);
  await loadWebApiRoutes();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
      if (await handleWebApiRoute(request, response, url)) return;
      if (request.method === "OPTIONS") {
        send(response, 204, null);
        return;
      }
      if (request.method === "GET" && url.pathname === "/local/health") {
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/local/version") {
        send(response, 200, { version: db.version() });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/local/storage/")) {
        const id = decodeURIComponent(url.pathname.slice("/local/storage/".length));
        const body = executor.context("internalQuery").storage.read(id);
        if (!body) {
          send(response, 404, { error: "not found" });
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(body);
        return;
      }
      if (request.method === "POST" && url.pathname === "/local/storage/upload") {
        const id = url.searchParams.get("id");
        if (!id) {
          send(response, 400, { error: "missing id" });
          return;
        }
        executor.context("internalMutation").storage.store(id, await readBody(request));
        send(response, 200, { ok: true });
        return;
      }
      const match = url.pathname.match(/^\/local\/(query|mutation|action)$/);
      if (request.method === "POST" && match) {
        const body = JSON.parse((await readBody(request)).toString("utf8")) as {
          path?: string;
          args?: Record<string, unknown>;
          workerToken?: string;
        };
        if (!body.path) {
          send(response, 400, { error: "missing path" });
          return;
        }
        if (body.path.startsWith("worker:") || body.path.startsWith("skillLibrary:") || body.path.startsWith("systemLines:")) {
          const expected = process.env.FHARA_SERVICE_TOKEN ?? "";
          const candidate = body.workerToken ?? (body.args as Record<string, unknown> | undefined)?.workerToken;
          if (!expected || typeof candidate !== "string" || !tokenMatches(candidate, expected)) {
            send(response, 401, { error: "invalid service token" });
            return;
          }
        }
        const result = await executor.execute(body.path, body.args ?? {});
        send(response, 200, { value: result ?? null, version: db.version() });
        return;
      }
      send(response, 404, { error: "not found" });
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[local] backend listening on http://${HOST}:${PORT} (db: ${db.filePath})`);
  });

  const timer = setInterval(() => {
    try {
      executor.runDueJobs();
    } catch (error) {
      console.error("[local] job sweep failed:", error);
    }
  }, 250);
  timer.unref();

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
