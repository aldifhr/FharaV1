/**
 * O5: command access log for git / gh / GitHub API calls.
 *
 * `sanitizeAccessLogArgs`, `sanitizeAccessLogText`, the sensitive flag and
 * value tests and the failure-kind classification are ported from vigilante
 * `internal/environment/accesslog.go` (Apache-2.0, commit a4f7826; see
 * THIRD_PARTY_NOTICES.md). Modified by Fhara: TypeScript; also redacts
 * `x-access-token:` URLs, Basic/Bearer header values (git
 * `http.extraheader`), `GH_TOKEN=`-style assignments, values the caller knows
 * are secret, and token-shaped strings (ghp_/gho_/ghs_/ghu_/ghr_,
 * github_pat_, sk-…, long base64 after "basic").
 *
 * A row never carries stdout/stderr, only the sanitized argv, exit code,
 * duration and a short sanitized failure detail.
 */

export const REDACTED = "<redacted>";

export interface AccessLogEntry {
  /** `git`, `gh`, `github-api` … */
  tool: string;
  argv: string[];
  exitCode: number;
  durationMs: number;
  success: boolean;
  failureKind?: "exit_error" | "timeout" | "canceled" | "not_found" | "runtime_error" | "http_error";
  error?: string;
  cwd?: string;
}

export type CommandRecorder = (entry: AccessLogEntry) => void | Promise<void>;

let globalSink: CommandRecorder | undefined;

/** Install the process-wide recorder (worker startup); undefined removes it. */
export function setCommandSink(sink: CommandRecorder | undefined): void {
  globalSink = sink;
}

/** Hand an entry to `recorder` (or the process sink). Never throws, never awaits the network for the caller's result. */
export async function emitCommand(entry: AccessLogEntry, recorder?: CommandRecorder): Promise<void> {
  const sink = recorder ?? globalSink;
  if (!sink) return;
  try {
    await sink(entry);
  } catch {
    // Logging must never break the command it describes.
  }
}

const SENSITIVE_NAME_TOKENS = ["token", "secret", "password", "authorization", "auth", "cookie", "apikey", "api_key", "api-key", "credential"];
const SENSITIVE_VALUE_TOKENS = ["authorization:", "bearer ", "token ", "basic ", "ghp_", "gho_", "ghs_", "ghu_", "ghr_", "github_pat_", "x-access-token:"];
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g;

function looksSensitiveFlagName(arg: string): boolean {
  const lower = arg.trim().replace(/^-+/, "").toLowerCase();
  return SENSITIVE_NAME_TOKENS.some((t) => lower.includes(t));
}

function isHeaderFlag(arg: string): boolean {
  return arg === "-H" || arg === "--header";
}

function hasSensitiveAssignment(arg: string): boolean {
  const eq = arg.indexOf("=");
  if (eq <= 0) return false;
  return arg.slice(eq + 1) !== "" && looksSensitiveFlagName(arg.slice(0, eq));
}

function hasSensitiveFlag(arg: string): boolean {
  return arg.startsWith("-") && !arg.includes("=") && looksSensitiveFlagName(arg);
}

function looksSensitiveValue(arg: string): boolean {
  const lower = arg.toLowerCase();
  if (SENSITIVE_VALUE_TOKENS.some((t) => lower.includes(t))) return true;
  TOKEN_SHAPE.lastIndex = 0;
  return TOKEN_SHAPE.test(arg);
}

function maskKnown(text: string, known: readonly string[]): string {
  let out = text;
  for (const secret of known) if (secret && secret.length >= 6) out = out.split(secret).join(REDACTED);
  return out;
}

/** Sanitize an argv for the log (vigilante rules plus Fhara's). */
export function sanitizeAccessLogArgs(args: readonly string[], knownSecrets: readonly string[] = []): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const raw of args) {
    const arg = maskKnown(raw.trim(), knownSecrets);
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
    } else if (isHeaderFlag(arg)) {
      out.push(arg);
      redactNext = true;
    } else if (arg.startsWith("http.") || arg.includes(".extraheader=")) {
      // `-c http.https://github.com/.extraheader=AUTHORIZATION: basic …`
      const eq = arg.indexOf("=");
      out.push(eq > 0 && looksSensitiveValue(arg.slice(eq + 1)) ? `${arg.slice(0, eq)}=${REDACTED}` : sanitizeAccessLogText(arg, knownSecrets));
    } else if (hasSensitiveAssignment(arg)) {
      out.push(`${arg.slice(0, arg.indexOf("="))}=${REDACTED}`);
    } else if (hasSensitiveFlag(arg)) {
      out.push(arg);
      redactNext = true;
    } else if (looksSensitiveValue(arg)) {
      out.push(sanitizeAccessLogText(arg, knownSecrets));
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** Sanitize free text (an error line, a URL) for the log. */
export function sanitizeAccessLogText(text: string, knownSecrets: readonly string[] = []): string {
  let out = maskKnown(text.trim(), knownSecrets);
  if (!out) return "";
  // https://x-access-token:SECRET@github.com/… and user:pass@ URLs.
  out = out.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  out = out.replace(/x-access-token:[^\s@"']+/gi, `x-access-token:${REDACTED}`);
  // Header values: everything after the scheme up to a quote/space/newline.
  out = out.replace(/(authorization:\s*)(?:(basic|bearer|token)\s+)?[^\s"'\r\n]+/gi, (_m, head: string, scheme?: string) => `${head}${scheme ? `${scheme} ` : ""}${REDACTED}`);
  out = out.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
  // NAME=value assignments with a sensitive name.
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)=([^\s"']+)/g, (m, name: string) => (looksSensitiveFlagName(name) ? `${name}=${REDACTED}` : m));
  TOKEN_SHAPE.lastIndex = 0;
  out = out.replace(TOKEN_SHAPE, REDACTED);
  return out;
}

/** vigilante's failure-kind classification, from a Node child-process error. */
export function failureKindOf(error: unknown): AccessLogEntry["failureKind"] {
  const e = error as { code?: unknown; killed?: boolean; signal?: unknown; name?: string; message?: string } | null;
  if (!e) return undefined;
  if (e.name === "AbortError" || /cancel|abort/i.test(String(e.message ?? ""))) return "canceled";
  if (e.killed || /timed out|ETIMEDOUT/i.test(String(e.message ?? ""))) return "timeout";
  if (e.code === "ENOENT") return "not_found";
  if (typeof e.code === "number") return "exit_error";
  return "runtime_error";
}

export function exitCodeOf(error: unknown): number {
  if (!error) return 0;
  const e = error as { code?: unknown; killed?: boolean };
  if (typeof e.code === "number") return e.code;
  const kind = failureKindOf(error);
  if (kind === "timeout") return 124;
  if (kind === "canceled") return 130;
  if (kind === "not_found") return 127;
  return 1;
}

/** Build an entry for a finished command (detail truncated to 240 chars like vigilante). */
export function buildAccessLogEntry(input: {
  tool: string;
  args: readonly string[];
  startedAt: number;
  endedAt: number;
  error?: unknown;
  output?: string;
  cwd?: string;
  knownSecrets?: readonly string[];
}): AccessLogEntry {
  const known = input.knownSecrets ?? [];
  const entry: AccessLogEntry = {
    tool: input.tool,
    argv: sanitizeAccessLogArgs(input.args, known),
    exitCode: exitCodeOf(input.error),
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    success: !input.error,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
  if (input.error) {
    entry.failureKind = failureKindOf(input.error);
    let detail = sanitizeAccessLogText(input.output?.trim() || (input.error instanceof Error ? input.error.message : String(input.error)), known);
    if (detail.length > 240) detail = `${detail.slice(0, 240)}...(truncated)`;
    entry.error = detail;
  }
  return entry;
}

/** Run `fn`, time it, and emit one entry whatever happens; rethrows the error. */
export async function withAccessLog<T>(
  meta: { tool: string; args: readonly string[]; cwd?: string; knownSecrets?: readonly string[]; recorder?: CommandRecorder; exitCode?: (result: T) => number },
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const entry = buildAccessLogEntry({ ...meta, startedAt, endedAt: Date.now() });
    const code = meta.exitCode?.(result);
    if (code !== undefined && code !== 0) {
      entry.exitCode = code;
      entry.success = false;
      entry.failureKind = "exit_error";
    }
    await emitCommand(entry, meta.recorder);
    return result;
  } catch (error) {
    await emitCommand(buildAccessLogEntry({ ...meta, startedAt, endedAt: Date.now(), error }), meta.recorder);
    throw error;
  }
}
