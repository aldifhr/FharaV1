/**
 * Web server reader (route handlers, server components). apps/web imports
 * it through lib/env.server.ts only. NEXT_PUBLIC_* vars are not read here:
 * Next inlines them, so they stay literal in apps/web/lib/env.client.ts.
 */
import { type EnvSource, rawFrom, readVar } from "../read";
import { envVar, type DefOf, type VarNameFor } from "../schema";
import type { VarValue } from "../schema/types";
import { processEnv } from "./processEnv";

export type WebServerVarName = VarNameFor<"webServer">;

export function serverEnv<N extends WebServerVarName>(name: N, source?: EnvSource): VarValue<DefOf<N>> {
  return readVar(name, source ?? processEnv()) as VarValue<DefOf<N>>;
}

/** The raw string; `aliases: false` reads only the var's own name. */
export function serverEnvRaw(name: WebServerVarName, source?: EnvSource, options: { aliases?: boolean } = {}): string | undefined {
  const def = envVar(name);
  if (!def) throw new Error(`@fhara/config: unknown env var ${name}`);
  return rawFrom(def, source ?? processEnv(), options.aliases ?? true);
}
