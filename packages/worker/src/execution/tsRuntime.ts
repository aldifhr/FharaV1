import { createRequire } from "node:module";
import type * as TS from "typescript";

/**
 * The TypeScript compiler, loaded lazily and synchronously from the
 * worker's own dependencies (no new dependency). Used for the pre-approval
 * syntax gate (editGuards) and the repo map (repoMap). Returns null when
 * it cannot be loaded; callers then skip their check instead of failing.
 */
let cached: typeof TS | null | undefined;

export function loadTypescript(): typeof TS | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    cached = require("typescript") as typeof TS;
  } catch {
    cached = null;
  }
  return cached;
}
