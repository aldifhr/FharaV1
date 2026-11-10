import type { WorkerApi } from "@/workerApi";
import { listOpencodeModels, nativeProviderCommand, type OpencodeModelCatalog } from "@/execution/nativeProvider";
import {
  detectOpencode,
  probeOpencode,
  setOpencodeDetection,
  type OpencodeDetection,
  type ProbeResult,
} from "@/execution/opencodeDetect";

/**
 * Plan 034: keep the backend's OpenCode model catalog fresh.
 *
 * The list of models the CLI can run lives on the worker machine. The worker
 * reads it (`opencode models`) and publishes it; the agent editor reads the
 * published copy. The worker only re-reads when it has to: the UI asked for a
 * refresh, it has never reported, or the last report is older than
 * `CATALOG_STALE_MS`.
 */

/**
 * How old a report may get before the worker re-reads the CLI. Plan 038:
 * the report also carries detection (installed / version / path), so a CLI
 * installed or removed while the worker runs shows up within ~5 min.
 */
export const CATALOG_STALE_MS = 5 * 60_000;

/** What the backend told us about our own catalog row. */
export interface CatalogState {
  hasCatalog: boolean;
  available: boolean;
  updatedAt: number;
  refreshRequestedAt: number;
  /** Plan 038: a pending Settings "Test" (0 = none) and its model. */
  testRequestedAt?: number;
  testModel?: string;
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
  api: Pick<WorkerApi, "getOpencodeModelState" | "reportOpencodeModels"> &
    Partial<Pick<WorkerApi, "reportOpencodeTest">>;
  workerId: string;
  hostname?: string;
  log: (...args: unknown[]) => void;
  /** Injected in tests; defaults to the real CLI call. */
  listModels?: () => Promise<OpencodeModelCatalog>;
  /** Injected in tests; defaults to the real detection. */
  detect?: () => Promise<OpencodeDetection>;
  /** Injected in tests; defaults to the real `opencode run` probe. */
  probe?: (model: string) => Promise<ProbeResult>;
}

/**
 * Read the CLI once and publish the result. The report is what clears a
 * pending refresh request, so it is sent even when the CLI failed (the UI
 * then shows why the list is unavailable).
 */
export async function refreshOpencodeCatalog(deps: CatalogDeps): Promise<OpencodeModelCatalog> {
  // Plan 038: detect first; a missing binary skips the listing (it would
  // only fail the same way) and the report says why.
  const detection = await (deps.detect ?? (() => detectOpencode()))();
  setOpencodeDetection(detection);
  const catalog: OpencodeModelCatalog = detection.installed
    ? await (deps.listModels ?? listOpencodeModels)()
    : { models: [], available: false, error: detection.error };
  await deps.api.reportOpencodeModels({
    workerId: deps.workerId,
    hostname: deps.hostname,
    models: catalog.models,
    available: catalog.available,
    error: catalog.error ?? detection.error,
    command: nativeProviderCommand(),
    installed: detection.installed,
    ...(detection.version ? { version: detection.version } : {}),
    ...(detection.path ? { path: detection.path } : {}),
  });
  return catalog;
}

/** Serve a pending Settings "Test": run the probe and store the result. */
export async function serveOpencodeTest(deps: CatalogDeps, model: string): Promise<ProbeResult> {
  const result = await (deps.probe ?? ((m: string) => probeOpencode({ model: m || undefined })))(model);
  await deps.api.reportOpencodeTest?.({
    workerId: deps.workerId,
    ok: result.ok,
    latencyMs: result.latencyMs,
    ...(result.model || model ? { model: result.model ?? model } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
  return result;
}

/**
 * One poll step: refresh when the backend says the catalog is missing, stale
 * or explicitly requested. Never throws — a failed poll is logged and the
 * next tick tries again.
 */
let polling = false;

export async function pollOpencodeCatalog(deps: CatalogDeps): Promise<boolean> {
  // A probe can take longer than the poll interval: one poll at a time, so
  // a pending Test never runs twice.
  if (polling) return false;
  polling = true;
  try {
    const state = await deps.api.getOpencodeModelState({ workerId: deps.workerId });
    let acted = false;
    if (shouldRefreshCatalog(state, Date.now())) {
      const catalog = await refreshOpencodeCatalog(deps);
      deps.log(
        `opencode catalog: ${catalog.models.length} model(s), available=${catalog.available}`
      );
      acted = true;
    }
    if ((state.testRequestedAt ?? 0) > 0) {
      const result = await serveOpencodeTest(deps, state.testModel ?? "");
      deps.log(`opencode test: ok=${result.ok} ${result.latencyMs} ms${result.error ? ` (${result.error})` : ""}`);
      acted = true;
    }
    return acted;
  } catch (error) {
    deps.log("opencode catalog poll failed:", error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    polling = false;
  }
}
