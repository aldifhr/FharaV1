import type { SpawnImpl } from "@/execution/nativeProvider";

/** A SpawnImpl that resolves with a fixed process result. */
export function spawnReturning(result: { stdout?: string; stderr?: string; code?: number | null }): SpawnImpl {
  return async () => ({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code === undefined ? 0 : result.code });
}

/** A SpawnImpl that records every invocation and answers via `respond`. */
export function recordingSpawn(
  respond: (command: string, args: string[]) => { stdout?: string; stderr?: string; code?: number | null } = () => ({})
): SpawnImpl & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const impl = (async (command: string, args: string[]) => {
    calls.push({ command, args });
    const result = respond(command, args);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code === undefined ? 0 : result.code };
  }) as unknown as SpawnImpl & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}
