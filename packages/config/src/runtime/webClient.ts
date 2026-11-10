/**
 * Web client vars. Next inlines only literal `process.env.NEXT_PUBLIC_X`
 * reads, so the client reads stay literal in apps/web (E3); this module
 * only names which vars may appear there.
 */
import type { VarNameFor } from "../schema";

export type WebClientVarName = VarNameFor<"webClient">;

export const WEB_CLIENT_VARS: readonly WebClientVarName[] = ["NEXT_PUBLIC_CONVEX_URL"];
