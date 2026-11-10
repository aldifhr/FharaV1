import { settingEnv } from "@/api/convex/lib/appSettings";
import { wenv, type EnvSource } from "@fhara/config/worker";

/**
 * B1 (D3): whether research/audit agents get the dynamic tool-discovery
 * section. Read like every other knob: the Settings override first, then
 * the env, parsed by the shared bool parser, so it agrees with
 * loadPolicy().toolLoop. Before B1 this was raw `process.env === "true"`,
 * which ignored the UI override and "1".
 */
export function toolLoopEnabled(source: EnvSource = settingEnv): boolean {
  return wenv("ORCHESTRATOR_TOOL_LOOP", source);
}
