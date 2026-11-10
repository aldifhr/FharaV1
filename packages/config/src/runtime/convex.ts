/**
 * Convex reader (V8 and "use node"). E2 migrates apps/api/convex onto it.
 * Never cache: the deployment env can change between invocations.
 */
import { type EnvSource, type ReadOptions, rawFrom, readVar } from "../read";
import { envVar, type DefOf, type VarNameFor } from "../schema";
import type { VarValue } from "../schema/types";
import { processEnv } from "./processEnv";

export type ConvexVarName = VarNameFor<"convex"> | VarNameFor<"convexNode">;

export function cenv<N extends ConvexVarName>(name: N, source?: EnvSource, options?: ReadOptions): VarValue<DefOf<N>> {
  return readVar(name, source ?? processEnv(), options) as VarValue<DefOf<N>>;
}

/** The raw string after aliases (presence checks, values a caller trims itself). */
export function cenvRaw(name: ConvexVarName, source?: EnvSource): string | undefined {
  const def = envVar(name);
  if (!def) throw new Error(`@fhara/config: unknown env var ${name}`);
  return rawFrom(def, source ?? processEnv());
}

/** Parse a raw value already chosen by the caller (stored override or env) with the var's rules. */
export function cenvParse<N extends ConvexVarName>(name: N, raw: string | undefined): VarValue<DefOf<N>> {
  return readVar(name, { [name]: raw }) as VarValue<DefOf<N>>;
}
