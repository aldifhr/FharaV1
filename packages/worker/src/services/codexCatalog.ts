import { spawn } from "node:child_process";
import os from "node:os";
import { buildChildEnv } from "@/api/functions/lib/childEnv";
import { codexCommand } from "@/execution/codexProvider";
import type { WorkerApi } from "@/workerApi";

export const CODEX_CATALOG_STALE_MS = 5 * 60_000;
const CODEX_CATALOG_TIMEOUT_MS = 20_000;
const MAX_MODELS = 500;

export interface CodexCatalogState {
  hasCatalog: boolean;
  updatedAt: number;
  refreshRequestedAt: number;
}

export interface CodexModelRow {
  id?: unknown;
  model?: unknown;
  hidden?: unknown;
}

/** Extract only selectable model ids; discard hidden, malformed, and duplicate rows. */
export function parseCodexModelRows(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as CodexModelRow;
    if (row.hidden === true) continue;
    const raw = typeof row.id === "string" ? row.id : row.model;
    if (typeof raw !== "string") continue;
    const id = raw.trim().slice(0, 120);
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_MODELS) break;
  }
  return ids;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "Codex model list timed out";
  return error instanceof Error && error.message === "codex_not_found"
    ? "Codex CLI is not available on this worker"
    : "Codex could not return its model list";
}

/** Query Codex app-server's account-aware model/list RPC; auth stays in Codex CLI. */
export async function listCodexModels(): Promise<{ models: string[]; available: boolean; error?: string }> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codexCommand(), ["app-server", "--listen", "stdio://"], {
        cwd: os.tmpdir(),
        env: buildChildEnv(),
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      resolve({ models: [], available: false, error: errorMessage(error) });
      return;
    }

    let buffer = "";
    let settled = false;
    let requestId = 0;
    let cursor: string | undefined;
    const ids = new Set<string>();
    const timer = setTimeout(() => finish({ models: [], available: false, error: "Codex model list timed out" }), CODEX_CATALOG_TIMEOUT_MS);
    const finish = (result: { models: string[]; available: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(result);
    };
    const write = (message: Record<string, unknown>) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish({ models: [], available: false, error: "Codex app-server connection closed" });
      }
    };
    const requestPage = () => {
      requestId += 1;
      write({ jsonrpc: "2.0", id: requestId, method: "model/list", params: { limit: 100, include_hidden: false, ...(cursor ? { cursor } : {}) } });
    };

    child.stdout?.setEncoding("utf8");
    child.stdin?.on("error", () => finish({ models: [], available: false, error: "Codex app-server connection closed" }));
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            finish({ models: [], available: false, error: "Codex app-server initialization failed" });
            return;
          }
          write({ jsonrpc: "2.0", method: "initialized" });
          requestPage();
          continue;
        }
        if (message.id !== requestId) continue;
        if (message.error) {
          finish({ models: [], available: false, error: "Codex model/list request failed" });
          return;
        }
        const result = message.result && typeof message.result === "object"
          ? message.result as Record<string, unknown>
          : {};
        for (const id of parseCodexModelRows(result.data)) ids.add(id);
        cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
        if (cursor && ids.size < MAX_MODELS) requestPage();
        else finish({ models: [...ids].slice(0, MAX_MODELS), available: true });
      }
    });
    child.on("error", (error) => finish({ models: [], available: false, error: errorMessage(error) }));
    child.on("close", (code) => {
      if (!settled) finish({ models: [], available: false, error: code === 0 ? "Codex closed before returning models" : "Codex app-server exited before returning models" });
    });
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "fhara", version: "1.0.0" }, capabilities: { experimentalApi: true } },
    });
  });
}

export function shouldRefreshCodexCatalog(state: CodexCatalogState, now: number): boolean {
  if (state.refreshRequestedAt > 0 && state.refreshRequestedAt >= state.updatedAt) return true;
  return !state.hasCatalog || now - state.updatedAt >= CODEX_CATALOG_STALE_MS;
}

type CodexCatalogApi = Pick<WorkerApi, "getCodexModelState" | "reportCodexModels">;
let polling = false;

export async function pollCodexCatalog(deps: {
  api: CodexCatalogApi;
  workerId: string;
  hostname?: string;
  log: (...args: unknown[]) => void;
  listModels?: typeof listCodexModels;
  now?: () => number;
}): Promise<boolean> {
  if (polling) return false;
  polling = true;
  try {
    const state = await deps.api.getCodexModelState({ workerId: deps.workerId });
    if (!shouldRefreshCodexCatalog(state, (deps.now ?? Date.now)())) return false;
    const catalog = await (deps.listModels ?? listCodexModels)();
    await deps.api.reportCodexModels({
      workerId: deps.workerId,
      hostname: deps.hostname,
      models: catalog.models,
      available: catalog.available,
      error: catalog.error,
    });
    deps.log(`codex catalog: ${catalog.models.length} model(s), available=${catalog.available}`);
    return true;
  } catch (error) {
    deps.log("codex catalog poll failed:", error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    polling = false;
  }
}
