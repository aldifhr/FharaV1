/**
 * Worker reader. Every packages/worker env read goes through here.
 *
 *   wenv("WORKER_LEASE_MS")                    process.env, parsed with the var's dialect
 *   wenv("ORCHESTRATOR_TASK_TIMEOUT_MS", settingEnv)   knob-aware: UI override, then process.env
 *   wenv("WORKER_CONCURRENCY", env)            an injected env (tests, child scopes)
 *   wenvRaw("X")                               the raw string after aliases (presence checks, quirks)
 *
 * The source is passed in rather than imported, so this package stays at
 * layer 0 (the knob overrides live in apps/api/convex/lib/appSettings.ts).
 */
import { type EnvSource, type ReadOptions, rawFrom, readVar } from "../read";
import { envVar, type DefOf, type VarNameFor } from "../schema";
import type { VarValue } from "../schema/types";
import { processEnv } from "./processEnv";

export type WorkerVarName = VarNameFor<"worker">;
export type { EnvSource, ReadOptions };

export function wenv<N extends WorkerVarName>(name: N, source?: EnvSource, options?: ReadOptions): VarValue<DefOf<N>> {
  return readVar(name, source ?? processEnv(), options) as VarValue<DefOf<N>>;
}

export function wenvRaw(name: WorkerVarName, source?: EnvSource, options: { aliases?: boolean } = {}): string | undefined {
  const def = envVar(name);
  if (!def) throw new Error(`@fhara/config: unknown env var ${name}`);
  return rawFrom(def, source ?? processEnv(), options.aliases ?? true);
}
