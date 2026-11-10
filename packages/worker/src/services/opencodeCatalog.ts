import type { WorkerApi } from "@/workerApi";
import { listOpencodeModels, nativeProviderCommand, type OpencodeModelCatalog } from "@/execution/nativeProvider";

/**
 * Plan 034: keep the backend's OpenCode model catalog fresh.
 *
 * The list of models the CLI can run lives on the worker machine. The worker
 * reads it (`opencode models`) and publishes it; the agent editor reads the
 * published copy. The worker only re-reads when it has to: the UI asked for a
 * refresh, it has never reported, or the last report is older than
 * `CATALOG_STALE_MS`.
 */

/** How old a report may get before the worker re-reads the CLI. */
export const CATALOG_STALE_MS = 10 * 60_000;

/** What the backend told us about our own catalog row. */
export interface CatalogState {
  hasCatalog: boolean;
  available: boolean;
  updatedAt: number;
  refreshRequestedAt: number;
}

/** True when the worker should read the CLI again. */
export function shouldRefreshCatalog(state: CatalogState, now: number): boolean {
  // A request that lands in the same millisecond as the last report is still
  // a request: `>=` keeps it from being swallowed by the report that follows.
  if (state.refreshRequestedAt > 0 && state.refreshRequestedAt >= state.updatedAt) return true;
  if (!state.hasCatalog) return true;
  return now - state.updatedAt >= CATALOG_STALE_MS;
}

export interface CatalogDeps {
  api: Pick<WorkerApi, "getOpencodeModelState" | "reportOpencodeModels">;
  workerId: string;
  hostname?: string;
  log: (...args: unknown[]) => void;
  /** Injected in tests; defaults to the real CLI call. */
  listModels?: () => Promise<OpencodeModelCatalog>;
}

/**
 * Read the CLI once and publish the result. The report is what clears a
 * pending refresh request, so it is sent even when the CLI failed (the UI
 * then shows why the list is unavailable).
 */
export async function refreshOpencodeCatalog(deps: CatalogDeps): Promise<OpencodeModelCatalog> {
  const catalog = await (deps.listModels ?? listOpencodeModels)();
  await deps.api.reportOpencodeModels({
    workerId: deps.workerId,
    hostname: deps.hostname,
    models: catalog.models,
    available: catalog.available,
    error: catalog.error,
    command: nativeProviderCommand(),
  });
  return catalog;
}

/**
 * One poll step: refresh when the backend says the catalog is missing, stale
 * or explicitly requested. Never throws — a failed poll is logged and the
 * next tick tries again.
 */
export async function pollOpencodeCatalog(deps: CatalogDeps): Promise<boolean> {
  try {
    const state = await deps.api.getOpencodeModelState({ workerId: deps.workerId });
    if (!shouldRefreshCatalog(state, Date.now())) return false;
    const catalog = await refreshOpencodeCatalog(deps);
    deps.log(
      `opencode catalog: ${catalog.models.length} model(s), available=${catalog.available}`
    );
    return true;
  } catch (error) {
    deps.log("opencode catalog poll failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}
