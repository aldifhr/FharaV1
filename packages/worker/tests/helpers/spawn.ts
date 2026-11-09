import type { SpawnImpl } from "@/execution/nativeProvider";

/** A SpawnImpl that resolves with a fixed process result. */
export function spawnReturning(result: { stdout?: string; stderr?: string; code?: number | null }): SpawnImpl {
  return async () => ({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code === undefined ? 0 : result.code });
}
