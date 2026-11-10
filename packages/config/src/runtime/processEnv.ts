/** The live process env, read per call (tests and the knob layer change it at runtime). No node types needed. */
export function processEnv(): Readonly<Record<string, string | undefined>> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}
