/**
 * Web client vars. Vite exposes these through the runtime bridge
 * reads, so the client reads stay literal in apps/web (E3); this module
 * only names which vars may appear there.
 */
import type { VarNameFor } from "../schema";

export type WebClientVarName = VarNameFor<"webClient">;

export const WEB_CLIENT_VARS: readonly WebClientVarName[] = ["FHARA_BACKEND_URL"];
