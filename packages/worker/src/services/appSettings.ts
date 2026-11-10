import type { WorkerApi } from "@/workerApi";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import { loadPolicy } from "@/orchestrator/policy";
import { setChildEnvOverrides, setSettingOverrides, settingEnv } from "@/api/convex/lib/appSettings";

/**
 * Settings modal → worker. The worker fetches the appSettings row on every
 * heartbeat and applies it:
 *  - knob overrides (lib/appSettings.ts) win over process.env for every
 *    reader that goes through settingEnv (policy, push guard, PR draft,
 *    QA browser, snapshots, git identity);
 *  - the policy object shared by new task runs is reloaded in place, so a
 *    changed knob applies to the next task without a restart (the
 *    worker-wide LLM gate and WORKER_CONCURRENCY stay as started);
 *  - the child env (Settings → Environments) reaches every spawned process
 *    through buildChildEnv;
 *  - the workspace root (WORKSPACE_ROOT) is updated on the shared deps.
 */

export interface AppSettingsTarget {
  policy: ExecutionPolicy;
  workspaceRoot: string;
}

export const DEFAULT_WORKSPACE_ROOT = "./workspaces";

export function effectiveWorkspaceRoot(): string {
  return settingEnv("WORKSPACE_ROOT")?.trim() || DEFAULT_WORKSPACE_ROOT;
}

let lastUpdatedAt = -1;

/** Apply one fetched settings payload. Returns whether anything changed. */
export function applyAppSettings(
  settings: { values: Record<string, string>; childEnv: Record<string, string>; updatedAt: number },
  target: AppSettingsTarget
): boolean {
  if (settings.updatedAt === lastUpdatedAt) return false;
  lastUpdatedAt = settings.updatedAt;
  setSettingOverrides(settings.values);
  setChildEnvOverrides(settings.childEnv);
  const next = loadPolicy();
  // Keep the started concurrency bounds: WORKER_CONCURRENCY and the
  // worker-wide LLM gate were sized from them at boot.
  const { maxConcurrency, maxConcurrentLLMCalls } = target.policy;
  Object.assign(target.policy, next, { maxConcurrency, maxConcurrentLLMCalls });
  target.workspaceRoot = effectiveWorkspaceRoot();
  return true;
}

/** Fetch and apply; never throws (a failed fetch keeps the last values). */
export async function syncAppSettings(
  api: Pick<WorkerApi, "getAppSettings">,
  target: AppSettingsTarget,
  log: (...args: unknown[]) => void
): Promise<void> {
  try {
    const settings = await api.getAppSettings();
    if (applyAppSettings(settings, target)) {
      const keys = Object.keys(settings.values);
      log(`settings applied${keys.length ? `: ${keys.join(", ")}` : " (no overrides)"}`);
    }
  } catch (error) {
    log("settings fetch failed:", error instanceof Error ? error.message : String(error));
  }
}

/** Test hook: forget the last applied version. */
export function resetAppSettingsForTest(): void {
  lastUpdatedAt = -1;
  setSettingOverrides({});
  setChildEnvOverrides({});
}
