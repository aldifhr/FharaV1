import type { NativeRunResult } from "./nativeProvider";

// ── JSON event parsing ────────────────────────────────────────────────

export type NativeEvent =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      tool: string;
      status: string;
      title?: string;
      target?: string;
      error?: string;
    }
  | {
      kind: "step_finish";
      inputTokens: number;
      outputTokens: number;
      reason?: string;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      cost?: number;
    }
  | { kind: "error"; message: string }
  | { kind: "other"; type: string };

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse one `opencode run --format json` line. Returns null for non-JSON
 * lines (plain-text fallback). Tool events carry only a short target
 * (file path / command / pattern), never full inputs or outputs.
 */
export function parseOpencodeEvent(line: string): NativeEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    const rec = asRecord(parsed);
    if (!rec) return null;
    raw = rec;
  } catch {
    return null;
  }
  const type = String(raw.type ?? "");
  const part = asRecord(raw.part);
  if (type === "text") {
    const text = typeof part?.text === "string" ? part.text : typeof raw.text === "string" ? raw.text : "";
    return { kind: "text", text };
  }
  if (type === "tool_use" || type === "tool") {
    const state = asRecord(part?.state) ?? {};
    const input = asRecord(state.input) ?? {};
    const targetRaw = input.filePath ?? input.path ?? input.command ?? input.pattern ?? input.url;
    const target = typeof targetRaw === "string" ? targetRaw.slice(0, 200) : undefined;
    const errorRaw = state.error;
    return {
      kind: "tool",
      tool: String(part?.tool ?? raw.tool ?? "unknown"),
      status: String(state.status ?? "unknown"),
      ...(typeof state.title === "string" ? { title: state.title.slice(0, 200) } : {}),
      ...(target ? { target } : {}),
      ...(typeof errorRaw === "string" ? { error: errorRaw.slice(0, 500) } : {}),
    };
  }
  if (type === "step_finish") {
    // OpenCode StepFinishPart (packages/schema/src/v1/session.ts):
    // tokens { input, output, reasoning, cache { read, write } }, cost (USD).
    // `input` is the NON-cached input and `output` the visible output
    // (core/src/session/usage.ts), so the ledger totals add cache and
    // reasoning back in (plan 040 P3).
    const tokens = asRecord(part?.tokens) ?? asRecord(raw.tokens) ?? {};
    const cache = asRecord(tokens.cache);
    const costRaw = part?.cost ?? raw.cost;
    return {
      kind: "step_finish",
      inputTokens: num(tokens.input) + num(cache?.read) + num(cache?.write),
      outputTokens: num(tokens.output) + num(tokens.reasoning),
      ...(typeof part?.reason === "string" ? { reason: part.reason } : {}),
      ...(cache && cache.read !== undefined ? { cachedInputTokens: num(cache.read) } : {}),
      ...(cache && cache.write !== undefined ? { cacheWriteTokens: num(cache.write) } : {}),
      ...(tokens.reasoning !== undefined ? { reasoningTokens: num(tokens.reasoning) } : {}),
      ...(typeof costRaw === "number" && Number.isFinite(costRaw) ? { cost: costRaw } : {}),
    };
  }
  if (type === "error") {
    const error = asRecord(raw.error);
    const data = asRecord(error?.data);
    const message =
      (typeof data?.message === "string" && data.message) ||
      (typeof error?.message === "string" && error.message) ||
      (typeof raw.message === "string" && raw.message) ||
      String(error?.name ?? "Provider error");
    return { kind: "error", message: message.slice(0, 2000) };
  }
  // Legacy/other providers: usage-bearing objects count as a finished step.
  const usage = asRecord(raw.usage);
  const tokens = asRecord(raw.tokens);
  if (usage || tokens) {
    return {
      kind: "step_finish",
      inputTokens: num(usage?.input_tokens ?? usage?.input) + num(tokens?.input ?? tokens?.input_tokens),
      outputTokens: num(usage?.output_tokens ?? usage?.output) + num(tokens?.output ?? tokens?.output_tokens),
    };
  }
  return { kind: "other", type: type || "unknown" };
}

export type NativeUsage = Pick<
  NativeRunResult,
  "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens" | "costUsd"
>;

/** Add one step_finish event into a running usage total (optional fields stay absent until reported). */
export function addNativeUsage(total: NativeUsage, event: Extract<NativeEvent, { kind: "step_finish" }>): NativeUsage {
  const plus = (a: number | undefined, b: number | undefined) => (b === undefined ? a : (a ?? 0) + b);
  const next: NativeUsage = {
    inputTokens: total.inputTokens + event.inputTokens,
    outputTokens: total.outputTokens + event.outputTokens,
  };
  const cached = plus(total.cachedInputTokens, event.cachedInputTokens);
  const write = plus(total.cacheWriteTokens, event.cacheWriteTokens);
  const reasoning = plus(total.reasoningTokens, event.reasoningTokens);
  const cost = plus(total.costUsd, event.cost);
  if (cached !== undefined) next.cachedInputTokens = cached;
  if (write !== undefined) next.cacheWriteTokens = write;
  if (reasoning !== undefined) next.reasoningTokens = reasoning;
  if (cost !== undefined) next.costUsd = cost;
  return next;
}

/** Token usage summed over every JSON line (legacy + opencode shapes). */
export function parseNativeUsage(stdout: string): NativeUsage {
  let usage: NativeUsage = { inputTokens: 0, outputTokens: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseOpencodeEvent(line);
    if (event?.kind === "step_finish") usage = addNativeUsage(usage, event);
  }
  return usage;
}
