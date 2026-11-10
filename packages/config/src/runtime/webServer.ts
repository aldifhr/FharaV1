/** Web server reader (route handlers, server components). Stub until E3. */
import { type EnvSource, readVar } from "../read";
import type { DefOf, VarNameFor } from "../schema";
import type { VarValue } from "../schema/types";
import { processEnv } from "./processEnv";

export type WebServerVarName = VarNameFor<"webServer">;

export function serverEnv<N extends WebServerVarName>(name: N, source?: EnvSource): VarValue<DefOf<N>> {
  return readVar(name, source ?? processEnv()) as VarValue<DefOf<N>>;
}
