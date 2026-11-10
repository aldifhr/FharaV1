/**
 * Convex reader (V8 and "use node"). E2 migrates apps/api/convex onto it.
 * Never cache: the deployment env can change between invocations.
 */
import { type EnvSource, type ReadOptions, readVar } from "../read";
import type { DefOf, VarNameFor } from "../schema";
import type { VarValue } from "../schema/types";
import { processEnv } from "./processEnv";

export type ConvexVarName = VarNameFor<"convex"> | VarNameFor<"convexNode">;

export function cenv<N extends ConvexVarName>(name: N, source?: EnvSource, options?: ReadOptions): VarValue<DefOf<N>> {
  return readVar(name, source ?? processEnv(), options) as VarValue<DefOf<N>>;
}
