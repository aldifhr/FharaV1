/**
 * Mock LLM: an OpenAI-compatible stub so the worker (and the Convex chat
 * actions) run end-to-end in seconds instead of minutes, with no provider
 * quota. `npm run mock:llm` (docs/mock-fixtures.md).
 *
 *   POST /v1/chat/completions   scripted reply; `stream: true` → SSE replayed at 30 Hz × speed
 *   GET  /v1/models             mock/default plus one model per scenario in the script
 *   GET  /__mock/calls          the recent requests (role, rule, scenario) for tests
 *   POST /__mock/reset          clear the call log and the per-rule counters
 *
 * Replies come from a JSON script (scripts/mock-llm/scripts/default.json):
 * rules matched in order on the request's text (a role is recognised from
 * the worker's own prompt wording) and, optionally, a scenario. The
 * scenario is the model name after "mock/" (pick it per agent / provider in
 * Settings), the `x-mock-scenario` header, or --scenario.
 *
 * Adapted from threadbear (https://github.com/mikecann/threadbear, MIT,
 * commit b697f32), app/Tools/mock-runner/server.mjs: a stand-in server
 * that fakes turns, replays a stream at 30 Hz with 2-12 character deltas,
 * writes a random token (0600) for its client, and refuses to touch real
 * data (here: it only ever binds to loopback). The OpenAI protocol, rules
 * and scenarios are Fhara's.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVar } from "@fhara/config";

export interface MockRule {
  id: string;
  /** Recognised role, for the call log ("planner", "classifier", …). */
  role?: string;
  /** Only for this scenario (model "mock/<scenario>"). Unset = every scenario. */
  scenario?: string;
  /** Regexes (case-insensitive); every one must match the request text. */
  match?: string[];
  /** One reply, or several played in order (the last repeats). */
  reply?: string;
  replies?: string[];
  /** Reasoning text streamed before the reply (OpenAI-style `reasoning_content`). */
  reasoning?: string;
  /** Answer with this HTTP status instead (error injection: 429, 500, 401). */
  status?: number;
  /** Only the first N matches use this rule; later ones fall through. */
  times?: number;
  /** Extra latency before answering (ms, divided by the speed). */
  delayMs?: number;
}

export interface MockScript {
  rules: MockRule[];
  fallback: string;
}

export interface MockCall {
  n: number;
  at: number;
  model: string;
  scenario: string;
  rule: string;
  role: string;
  stream: boolean;
  status: number;
}

export interface MockLlmOptions {
  port?: number;
  /** Replay speed: 1 = 30 Hz, 10 = ten times faster, 0 = no delay. */
  speed?: number;
  script?: MockScript;
  scenario?: string;
  /** Bearer token required on every request; unset = any token is accepted. */
  token?: string;
  quiet?: boolean;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCRIPT_PATH = path.join(HERE, "scripts/default.json");
const STREAM_HZ = 30;

export function loadScript(file: string = DEFAULT_SCRIPT_PATH): MockScript {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MockScript>;
  if (!Array.isArray(parsed.rules)) throw new Error(`mock-llm: ${file} has no "rules" array`);
  for (const rule of parsed.rules) {
    if (!rule.id) throw new Error(`mock-llm: a rule in ${file} has no id`);
    for (const re of rule.match ?? []) new RegExp(re, "i");
  }
  return { rules: parsed.rules, fallback: parsed.fallback ?? "Mock reply." };
}

type ChatMessage = { role?: string; content?: unknown };

function textOf(messages: ChatMessage[]): string {
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p?.text ?? "").join("\n") : ""))
    .join("\n\n");
}

/** Pick the rule for one request; counts uses per rule for `times` / `replies`. */
export function pickRule(script: MockScript, text: string, scenario: string, used: Map<string, number>): { rule: MockRule | null; reply: string } {
  for (const rule of script.rules) {
    if (rule.scenario && rule.scenario !== scenario) continue;
    if (!(rule.match ?? []).every((re) => new RegExp(re, "i").test(text))) continue;
    const count = used.get(rule.id) ?? 0;
    if (rule.times !== undefined && count >= rule.times) continue;
    used.set(rule.id, count + 1);
    const replies = rule.replies ?? (rule.reply !== undefined ? [rule.reply] : []);
    return { rule, reply: replies.length ? replies[Math.min(count, replies.length - 1)] : script.fallback };
  }
  return { rule: null, reply: script.fallback };
}

/** Threadbear's delta sizes: 2 to 12 characters, cycling. */
export function chunkText(text: string): string[] {
  const out: string[] = [];
  for (let i = 0, tick = 0; i < text.length; tick++) {
    const size = 2 + (tick % 11);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

const tokensOf = (text: string) => Math.max(1, Math.ceil(text.length / 4));
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function startMockLlm(options: MockLlmOptions = {}): Promise<{
  url: string;
  port: number;
  token: string | undefined;
  calls: MockCall[];
  close: () => Promise<void>;
}> {
  const script = options.script ?? loadScript();
  const speed = options.speed ?? 1;
  const tickMs = speed > 0 ? 1000 / STREAM_HZ / speed : 0;
  const used = new Map<string, number>();
  const calls: MockCall[] = [];
  const log = (line: string) => {
    if (!options.quiet) console.log(`[mock-llm] ${line}`);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (options.token && req.headers.authorization !== `Bearer ${options.token}` && !url.pathname.startsWith("/__mock/")) {
      return json(401, { error: { message: "mock-llm: wrong token", type: "invalid_request_error" } });
    }
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      const scenarios = Array.from(new Set(script.rules.map((r) => r.scenario).filter(Boolean)));
      return json(200, { object: "list", data: ["default", ...scenarios].map((id) => ({ id: `mock/${id}`, object: "model", owned_by: "fhara-mock" })) });
    }
    if (req.method === "GET" && url.pathname === "/__mock/calls") return json(200, calls);
    if (req.method === "POST" && url.pathname === "/__mock/reset") {
      calls.length = 0;
      used.clear();
      return json(200, { ok: true });
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return json(404, { error: { message: `mock-llm: no route ${req.method} ${url.pathname}` } });

    let body: { model?: string; messages?: ChatMessage[]; stream?: boolean };
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
      });
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: { message: "mock-llm: body is not JSON" } });
    }
    const model = body.model ?? "mock/default";
    const header = req.headers["x-mock-scenario"];
    const scenario = (typeof header === "string" && header) || (model.startsWith("mock/") ? model.slice(5) : "") || options.scenario || "default";
    const text = textOf(body.messages ?? []);
    const { rule, reply } = pickRule(script, text, scenario, used);
    const status = rule?.status ?? 200;
    const call: MockCall = { n: calls.length + 1, at: Date.now(), model, scenario, rule: rule?.id ?? "fallback", role: rule?.role ?? "unknown", stream: Boolean(body.stream), status };
    calls.push(call);
    if (calls.length > 500) calls.shift();
    log(`#${call.n} ${call.role} (${call.rule}) scenario=${scenario}${call.stream ? " stream" : ""}${status !== 200 ? ` → ${status}` : ""}`);
    await sleep(speed > 0 ? (rule?.delayMs ?? 0) / speed : 0);

    if (status !== 200) {
      return json(status, { error: { message: reply || `mock-llm: scripted ${status}`, type: status === 429 ? "rate_limit_exceeded" : "mock_error" } });
    }
    const id = `chatcmpl-mock-${call.n}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: tokensOf(text), completion_tokens: tokensOf(reply), total_tokens: tokensOf(text) + tokensOf(reply) };
    if (!body.stream) {
      return json(200, {
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: reply, ...(rule?.reasoning ? { reasoning_content: rule.reasoning } : {}) }, finish_reason: "stop" }],
        usage,
      });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const frame = (delta: Record<string, unknown>, finish: string | null = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
    let closed = false;
    req.on("close", () => (closed = true));
    send(frame({ role: "assistant", content: "" }));
    for (const piece of chunkText(rule?.reasoning ?? "")) {
      if (closed) return;
      send(frame({ reasoning_content: piece }));
      await sleep(tickMs);
    }
    for (const piece of chunkText(reply)) {
      if (closed) return;
      send(frame({ content: piece }));
      await sleep(tickMs);
    }
    send({ ...frame({}, "stop"), usage });
    res.end("data: [DONE]\n\n");
  });

  // Loopback only: the mock must never be reachable from another machine.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    token: options.token,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // Fhara vars are read through the schema (@fhara/config), never ad hoc.
  const env = process.env;
  const port = Number(arg("port") ?? readVar("MOCK_LLM_PORT", env));
  const speed = Number(arg("speed") ?? readVar("MOCK_LLM_SPEED", env));
  const scriptPath = arg("script") ?? (readVar("MOCK_LLM_SCRIPT", env) as string | undefined) ?? DEFAULT_SCRIPT_PATH;
  const dataDir = path.resolve(arg("data-dir") ?? path.join(os.tmpdir(), "fhara-mock-llm"));
  const token = process.argv.includes("--no-token") ? undefined : crypto.randomBytes(24).toString("hex");
  const mock = await startMockLlm({ port, speed, script: loadScript(scriptPath), scenario: arg("scenario"), token, quiet: process.argv.includes("--quiet") });
  fs.mkdirSync(dataDir, { recursive: true });
  const info = path.join(dataDir, "mock-llm.json");
  fs.writeFileSync(info, JSON.stringify({ baseUrl: mock.url, port: mock.port, token: token ?? null, pid: process.pid }, null, 2) + "\n", { mode: 0o600 });
  console.log(`[mock-llm] listening on ${mock.url} (speed ${speed}, script ${path.relative(process.cwd(), scriptPath) || scriptPath})`);
  console.log(`[mock-llm] provider: kind "openai-compatible", base URL ${mock.url}, model mock/default (or mock/<scenario>)`);
  console.log(token ? `[mock-llm] API key written to ${info} (0600)` : "[mock-llm] --no-token: any API key is accepted");
  const stop = () => void mock.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[mock-llm] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
