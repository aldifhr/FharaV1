/**
 * L2: one redactor for every path out of the worker.
 *
 * Two layers, in this order:
 *  1. Known values: the actual secret strings this worker holds or handed
 *     out (LLM provider keys and other sensitive variables in its own env,
 *     the GitHub token of a push claim, MCP server env values). These are
 *     masked exactly, wherever they appear, whatever they look like.
 *  2. Shape patterns shared with the Convex side
 *     (`apps/api/convex/lib/secretPatterns.ts`): token prefixes, PEM
 *     blocks, `key=value` with a sensitive key name, `Bearer …`.
 *
 * ANSI escapes can hide a secret from a `key=value` rule
 * (`apiKey=\x1b[0mVALUE`), so the text is also checked with escapes
 * stripped; when that copy carries a secret the stripped, masked copy is
 * returned (colour is lost only when something was masked).
 *
 * The known-value idea (mask configured values of ≥4 chars before the
 * pattern rules, walk objects instead of cutting serialized JSON) follows
 * openbot's `mcp-redaction.ts` (pattern only, no code copied: PolyForm
 * Noncommercial).
 */
import { redactSecrets } from "@/api/convex/lib/secretPatterns";

export const REDACTED = "[REDACTED]";

/** Shortest explicitly registered value that is masked. */
const MIN_KNOWN_LENGTH = 4;
/** Shortest env value picked up automatically (avoids masking "true", ports, …). */
const MIN_ENV_LENGTH = 8;

/** Env names whose values are secrets (suffix or whole-word match). */
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|PRIVATE_KEY|COOKIE|AUTH|ACCESS_KEY|CLIENT_SECRET|DEPLOY_KEY|ADMIN_KEY)$/i;
/** Env names that look sensitive but hold no secret. */
const NON_SECRET_ENV_NAME = /^(?:PWD|OLDPWD|SSH_AUTH_SOCK|GPG_TTY|.*_(?:URL|HOST|PORT|PATH|DIR|FILE|MODEL|ID))$/i;

const known = new Set<string>();
let sorted: string[] | null = null;
let envScanned = false;

/** Register secret values to mask everywhere from now on. */
export function registerSecretValues(values: Iterable<string | undefined | null>): void {
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length < MIN_KNOWN_LENGTH) continue;
    if (!known.has(value)) {
      known.add(value);
      sorted = null;
    }
  }
}

/** Whether a variable name holds a secret (exported for the command gate). */
export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name) && !NON_SECRET_ENV_NAME.test(name);
}

/** Register the sensitive values of an env (default: the worker's own). */
export function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_ENV_LENGTH) continue;
    if (!isSensitiveEnvName(name)) continue;
    if (/^(?:true|false|on|off|yes|no|\d+)$/i.test(value)) continue;
    values.push(value);
  }
  registerSecretValues(values);
}

function ensureEnv(): void {
  if (envScanned) return;
  envScanned = true;
  registerEnvSecrets();
}

/** Registered values, longest first (a long value containing a short one wins). */
export function knownSecretValues(): readonly string[] {
  ensureEnv();
  if (!sorted) sorted = [...known].sort((a, b) => b.length - a.length);
  return sorted;
}

/** Test hook: forget every registered value (and rescan the env next time). */
export function resetKnownSecretsForTests(): void {
  known.clear();
  sorted = null;
  envScanned = false;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function maskKnown(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
}

/** Mask known values and secret-shaped text. Idempotent; never throws. */
export function redactText(text: string, extra: readonly string[] = []): string {
  if (!text || typeof text !== "string") return text;
  try {
    const values = extra.length > 0 ? [...extra.filter((v) => v && v.length >= MIN_KNOWN_LENGTH), ...knownSecretValues()] : knownSecretValues();
    const masked = redactSecrets(maskKnown(text, values));
    if (!text.includes("\x1b")) return masked;
    const plain = stripAnsi(masked);
    const plainMasked = redactSecrets(maskKnown(plain, values));
    return plainMasked === plain ? masked : plainMasked;
  } catch {
    return text;
  }
}

/**
 * Mask every string inside a value (objects and arrays walked, never
 * serialized and cut). Non-plain objects (Dates, Buffers…) pass through.
 */
export function redactDeep<T>(value: T, extra: readonly string[] = [], depth = 0): T {
  if (typeof value === "string") return redactText(value, extra) as unknown as T;
  if (value === null || typeof value !== "object" || depth > 20) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, extra, depth + 1)) as unknown as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactDeep(item, extra, depth + 1);
  }
  return out as T;
}

let consoleInstalled = false;

/**
 * Mask secrets in the worker's own console output (stdout/stderr logs).
 * String arguments are masked; Error objects are replaced by their masked
 * stack; other objects are masked by walking them.
 */
export function installConsoleRedaction(target: Console = console): void {
  if (consoleInstalled && target === console) return;
  if (target === console) consoleInstalled = true;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      original(
        ...args.map((arg) =>
          arg instanceof Error ? redactText(arg.stack ?? `${arg.name}: ${arg.message}`) : redactDeep(arg)
        )
      );
    };
  }
}
