// Module-local declaration (no node types needed). It refers to the real
// global at runtime: Node, the Convex V8 and "use node" runtimes, and Next's
// server all define `process.env`.
declare const process: { env?: Record<string, string | undefined> } | undefined;

/** The live process env, read per call (tests and the knob layer change it at runtime). */
export function processEnv(): Readonly<Record<string, string | undefined>> {
  return typeof process !== "undefined" && process?.env ? process.env : {};
}
