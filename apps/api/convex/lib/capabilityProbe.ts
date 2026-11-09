/**
 * Capability probe (plan 027): the request bodies and the pure verdicts for
 * the two tiny calls a manual probe makes — one JSON-mode call and one
 * tool-call test. The action in modelCapabilities.ts sends them; keeping the
 * shapes and the parsing here makes the verdicts unit-testable.
 */
import type { ToolCallingMode } from "./modelCapabilities";

export const PROBE_TIMEOUT_MS = 90_000;
export const PROBE_MAX_TOKENS = 200;

const JSON_PROMPT = 'Reply with exactly this JSON object and nothing else: {"ok": true, "n": 3}';
const TOOL_PROMPT = "What time is it in Jakarta? Use the get_time tool.";
const TOOL = {
  name: "get_time",
  description: "Current local time in a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

export type ProbeFlavor = "openai" | "anthropic";

export function probeFlavor(provider: string): ProbeFlavor {
  return provider.trim().toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

export function jsonProbeRequest(flavor: ProbeFlavor, model: string): { path: string; body: Record<string, unknown> } {
  if (flavor === "anthropic") {
    return {
      path: "/messages",
      body: { model, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: JSON_PROMPT }] },
    };
  }
  return {
    path: "/chat/completions",
    body: {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      stream: false,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: JSON_PROMPT }],
    },
  };
}

export function toolProbeRequest(flavor: ProbeFlavor, model: string): { path: string; body: Record<string, unknown> } {
  if (flavor === "anthropic") {
    return {
      path: "/messages",
      body: {
        model,
        max_tokens: PROBE_MAX_TOKENS,
        tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }],
        messages: [{ role: "user", content: TOOL_PROMPT }],
      },
    };
  }
  return {
    path: "/chat/completions",
    body: {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      stream: false,
      tools: [{ type: "function", function: TOOL }],
      messages: [{ role: "user", content: TOOL_PROMPT }],
    },
  };
}

type Body = {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
  content?: Array<{ type?: string; text?: string }>;
};

function parseBody(raw: string): Body | null {
  try {
    return JSON.parse(raw) as Body;
  } catch {
    try {
      return JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/i, "")) as Body;
    } catch {
      return null;
    }
  }
}

function textOf(body: Body): string {
  const openai = body.choices?.[0]?.message?.content;
  if (typeof openai === "string") return openai;
  return (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

/** Strip ```json fences and surrounding prose down to the first {...}. */
function firstJsonObject(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** JSON probe verdict: true when the reply parses to {"ok": true}. */
export function evaluateJsonProbe(raw: string): boolean {
  const body = parseBody(raw);
  if (!body) return false;
  const parsed = firstJsonObject(textOf(body)) as { ok?: unknown } | null;
  return Boolean(parsed && parsed.ok === true);
}

/** Tool probe verdict: native tool call, text markup, or none. */
export function evaluateToolProbe(raw: string): ToolCallingMode {
  const body = parseBody(raw);
  if (!body) return "none";
  const calls = body.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) return "native";
  if ((body.content ?? []).some((b) => b.type === "tool_use")) return "native";
  const text = textOf(body);
  if (/<[\w-]*tool_call\b/i.test(text) || /<function_call\b/i.test(text)) return "markup";
  return "none";
}

/**
 * HTTP status of a probe call that was rejected: 400/422 on the tool call
 * means the endpoint refused the `tools` parameter (verdict "none"); any
 * other failure gives no verdict.
 */
export function rejectedToolsParam(status: number): boolean {
  return status === 400 || status === 422;
}
