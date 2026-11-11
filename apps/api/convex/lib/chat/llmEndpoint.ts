/**
 * Pure endpoint helpers for the backend LLM client (lib/chat/llm.ts):
 * which wire protocol a provider kind speaks, which URL(s) to call for a
 * configured base URL, and a key-free description of the endpoint for
 * error messages.
 *
 * - Provider kinds: only Anthropic speaks the Messages API. Every other
 *   kind ("openai", "openai-compatible", and legacy/free-form values such
 *   as "openrouter", "groq", "ollama", "deepseek", ...) speaks OpenAI chat
 *   completions. Before, anything that was not exactly "openai" /
 *   "openai-compatible" fell through to the Anthropic branch.
 * - Base URLs: users enter a gateway as `http://host:port` or
 *   `http://host:port/v1` (or the full `/chat/completions` URL). The URL as
 *   configured is tried first (what has always worked for chat); on a 404
 *   the variant with / without the `/v1` segment is tried once.
 */
import { contextLimitFromText, isContextOverflowText, LlmContextOverflowError } from "../llmWireErrors";

export type LlmWireProtocol = "anthropic" | "openai";

/** The wire protocol a provider kind speaks. Unknown kinds default to OpenAI chat completions. */
export function wireProtocolFor(provider: string | undefined, baseUrl?: string): LlmWireProtocol {
  const kind = (provider ?? "").trim().toLowerCase();
  if (kind === "anthropic" || kind === "claude" || kind.startsWith("anthropic")) return "anthropic";
  if (!kind && baseUrl && /(^|\.)anthropic\.com/i.test(hostOf(baseUrl))) return "anthropic";
  return "openai";
}

/** host[:port] of a URL, or "" when it does not parse. Never includes credentials, path or query. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** "openai-compatible @ 10.0.0.5:8080" — provider kind and host only (no key, no path). */
export function describeEndpoint(config: { provider: string; baseUrl: string }): string {
  const kind = (config.provider || "unknown").toLowerCase();
  const host = hostOf(config.baseUrl) || "invalid base URL";
  return `${kind} @ ${host}`;
}

function splitBase(baseUrl: string): { origin: string; path: string; query: string } | null {
  try {
    const url = new URL(baseUrl.trim());
    return { origin: url.origin, path: url.pathname.replace(/\/+$/, ""), query: url.search };
  } catch {
    return null;
  }
}

const VERSION_TAIL = /\/v\d+[a-z0-9]*$/i;
const HAS_VERSION = /\/v\d+[a-z0-9]*(\/|$)/i;

/**
 * Candidate URLs for one request, in order: the configured base + suffix
 * first, then (only for a 404) the same with the trailing `/v1` removed, or
 * with `/v1` added when the base has no version segment at all. A base that
 * already ends with the suffix is used as-is with no alternative.
 */
export function endpointCandidates(baseUrl: string, suffix: "/chat/completions" | "/messages" | "/models"): string[] {
  const parts = splitBase(baseUrl);
  if (!parts) {
    // Not a URL we can reason about: keep the historical behavior.
    return [`${baseUrl.replace(/\/+$/, "")}${suffix}`];
  }
  const { origin, path, query } = parts;
  if (path.toLowerCase().endsWith(suffix)) return [`${origin}${path}${query}`];
  const primary = `${origin}${path}${suffix}${query}`;
  let alternate: string | null = null;
  if (VERSION_TAIL.test(path)) {
    alternate = `${origin}${path.replace(VERSION_TAIL, "")}${suffix}${query}`;
  } else if (!HAS_VERSION.test(path)) {
    alternate = `${origin}${path}/v1${suffix}${query}`;
  }
  return alternate && alternate !== primary ? [primary, alternate] : [primary];
}

/** Short, single-line body excerpt for an error message, with obvious secrets masked. */
export function errorBodyExcerpt(body: string, max = 240): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const masked = flat
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .replace(/("?(?:api[_-]?key|authorization|x-api-key|token)"?\s*[:=]\s*"?)[^",\s}]{6,}/gi, "$1[REDACTED]");
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}

/** The error thrown for a non-2xx LLM response: status, provider kind, host and model — never the key. */
export function llmHttpError(
  status: number,
  config: { provider: string; baseUrl: string; model: string },
  body?: string,
  attempted?: string[]
): Error {
  const excerpt = body ? errorBodyExcerpt(body) : "";
  const tried =
    attempted && attempted.length > 1
      ? `; tried ${attempted.map((u) => safePath(u)).join(", ")}`
      : attempted && attempted.length === 1
        ? `; path ${safePath(attempted[0])}`
        : "";
  const message = `LLM request failed: ${status} (${describeEndpoint(config)}, model "${config.model}"${tried})${excerpt ? `: ${excerpt}` : ""}`;
  // A context overflow gets its own class (no cooldown, no rotation; D2).
  if (status >= 400 && status < 500 && isContextOverflowText(body)) {
    return new LlmContextOverflowError(message, { status, contextLimit: contextLimitFromText(body) });
  }
  return Object.assign(new Error(message), { status });
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "?";
  }
}
