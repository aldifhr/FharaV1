/**
 * Tool-output spill (DeepSeek Harness D3, pattern only, MIT, Copyright (c)
 * 2026 DeepSeek: `packages/spill/spill-policy` retention + notice, and the
 * surrogate-safe cut of its `retention.ts`; no code copied).
 *
 * A tool result longer than TOOL_RESULT_MAX_TOKENS (chars/4, default 4096)
 * is written, secret-masked, to `<FHARA_SPILL_DIR>/<taskId>/<callId>.txt`
 * (default ~/.fhara/spill, 0600, outside every worktree, so it can never be
 * committed). The model gets the head and tail plus a notice with a
 * task-scoped locator (`spill:<taskId>/<callId>`) it can page through with
 * the `read_tool_output` tool (offset + limit).
 *
 * Consistency with D2 (context/overflowRecovery.ts): the preview is built
 * from the same head 4096 + tail 1024 budgets and always stays under the
 * pruner's 8192 threshold, so overflow recovery never re-prunes it; it also
 * skips any message that carries a spill notice. A range read is capped
 * below that threshold too.
 *
 * Spill failure keeps the original text (the D2 prune still bounds it) and
 * logs the reason. Files are swept by age (FHARA_SPILL_RETENTION_HOURS,
 * default 72, the worktree retention default) at worker start and hourly,
 * and `removeTaskSpill` drops one task's files.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { wenv } from "@fhara/config/worker";
import { redactText } from "@/utils/redact";
import { DEFAULTS as PRUNE_DEFAULTS, PRUNE_MARKER } from "@/vendor/deepseek-harness/prunerConfig";

export const SPILL_READ_TOOL = "read_tool_output";
/** Every spill notice starts with this; recognized by D2 pruning and the loop's opencode prune. */
export const SPILL_NOTICE_PREFIX = "(Full output saved as ";
const LOCATOR_PREFIX = "spill:";
/** Range-read cap (chars): stays below the D2 prune threshold. */
export const SPILL_READ_MAX_CHARS = 6000;

export interface SpillConfig {
  /** Spill above this many chars; 0 = off. */
  maxChars: number;
  root: string;
  headChars: number;
  tailChars: number;
  retentionMs: number;
}

export function spillConfigFromEnv(env?: Record<string, string | undefined>): SpillConfig {
  const tokens = wenv("TOOL_RESULT_MAX_TOKENS", env);
  return {
    maxChars: tokens > 0 ? tokens * 4 : 0,
    root: wenv("FHARA_SPILL_DIR", env) || path.join(os.homedir(), ".fhara", "spill"),
    headChars: PRUNE_DEFAULTS.headChars,
    tailChars: PRUNE_DEFAULTS.tailChars,
    retentionMs: wenv("FHARA_SPILL_RETENTION_HOURS", env) * 3_600_000,
  };
}

/** Path-safe id segment ("" when nothing is left). */
function safeId(raw: string): string {
  return String(raw).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/** Cut index moved off the middle of a surrogate pair (never splits a code point). */
function safeCut(text: string, index: number, forward = false): number {
  const at = Math.max(0, Math.min(text.length, index));
  const prev = text.charCodeAt(at - 1);
  const cur = text.charCodeAt(at);
  if (prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff) return forward ? at + 1 : at - 1;
  return at;
}

/** temp file + fsync + rename, mode 0600 (atomic-write pattern). */
function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function spillLocator(taskId: string, callId: string): string {
  return `${LOCATOR_PREFIX}${safeId(taskId)}/${safeId(callId)}`;
}

export function readHint(locator: string, offset: number): string {
  return `${SPILL_READ_TOOL} {"id":"${locator}","offset":${offset},"limit":${SPILL_READ_MAX_CHARS}}`;
}

export function isSpillPreview(text: string): boolean {
  return text.includes(SPILL_NOTICE_PREFIX + LOCATOR_PREFIX);
}

/** The notice line of a spilled preview (kept when the loop prunes the preview), or undefined. */
export function spillNoticeOf(text: string): string | undefined {
  const at = text.lastIndexOf(SPILL_NOTICE_PREFIX + LOCATOR_PREFIX);
  if (at < 0) return undefined;
  const end = text.indexOf(")", at);
  return end < 0 ? undefined : text.slice(at, end + 1);
}

export interface SpillOptions {
  taskId: string;
  callId: string;
  config?: SpillConfig;
  log?: (message: string, detail?: unknown) => void;
}

export interface SpillResult {
  /** What the model sees: the preview when spilled, else the input. */
  text: string;
  spilled?: { locator: string; file: string; chars: number; bytes: number };
}

/** Spill `text` when over the threshold; under it (or off), returns it unchanged. */
export function spillIfLarge(text: string, options: SpillOptions): SpillResult {
  const config = options.config ?? spillConfigFromEnv();
  if (!config.maxChars || typeof text !== "string" || text.length <= config.maxChars) return { text };
  const taskId = safeId(options.taskId);
  const callId = safeId(options.callId);
  if (!taskId || !callId) return { text };
  // L2: the file holds the masked text only (the loop masks too; masking is idempotent).
  const masked = redactText(text);
  const file = path.join(config.root, taskId, `${callId}.txt`);
  try {
    writeAtomic(file, masked);
  } catch (error) {
    options.log?.(`[spill] could not save tool output (${masked.length} chars); kept inline: ${error instanceof Error ? error.message : String(error)}`);
    return { text };
  }
  const locator = spillLocator(taskId, callId);
  const headEnd = safeCut(masked, config.headChars);
  const tailStart = Math.max(headEnd, safeCut(masked, masked.length - config.tailChars, true));
  const omitted = tailStart - headEnd;
  const bytes = Buffer.byteLength(masked, "utf8");
  const preview =
    masked.slice(0, headEnd) +
    PRUNE_MARKER.replace("middle pruned", `${omitted} chars omitted of ${masked.length}`) +
    masked.slice(tailStart) +
    `\n\n${SPILL_NOTICE_PREFIX}${locator}, ${masked.length} chars, ${bytes} bytes. Shown: chars 0-${headEnd} and ${tailStart}-${masked.length}. Read the rest with ${readHint(locator, headEnd)}.)`;
  return { text: preview, spilled: { locator, file, chars: masked.length, bytes } };
}

export interface SpillReadResult {
  ok: boolean;
  isError: boolean;
  text: string;
}

/** Read a range of a spilled output; only the task's own locators resolve. */
export function readSpill(
  locator: unknown,
  scope: { taskId: string; offset?: unknown; limit?: unknown; config?: SpillConfig }
): SpillReadResult {
  const fail = (text: string): SpillReadResult => ({ ok: false, isError: true, text });
  const config = scope.config ?? spillConfigFromEnv();
  const match = typeof locator === "string" ? /^spill:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(locator.trim()) : null;
  if (!match) return fail(`Not a spill id: expected "spill:<task>/<call>" from a saved-output notice.`);
  if (match[1] !== safeId(scope.taskId)) return fail("That saved output belongs to another task; only this task's outputs can be read.");
  const file = path.join(config.root, match[1], `${match[2]}.txt`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return fail(`No saved output ${match[0]} (it may have been swept after ${Math.round(config.retentionMs / 3_600_000)} h).`);
  }
  const num = (value: unknown, dflt: number) => (typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : dflt);
  const start = safeCut(text, Math.max(0, num(scope.offset, 0)), true);
  const limit = Math.min(SPILL_READ_MAX_CHARS, Math.max(1, num(scope.limit, SPILL_READ_MAX_CHARS)));
  const end = safeCut(text, start + limit);
  const more = end < text.length ? ` Next: ${readHint(match[0], end)}.` : " End of output.";
  return { ok: true, isError: false, text: `[${match[0]} chars ${start}-${end} of ${text.length}]\n${text.slice(start, end)}\n[${more.trim()}]` };
}

/** Remove one task's spill files. */
export function removeTaskSpill(taskId: string, config: SpillConfig = spillConfigFromEnv()): void {
  const id = safeId(taskId);
  if (id) rmSync(path.join(config.root, id), { recursive: true, force: true });
}

/** Remove task spill dirs whose newest file is older than the retention window. Returns how many. */
export function sweepSpill(config: SpillConfig = spillConfigFromEnv(), now = Date.now()): number {
  if (!existsSync(config.root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(config.root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(config.root, entry.name);
    try {
      let newest = statSync(dir).mtimeMs;
      for (const name of readdirSync(dir)) newest = Math.max(newest, statSync(path.join(dir, name)).mtimeMs);
      if (now - newest > config.retentionMs) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // A dir removed mid-sweep or unreadable: skip it this round.
    }
  }
  return removed;
}
