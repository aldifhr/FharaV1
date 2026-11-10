import { CORE_VARS } from "./core";
import { EXEC_VARS } from "./exec";
import { GIT_VARS } from "./git";
import { GITHUB_VARS, USAGE_VARS } from "./github";
import { LLM_VARS } from "./llm";
import { POLICY_VARS } from "./policy";
import { QA_VARS, SNAPSHOT_VARS, THREAD_VARS, WORKSPACE_VARS } from "./qa";
import type { EnvVar, Runtime } from "./types";
import { ELECTRON_VARS, SCRIPT_VARS, WEB_VARS } from "./web";
import { DIRECT_VARS, WORKER_VARS } from "./worker";

export * from "./types";
export { DEFAULT_SUBTASK_TIMEOUT_MS } from "./policy";

/** Every Fhara-owned env var, once. Platform vars (PATH, HOME, XDG_*, proxies, NODE_ENV) are not here. */
export const ENV_SCHEMA = [
  ...CORE_VARS,
  ...LLM_VARS,
  ...GITHUB_VARS,
  ...USAGE_VARS,
  ...WEB_VARS,
  ...WORKER_VARS,
  ...DIRECT_VARS,
  ...POLICY_VARS,
  ...EXEC_VARS,
  ...GIT_VARS,
  ...QA_VARS,
  ...SNAPSHOT_VARS,
  ...THREAD_VARS,
  ...WORKSPACE_VARS,
  ...ELECTRON_VARS,
  ...SCRIPT_VARS,
] as const;

export type EnvSchema = typeof ENV_SCHEMA;
export type VarDef = EnvSchema[number];
export type VarName = VarDef["name"];
export type DefOf<N extends VarName> = Extract<VarDef, { name: N }>;
/** Names of the vars a runtime reads. */
export type VarNameFor<R extends Runtime> = VarDef extends infer D
  ? D extends { name: infer N; runtimes: readonly (infer X)[] }
    ? R extends X
      ? N
      : never
    : never
  : never;

const BY_NAME: ReadonlyMap<string, EnvVar> = new Map((ENV_SCHEMA as readonly EnvVar[]).map((def) => [def.name, def]));

export function envVar(name: string): EnvVar | undefined {
  return BY_NAME.get(name);
}

export function isVarName(name: string): name is VarName {
  return BY_NAME.has(name);
}

export function varsFor(runtime: Runtime): readonly EnvVar[] {
  return (ENV_SCHEMA as readonly EnvVar[]).filter((def) => def.runtimes.includes(runtime));
}
