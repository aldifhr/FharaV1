"use node";

import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  pickPrimaryConnection,
  resolveConnectionKey,
  type PoolConnectionPayload,
} from "./llmResolver";

/**
 * Read-only repo snapshot for chat replies (Plan 015 complement): gives
 * chat agents structural context (folder tree + key files) so structural
 * questions can be answered from evidence, not guesses. Confined to the
 * project workspace, no writes, no secrets, bounded size.
 */
const SNAPSHOT_SEGMENTS = new Set([
  "node_modules", ".git", ".next", "dist", "out", ".qa", ".turbo",
  "coverage", "build", ".convex", "_generated", ".openmausbot", ".vscode",
]);

function isSafeSnapshotPath(workspaceRoot: string, rel: string): boolean {
  if (!rel) return false;
  const segments = rel.split(/[\\/]/).filter(Boolean);
  if (segments.some((s) => s === ".." || s.startsWith("."))) return false;
  const base = workspaceRoot.replace(/[\\/]+$/, "");
  const full = `${base}/${rel.replace(/\\/g, "/")}`;
  return full.startsWith(base + "/") || full === base;
}

async function readRepoSnapshot(workspaceRoot: string): Promise<string> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(workspaceRoot);
  } catch {
    return "";
  }
  const lines: string[] = [];
  let total = 0;
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > 3 || total > 200) return;
    let entries: string[];
    try {
      entries = await fs.readdir(rel ? `${workspaceRoot}/${rel}` : workspaceRoot);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (total > 200) break;
      if (SNAPSHOT_SEGMENTS.has(name)) continue;
      const child = rel ? `${rel}/${name}` : name;
      if (!isSafeSnapshotPath(workspaceRoot, child)) continue;
      total += 1;
      const stat = await fs.stat(`${workspaceRoot}/${child}`).catch(() => null);
      const indent = "  ".repeat(depth);
      if (stat?.isDirectory()) {
        lines.push(`${indent}${name}/`);
        if (depth < 3) await walk(child, depth + 1);
      } else {
        lines.push(`${indent}${name}${stat ? ` (${stat.size}b)` : ""}`);
      }
    }
  }
  await walk("", 0);
  const keyFiles = ["package.json", "tsconfig.json", ".env.example", "README.md"];
  const heads: string[] = [];
  for (const keyFile of keyFiles) {
    try {
      const raw = await fs.readFile(`${workspaceRoot}/${keyFile}`, "utf8");
      heads.push(`--- ${keyFile} ---\n${raw.slice(0, 1200)}`);
    } catch {}
  }
  const tree = lines.slice(0, 200).join("\n");
  const rest = lines.length > 200 ? `\n… (${lines.length - 200} more)` : "";
  return `Workspace snapshot (${workspaceRoot}):\n${tree}${rest}\n\n${heads.join("\n\n")}`.trim();
}

export const getRepoSnapshot = action({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<string | null> => {
    const project = (await ctx.runQuery(internal.chatContext.getProjectPath, {
      projectId: args.projectId,
    })) as { workspacePath: string } | null;
    if (!project?.workspacePath) return null;
    return (await readRepoSnapshot(project.workspacePath)) || null;
  },
});

// Mirrored from packages/worker/src/router/route.ts (Convex cannot import
// worker code). The backend chat auto-dispatch must honor the same platform
// rule: questions, advice and analysis never become tasks.
const QUESTION_SHAPE =
  /\b(how do i|how to|how can|how does|why|what is|what are|what's|what does|what do|where is|explain|describe|summari[sz]e|document|understand)\b/i;
// "can you …" / "bisa …?" / "kamu bisa …?" — a question to the agent, not an
// order to build something. Was missing: the shape above only covered
// "can I …", so capability questions ("can you be CTO?") fell through to
// Stage B, where the LLM read "be CTO for the team" as execute_task.
const CONFIRMATION_SHAPE =
  /\b(can you|can u|are you able|bisa (nggak|ga|tidak)?|bisa kah|kamu bisa|apakah)\b/i;
const ADVICE_SHAPE =
  /\b(should i|recommend|best (practice|way)|suggest|advice|prefer)\b/i;
const EXPLICIT_NEGATION =
  /\b(do not|don't|dont|never)\b.*\b(create|make|start|run|execute|buat|bikin|jalankan)\b.*\btask\b|\b(jangan|tidak perlu)\b.*\btask\b/i;

/** Bare greetings/small talk — answered with a brief LLM persona reply on
 *  minimal context (no history, no planning guidance), so old topics cannot
 *  drag a full execution plan into a "hi". */
export const GREETING =
  /^(hi|hello|hey|halo|hai|yo|good (morning|afternoon|evening))[!.,?\s]*$/i;

export function classifyChatIntent(text: string): { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean } {
  const t = text.toLowerCase();
  const frontend = /\b(frontend|ui|react|component|page|button|css|tailwind)\b/.test(t);
  const backend = /\b(backend|api|server|database|auth|endpoint|convex)\b/.test(t);
  const testing = /\b(test|qa|e2e|bug|error)\b/.test(t);
  const security = /\b(security|audit|vulnerab|secret)\b/.test(t);

  // Explicit user instruction always wins: "do not create a task" must be
  // honored as chat even when the text contains change verbs.
  if (EXPLICIT_NEGATION.test(text)) {
    return { kind: "chat", frontend, backend, testing, security };
  }
  // Boundary guard (same as worker router): question/advice shapes never
  // become tasks, even when they contain a change verb. Capability/
  // confirmation questions ("can you be X?", "bisa kan?") belong here too.
  if (QUESTION_SHAPE.test(text) || ADVICE_SHAPE.test(text) || CONFIRMATION_SHAPE.test(text)) {
    return { kind: "chat", frontend, backend, testing, security };
  }
  // Read-only analysis without a change verb is chat (audit/research).
  const hasChangeVerb = /\b(buat|tambah|implement|build|create|fix|perbaiki|refactor|update|change|add|remove)\b/i.test(t);
  const isReadOnly = /\b(audit|review|research|investigate|analyze|analyse)\b/i.test(t);
  if (isReadOnly && !hasChangeVerb) {
    return { kind: "chat", frontend, backend, testing, security };
  }

  // If command contains impl keywords, treat as task regardless
  const impl = /\b(buatin|buat|tambah|implement|build|create|fix|perbaiki|refactor|update|change|add|remove|migrate|convert|scaffold|setup|install|pindah|konversi|pasang|sesuaikan)\b/.test(t);
  return { kind: impl ? "task" : "chat", frontend, backend, testing, security };
}

/**
 * LLM Intent Classifier (plan 016). Structured output mirrors the worker
 * router's IntentResult. Deterministic shapes are a fast path (greeting,
 * explicit negation, question/advice/confirmation); everything else goes here.
 * Invalid output fails closed to `ask`.
 */
export type IntentSubtype =
  | "explanation" | "recommendation" | "research" | "audit"
  | "implementation" | "debugging" | "testing"
  | "continue" | "pause" | "cancel" | "status" | "approve" | "reject"
  | "other";

export interface IntentResult {
  intent: "ask" | "task" | "continue" | "pause" | "cancel" | "status" | "approve" | "reject";
  subtype: IntentSubtype;
  requiresWorkspace: boolean;
  requiresExecution: boolean;
  target?: string;
  confidence: number;
  reasoning: string;
}

const INTENT_SUBTYPES: IntentSubtype[] = [
  "explanation", "recommendation", "research", "audit",
  "implementation", "debugging", "testing", "other",
];

export function parseIntentResult(raw: string): IntentResult | null {
  const text = raw.trim();
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const o = JSON.parse(json[0]) as Partial<IntentResult>;
    if (o.intent !== "ask" && o.intent !== "task") return null;
    const subtype: IntentSubtype = INTENT_SUBTYPES.includes(o.subtype as IntentSubtype)
      ? (o.subtype as IntentSubtype)
      : "other";
    if (typeof o.confidence !== "number") o.confidence = 0.5;
    o.confidence = Math.max(0, Math.min(1, o.confidence));
    return {
      intent: o.intent,
      subtype,
      requiresWorkspace: Boolean(o.requiresWorkspace),
      requiresExecution: o.intent === "task" ? true : Boolean(o.requiresExecution),
      target: typeof o.target === "string" ? o.target : undefined,
      confidence: o.confidence,
      reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    };
  } catch {
    return null;
  }
}

/**
 * Stage B — LLM Intent Classifier. Returns the structured IntentResult.
 * Invalid/unavailable output fails closed to `ask` (never a task).
 */
/**
 * CTO role selection for ASK (plan 016): the LLM picks the one conversational
 * agent whose role best answers the question (e.g. a styling question →
 * Frontend, a security question → Reviewer). Returns the agent id, or null
 * when the call fails / the reply is unparseable — the caller then falls
 * back to pickConversationalAgent. The pool excludes the orchestrator
 * roles; an explicit mention has already won before this chooser runs.
 */
async function chooseAskResponder(
  candidates: Array<{ _id: string; name: string; role: string; systemPrompt?: string }>,
  userText: string,
  config: { apiKey: string; provider: string; model: string; baseUrl: string }
): Promise<string | null> {
  if (candidates.length <= 1) return candidates.length === 1 ? String(candidates[0]._id) : null;
  const pool = candidates
    .map((a, i) => `${i + 1}. ${a.name} (${a.role}): ${(a.systemPrompt ?? "").slice(0, 120)} [id ${a._id}]`)
    .join("\n");
  const prompt = [
    "You are the CTO picking which single teammate best answers this chat question. Choose the role whose expertise matches the question topic (e.g. styling/UI → Frontend, security/audit → Reviewer, server/deploy → DevOps/Backend).",
    "Return ONLY JSON with this exact schema:",
    `{"agentId":"<id from [id ...]>"}`,
    "",
    `Candidates:\n${pool}`,
    "",
    `Question: ${userText.length > 500 ? userText.slice(0, 500) + "..." : userText}`,
  ].join("\n");
  const raw = await completeWithAgent("Pick one conversational agent. Return JSON only.", [{ role: "user", content: prompt }], config)
    .then((result) => result.content)
    .catch(() => "");
  return parseResponderSelection(raw, candidates.map((a) => String(a._id)));
}

async function classifyIntent(
  text: string,
  config: { apiKey: string; provider: string; model: string; baseUrl: string },
  activeTask?: { title: string; status: string } | null
): Promise<IntentResult | null> {
  const prompt = [
    "You are an intent classifier for a software engineering workspace.",
    "Return ONLY JSON with this exact schema:",
    `{"intent":"ask"|"task","subtype":"explanation"|"recommendation"|"research"|"audit"|"implementation"|"debugging"|"testing"|"other","requiresWorkspace":bool,"requiresExecution":bool,"target":"?","confidence":0..1,"reasoning":"..."}`,
    "",
    "Choose `task` when the user wants the AI team to DO work (build, fix, test, refactor, migrate). Choose `ask` for pure questions/discussion. Subtypes: explanation/recommendation/research/audit ask; implementation/debugging/testing task.",
    "",
    "The text may be Indonesian, English, mixed, or informal. Judge by meaning, not by word list.",
    "",
    `User text: ${text.length > 500 ? text.slice(0, 500) + "..." : text}`,
    activeTask ? `Active task: ${activeTask.title} [${activeTask.status}]` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const raw = await completeWithAgent("Classify intent. Return JSON only.", [{ role: "user", content: prompt }], config)
    .then((result) => result.content)
    .catch(() => "");
  return parseIntentResult(raw);
}

function buildPlanningGuidance(agent: { role: string }, opts: { isOrchestrator: boolean; taskIntent: { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean } }): string[] {
  if (opts.isOrchestrator && opts.taskIntent.kind === "task") {
    return [
      "You are the orchestrator/planner (CTO).",
      "Propose a brief plan in 2-3 plain-language sentences: what will be done first, who will do each part (delegation), and how you will check it. No bullets, no numbered plan, no terminal output, no headers.",
      "End with one short sentence in plain words: 'To execute this plan, klik Create task — saya akan delegasikan ke agent yang sesuai.'",
      "Do not pretend to have executed code. Detail (files, order, validation, technical steps) lives in the task the worker runs, not in chat.",
    ];
  }
  if (opts.isOrchestrator) {
    return [
      "You are the orchestrator/planner.",
      "Greetings and small talk get a brief greeting back — never a plan, delegation, or mention list for a bare hello.",
      "Answer briefly. If user asks for work to be done, propose a plan + delegation, then tell them to use Create task. Do not pretend to have executed code. Respond in plain text.",
    ];
  }
  return [
    "Answer the user's chat message helpfully and completely from your perspective in the same language as the user.",
    "You can answer structural questions (architecture, folders, features) from the repo snapshot given when present — cite actual paths you see there. You still cannot run commands, modify files, or read beyond the snapshot.",
    "For anything that needs workspace access (audit, review, run code), tell the user to Create task so the worker (which CAN read the workspace) can do it.",
    "Do not pretend to have executed code. Respond in plain text.",
  ];
}

/** Answer Engine guidance per intent subtype (plan 016). */
function buildAnswerGuidance(subtype: IntentSubtype): string[] {
  switch (subtype) {
    case "explanation":
      return ["Explain completely in the user's language: give the concrete code/config that answers the question, why it fits this project, and cite actual paths from the snapshot when present. For anything needing workspace access beyond the snapshot, tell the user to Create task so the worker (which can read the workspace) can do it."];
    case "recommendation":
      return ["Recommend one concrete option with a brief rationale in the user's language. No plan, no delegation."];
    case "research":
      return ["Answer from evidence, completely: give the concrete details (code/config/steps), cite actual paths from the snapshot when present. No speculation, no execution."];
    case "audit":
      return ["Give a read-only audit: findings with severity and file refs. Do not modify anything."];
    default:
      return [];
  }
}

/** One conversational agent for every ASK (plan 016). The CTO/Orchestrator
 *  owns TASK; their functions stay separate. Prefer a general-purpose
 *  agent (General/Assistant), then Researcher, then Support — never
 *  Product Analyst (requirement-focused) or a coding role. An explicit
 *  mention (the user routed to the CTO by @CTO) always wins. This is the
 *  deterministic fallback when the CTO chooser (below) is unavailable.
 *  Exported for unit tests. */
export function pickConversationalAgent(
  agents: Array<{ _id: string; name: string; role: string; systemPrompt?: string }>
): Array<{ _id: string; name: string; role: string; systemPrompt?: string }> {
  const notCto = agents.filter((a) => !/(cto|architect|lead|orchestrator|planner|manager)/i.test(a.role));
  if (notCto.length === 0) return agents; // user mentioned the CTO explicitly
  const general = notCto.find((a) => /^(general|assistant)/i.test(a.role));
  if (general) return [general];
  const researcher = notCto.find((a) => /^researcher/i.test(a.role));
  if (researcher) return [researcher];
  const support = notCto.find((a) => /^support/i.test(a.role));
  if (support) return [support];
  return [notCto[0]];
}

/** Parse the CTO chooser's reply: the chosen candidate id, or null. */
export function parseResponderSelection(raw: string, candidateIds: string[]): string | null {
  const text = raw.trim();
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const o = JSON.parse(json[0]) as { agentId?: unknown };
    return typeof o.agentId === "string" && candidateIds.includes(o.agentId) ? o.agentId : null;
  } catch {
    return null;
  }
}

/** Shared guidance: machine-readable choice blocks for clickable cards.
 *  Only when the user genuinely needs to pick between alternatives (e.g.
 *  asked for options, a recommendation, or a decision between designs).
 *  Never for capability questions, explanations, greetings, or status. */
const OPTIONS_GUIDANCE =
  "Only use an options block when the user is choosing between concrete alternatives (asked for options/a recommendation/a decision between designs). Never use it for capability questions, explanations, greetings, status reports, or task updates — answer those plainly. Format when used, exactly:\n[options]\nA|Short title|One-line summary|sheet\nB|Short title|One-line summary|bold\n[/options]\nPreview styles: sheet (three-column layout), bold (highlighted center card), rows (stacked list), plain (none). Keep it to ONE block per reply, then stop.\nBase the options on the user's CURRENT request only — do not carry over past tasks, files, or topics from earlier in this conversation unless the user asks for them personally. Keep your reply before the block to one short sentence: no plan summary, no delegation talk, no 'Create task' instructions. A pick is an opinion, not an order — do not start execution yourself.\nWhen the user picks one of your options, reply starting with 'I agree' if you endorse the choice, or explain your objection and why.";

export interface StreamChunk {
  content: string;
  reasoning: string;
}

export interface CompleteResult {
  content: string;
  reasoning: string;
  reasoningDurationMs: number;
}

async function completeWithAgent(
  system: string,
  history: { role: string; content: string }[],
  globalConfig: { provider: string; model: string; baseUrl: string; apiKey: string },
  onChunk?: (partial: StreamChunk) => void,
): Promise<CompleteResult> {
  const { provider, model, baseUrl, apiKey } = globalConfig;
  if (!apiKey) throw new Error("No LLM API key configured. Add a provider in Settings (LLM) or set LLM_API_KEY in Convex env");

  const messages = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const doFetch = async (url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok && res.status >= 500 && timeoutMs > 0) {
        // One lightweight retry for transient 5xx (no backoff explosion).
        const res2 = await fetch(url, { ...init, signal: ctrl.signal });
        if (res2.ok) return res2;
        return res2;
      }
      return res;
    } catch (error) {
      // The gateway sometimes takes longer than the old 30s to answer; a
      // raw AbortError reads as "This operation was aborted" in the UI.
      if (ctrl.signal.aborted) {
        throw new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const startedAt = Date.now();
  const finish = (content: string, reasoning: string): CompleteResult => {
    onChunk?.({ content, reasoning });
    return { content, reasoning, reasoningDurationMs: reasoning ? Date.now() - startedAt : 0 };
  };
  // Stream the SSE body incrementally so the UI sees tokens as they arrive.
  // The previous implementation buffered the whole body with res.text()
  // first, which made the "streaming" patch the message only after the LLM
  // finished — the bubble sat empty (avatar + name only) until a refresh.
  const consumeSse = async (
    res: Response,
    onDataLine: (payload: string) => void,
  ): Promise<string> => {
    let raw = "";
    const reader = res.body?.getReader();
    if (!reader) {
      // No streaming support: fall back to reading the whole body.
      raw = await res.text();
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        onDataLine(payload);
      }
      return raw;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    // Bound the whole stream so a hung provider cannot stall the action
    // past the Convex timeout (which leaves the bubble on "Thinking").
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("LLM stream timed out (120s)");
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        onDataLine(payload);
      }
    }
    // Flush a final line that arrived without a trailing newline.
    if (buffer.startsWith("data:")) {
      const payload = buffer.slice(5).trim();
      if (payload && payload !== "[DONE]") onDataLine(payload);
    }
    return raw;
  };
  // Some gateways return a plain JSON body with a `text/event-stream` header.
  // SSE parsing then yields no content; fall back to JSON.
  const parseJsonFallback = (raw: string): { content: string; reasoning: string } => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return { content: "", reasoning: "" };
    try {
      const data: any = JSON.parse(trimmed);
      const message = data.choices?.[0]?.message ?? {};
      const content = typeof message.content === "string" ? message.content : "";
      const reasoning =
        typeof message.reasoning === "string"
          ? message.reasoning
          : Array.isArray(message.reasoning_details)
            ? message.reasoning_details.map((d: any) => (typeof d === "string" ? d : d?.text ?? "")).join("")
            : "";
      return { content, reasoning };
    } catch {
      return { content: "", reasoning: "" };
    }
  };

  if (provider === "openai" || provider === "openai-compatible") {
    const base = baseUrl.replace(/\/$/, "");
    const res = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Non-streaming fallback (some proxies ignore stream:true).
      const text = await res.text();
      const normalized = text.replace(/(?:\r?\n)?data:\s*\[DONE\]\s*$/, "").trim();
      if (!normalized) return finish("", "");
      try {
        const data: any = JSON.parse(normalized);
        const c = data.choices?.[0]?.message?.content;
        // Never use reasoning trace as user-facing answer.
        if (typeof c === "string" && c.trim()) return finish(c, "");
        return finish(c ?? "", "");
      } catch {
        const parts: string[] = [];
        let reasoning = "";
        for (const line of normalized.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const d: any = JSON.parse(payload);
            const delta = d.choices?.[0]?.delta ?? {};
            if (typeof delta.content === "string") parts.push(delta.content);
            if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
            if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
          } catch {}
        }
        if (parts.length) return finish(parts.join(""), reasoning);
        throw new Error(`LLM returned non-JSON response`);
      }
    }
    let content = "";
    let reasoning = "";
    const raw = await consumeSse(res, (payload) => {
      try {
        const d: any = JSON.parse(payload);
        const delta = d.choices?.[0]?.delta ?? {};
        if (typeof delta.content === "string") content += delta.content;
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
        onChunk?.({ content, reasoning });
      } catch {}
    });
    if (!content && !reasoning) {
      const fallback = parseJsonFallback(raw);
      content = fallback.content;
      reasoning = fallback.reasoning;
    }
    return finish(content, reasoning);
  }

  // anthropic
  const base = baseUrl.replace(/\/$/, "");
  const res = await doFetch(`${base}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: system || undefined,
      messages,
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data: any = await res.json();
    return finish(
      (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
      "",
    );
  }
  let content = "";
  let reasoning = "";
  const raw = await consumeSse(res, (payload) => {
    try {
      const d: any = JSON.parse(payload);
      if (d.type === "content_block_delta" && d.delta?.type === "text_delta" && typeof d.delta.text === "string") {
        content += d.delta.text;
      }
      if (d.type === "content_block_delta" && d.delta?.type === "thinking_delta" && typeof d.delta.thinking === "string") {
        reasoning += d.delta.thinking;
      }
      onChunk?.({ content, reasoning });
    } catch {}
  });
  if (!content && !reasoning) {
    const fallback = parseJsonFallback(raw);
    content = fallback.content;
    reasoning = fallback.reasoning;
  }
  return finish(content, reasoning);
}

function getGlobalLLMConfig(): { provider: string; model: string; baseUrl: string; apiKey: string } {
  const env: Record<string, string | undefined> =
    (globalThis as any).process?.env ?? {};
  const provider = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  return {
    provider,
    model: env.LLM_MODEL ?? (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514"),
    baseUrl: provider === "openai"
      ? (env.LLM_OPENAI_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.openai.com/v1")
      : (env.LLM_ANTHROPIC_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.anthropic.com/v1"),
    apiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? "",
  };
}

/**
 * Resolve the chat LLM config from the shared provider pool (llmResolver).
 * Respects per-agent assignment when the agent carries one (llmProviderId +
 * llmModelId): that connection+model wins; otherwise fall back to the primary
 * connection (lowest priority with an available model). The key is decrypted
 * here on the backend for the backend's own call — a decryption failure is a
 * hard error naming the provider — with the connection's `apiKeyEnv` env var
 * as fallback.
 */
async function resolveConfigFromProviders(
  providers: PoolConnectionPayload[] | undefined,
  fallback: { provider: string; model: string; baseUrl: string; apiKey: string },
  agent?: { llmProviderId?: string; llmModelId?: string; llmFallbackProviderId?: string; llmFallbackModelId?: string; llmSelectionPolicy?: string }
): Promise<{ provider: string; model: string; baseUrl: string; apiKey: string }> {
  if (providers && agent?.llmProviderId) {
    const conn = providers.find((p) => String(p._id) === String(agent.llmProviderId));
    if (conn) {
      const model =
        conn.models.find((m) => String(m._id) === String(agent.llmModelId)) ??
        conn.models.find((m) => m.isAvailable) ??
        conn.models[0];
      if (model) {
        const key = await resolveConnectionKey(conn);
        return {
          provider: conn.provider.toLowerCase(),
          model: model.modelId,
          baseUrl: conn.baseUrl,
          apiKey: key || fallback.apiKey,
        };
      }
    }
  }
  const pick = providers ? pickPrimaryConnection(providers) : null;
  if (pick) {
    const key = await resolveConnectionKey(pick.connection);
    return {
      provider: pick.connection.provider.toLowerCase(),
      model: pick.model.modelId,
      baseUrl: pick.connection.baseUrl,
      apiKey: key || fallback.apiKey,
    };
  }
  return fallback;
}

export const replyToChat = internalAction({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
    userMessageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    // Concurrency guard: check if this message was already answered
    const alreadyReplied = await ctx.runQuery(internal.chatContext.checkAlreadyReplied, {
      userMessageId: args.userMessageId,
    });
    if (alreadyReplied) return;

    const data = (await ctx.runQuery(internal.chatContext.getContext, {
      projectId: args.projectId,
      conversationId: args.conversationId,
      preferredAgentIds: args.preferredAgentIds,
    })) as {
      agents: Array<{
        _id: string;
        name: string;
        role: string;
        systemPrompt?: string;
      }>;
      team?: Array<{
        _id: string;
        name: string;
        role: string;
        systemPrompt?: string;
      }>;
      projectName: string;
      history: { authorType: string; content: string }[];
      contextSummary?: string;
      activeTask?: { title: string; status: string } | null;
      llmProviders?: PoolConnectionPayload[];
    };

    const { agents, team: teamAgents, projectName, history, llmProviders } = data;
    const globalConfig = await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig());

    // Repo snapshot (read-only, workspace-confined) so structural chat
    // questions ("how is this repo structured?") can be answered from
    // evidence instead of guesses.
    const repoSnapshot: string | null = await (async () => {
      try {
        const projectPath = await ctx.runQuery(internal.chatContext.getProjectPath, {
          projectId: args.projectId,
        });
        const workspacePath = (projectPath as { workspacePath?: string } | null)?.workspacePath;
        if (!workspacePath) return null;
        return (await readRepoSnapshot(workspacePath)) || null;
      } catch {
        return null;
      }
    })();

    if (agents.length === 0) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        conversationId: args.conversationId,
        content: "No enabled agents are participating in this conversation. Add agents to the project team and select them for chat.",
        replyToMessageId: args.userMessageId,
      });
      return;
    }

    const conversation = history.map((m) => ({
      role: m.authorType === "agent" ? "assistant" : "user",
      content: m.content,
    }));
    // Plan 006 Phase 3: prompt builder uses summary + last 12. The summary
    // carries the compacted tail so the LLM keeps bounded context.
    if (data.contextSummary) {
      conversation.unshift({
        role: "system",
        content: `Conversation summary: ${data.contextSummary}`,
      });
    }

    // Only an agent whose ROLE is cto/lead/orchestrator/planner may act as
    // the orchestrator (legacy "architect" accepted for backward compat).
    // Falling back to agents[0] made any selected agent
    // introduce itself as "the orchestrator/planner" while still naming its own
    // role (e.g. "frontend developer ... I'm the orchestrator/planner").
    const orchestrator =
      agents.find((a) => /cto|architect/i.test(a.role)) ??
      null;
    // The dispatcher creates the task row. It may be the orchestrator, or the
    // first agent when the project has no CTO — but a non-orchestrator
    // never receives planning guidance.
    const dispatcher = orchestrator ?? agents[0];

    // Streaming persist helper: create the agent message row first, then
    // patch content/reasoning as SSE chunks arrive so the UI shows the
    // bubble + "Thinking" trace live. Patches are throttled to avoid a
    // mutation per token.
    const streamReplyToAgent = async (
      agentId: Id<"agents">,
      config: { apiKey: string; provider: string; model: string; baseUrl: string },
      system: string,
      msgs: { role: string; content: string }[],
    ): Promise<CompleteResult> => {
      const messageId = await ctx.runMutation(internal.chatContext.createStreamingAgentMessage, {
        projectId: args.projectId,
        agentId: agentId as any,
        conversationId: args.conversationId,
        replyToMessageId: args.userMessageId,
      });
      let lastPatchAt = 0;
      const result = await completeWithAgent(system, msgs, config, ({ content, reasoning }) => {
        const now = Date.now();
        if (now - lastPatchAt < 250 || (!content.trim() && !reasoning.trim())) return;
        lastPatchAt = now;
        void ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
          messageId: messageId as any,
          content,
          reasoning: reasoning || undefined,
        }).catch(() => {});
      });
      await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
        messageId: messageId as any,
        content: result.content,
        reasoning: result.reasoning || undefined,
        reasoningDurationMs: result.reasoningDurationMs || undefined,
      });
      return result;
    };

    // Greeting fast-path: a bare "hi" gets a brief LLM persona reply on
    // minimal context (no history, no planning guidance) — previous task
    // commands must not drag an old topic into a full execution plan.
    // ONE conversational agent answers, not the whole team: fanning out to
    // every agent made 12 sequential LLM calls and blew the action timeout,
    // leaving the first bubble stuck on "Thinking" forever.
    const lastContent = history[history.length - 1]?.content ?? "";
    if (GREETING.test(lastContent.trim())) {
      const greetingHistory = [{ role: "user", content: lastContent.trim() }];
      for (const agent of pickConversationalAgent(teamAgents ?? agents)) {
        let content: string;
        try {
          const perAgentConfig = await resolveConfigFromProviders(
            llmProviders,
            globalConfig,
            agent as any
          );
          const result = await streamReplyToAgent(
            agent._id as any,
            perAgentConfig,
            [
              `You are ${agent.name}, a ${agent.role} on the agent team of project "${projectName}".`,
              "You are NOT the underlying LLM model. Never name the model (e.g. \"Crouton Alpha\") or claim to be the provider — always answer as your assigned role.",
              agent.systemPrompt ?? "",
              "Greet the user briefly in your own persona, same language as the user. One short sentence, no plan, no delegation, no Create task instructions.",
            ]
              .filter(Boolean)
              .join("\n"),
            greetingHistory,
          );
          content = result.content;
        } catch (err: any) {
          console.error("Greeting reply failed:", err?.message ?? err);
          continue;
        }
        if (content.trim()) {
          conversation.push({ role: "assistant", content: content.trim() });
        }
      }
      return;
    }

    // Option picks are conversation, not orders: a bare design question
    // followed by a choice must NOT auto-create execution tasks (the user
    // was just asking). The pick is answered in chat; the user asks for
    // work explicitly when they want it built.
    const isOptionPick = /^i choose ([a-z0-9]+)\s*:\s*(.+)$/i.test(lastContent.trim());

    // Plan 016: LLM Intent Classifier with structured output. Deterministic
    // shapes are a fast path; the classifier decides the ambiguous rest and
    // fails closed to `ask` — a classifier can enable a *chat* answer, never
    // silently create a task.
    const lastUserContent = history[history.length - 1]?.content ?? "";
    const fast = classifyChatIntent(lastUserContent);
    const fastIsAsk =
      EXPLICIT_NEGATION.test(lastUserContent) ||
      QUESTION_SHAPE.test(lastUserContent) ||
      ADVICE_SHAPE.test(lastUserContent) ||
      CONFIRMATION_SHAPE.test(lastUserContent);
    let intent: IntentResult;
    // Active task for router context: read the project's running/queued task.
    let activeTaskForRouter: { title: string; status: string } | null = null;
    try {
      const rows = await ctx.runQuery(internal.chatContext.getActiveTask, {
        projectId: args.projectId,
      });
      if (rows) activeTaskForRouter = rows;
    } catch {
      /* best-effort */
    }
    if (isOptionPick) {
      intent = {
        intent: "ask",
        subtype: "recommendation",
        requiresWorkspace: false,
        requiresExecution: false,
        confidence: 1,
        reasoning: "option pick",
      };
    } else if (fast.kind === "task" && !fastIsAsk) {
      intent = {
        intent: "task",
        subtype: "implementation",
        requiresWorkspace: true,
        requiresExecution: true,
        confidence: 1,
        reasoning: "deterministic change request",
      };
    } else if (fastIsAsk) {
      intent = {
        intent: "ask",
        subtype: "explanation",
        requiresWorkspace: false,
        requiresExecution: false,
        confidence: 1,
        reasoning: "deterministic question shape",
      };
    } else {
      const classified = await classifyIntent(lastUserContent, globalConfig, activeTaskForRouter);
      intent =
        classified ??
        ({
          intent: "ask",
          subtype: "explanation",
          requiresWorkspace: false,
          requiresExecution: false,
          confidence: 0.5,
          reasoning: "classifier unavailable; safe ask fallback",
        } as IntentResult);
    }
    // Back-compat: the chat loop below still reads `taskIntent`.
    const taskIntent = {
      ...fast,
      kind: intent.intent === "task" ? "task" : "chat",
      subtype: intent.subtype,
      requiresWorkspace: intent.requiresWorkspace,
      requiresExecution: intent.requiresExecution,
    };

    // Lifecycle intents act on the active task instead of chatting.
    if (["continue", "pause", "cancel", "status", "approve", "reject"].includes(intent.intent)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { api: apiRef } = await import("./_generated/api.js") as any;
      const activeId = await ctx.runQuery(internal.chatContext.getActiveTaskId, { projectId: args.projectId });
      const activeTask = activeId ? await ctx.runQuery(apiRef.tasks.get, { taskId: activeId as never }) : null;
      const terminal = ["done", "rejected", "failed"].includes(activeTask?.status ?? "");
      if (intent.intent === "cancel" && activeTask && !terminal) {
        await ctx.runMutation(apiRef.tasks.cancel, { taskId: activeId as never });
        return;
      }
      if (intent.intent === "continue" && activeTask) {
        await ctx.runMutation(apiRef.tasks.steerTask, { taskId: activeId as never, instruction: lastUserContent });
        return;
      }
      if (intent.intent === "status" && activeTask) {
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: args.projectId,
          conversationId: args.conversationId,
          content: `Task "${activeTask.title}" is ${activeTask.status}.`,
          replyToMessageId: args.userMessageId,
        });
        return;
      }
      if (intent.intent === "approve" || intent.intent === "reject") {
        const pending = await ctx.runQuery(apiRef.approvals.listPendingAll, {});
        const target = (pending as any[]).find((a) => a.status === "pending" && a.projectId === args.projectId);
        if (target) {
          if (intent.intent === "approve") {
            await ctx.runMutation(apiRef.approvals.approve, { approvalId: target._id });
          } else {
            await ctx.runMutation(apiRef.approvals.reject, { approvalId: target._id });
          }
          return;
        }
      }
      // Fall through to chat for anything unmatched.
    }

    // Auto-dispatch: a task intent creates the task row and skips the chat loop.
    // Idempotent per message: the same user message can only create one task.
    if (intent.intent === "task") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { api: idemApi } = await import("./_generated/api.js") as any;
      const existing = await (ctx as any).runQuery(idemApi.tasks.listByProject, { projectId: args.projectId });
      const dupe = (existing as any[]).find(
        (t: any) =>
          t.command === lastUserContent &&
          !["done", "rejected", "failed"].includes(t.status)
      );
      if (dupe) {
        return; // already dispatched; UI shows the task
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { api } = await import("./_generated/api.js") as any;
        // create task (public mutation) — will be picked up by worker
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const taskId = await (ctx as any).runMutation(api.tasks.createFromCommand, {
          projectId: args.projectId,
          command: lastUserContent,
          title: lastUserContent.slice(0, 80),
        });
        // Silent auto-dispatch: the UI surfaces task creation (toast,
        // task card) — a chat message here is noise the user does not want.
        return; // skip normal chat reply loop
      } catch (e: any) {
        console.error("Auto-dispatch failed:", e?.message ?? e);
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: args.projectId,
          agentId: dispatcher._id as any,
          conversationId: args.conversationId,
          content: `I couldn't create the task (${e?.message ?? "unknown error"}). Please try again or create the task manually.`,
          replyToMessageId: args.userMessageId,
        });
        return; // do not pretend execution is running
      }
    }
    // Intelligent Router (Fast Router):
    // - Multiple @mentions → sequential multi-agent replies in the user's
    //   order (FIFO per agent). The conversation context is appended to the
    //   SAME array, so later mentions answer after the earlier replies.
    // - A single mention or no mention → the conversational agent (ASK) /
    //   orchestrator (TASK). Pure questions get the cheapest adequate agent.
    const mentionedAgents = (args.preferredAgentIds ?? [])
      .map((id) => agents.find((a) => a._id === String(id)))
      .filter((a): a is (typeof agents)[number] => Boolean(a));
    let responders: typeof agents;
    if (intent.intent === "ask" && !isOptionPick) {
      if (mentionedAgents.length > 0) {
        responders = mentionedAgents;
      } else {
        const pool = (teamAgents ?? agents).filter(
          (a) => !/(cto|architect|lead|orchestrator|planner|manager)/i.test(a.role)
        );
        const pickedId = await chooseAskResponder(
          pool as Array<{ _id: string; name: string; role: string; systemPrompt?: string }>,
          lastUserContent,
          await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig())
        );
        const picked = pickedId ? pool.filter((a) => String(a._id) === pickedId) : [];
        responders = (picked.length ? picked : pickConversationalAgent(teamAgents ?? agents)) as typeof agents;
      }
    } else {
      responders = agents;
    }
    // Sequential multi-agent replies: each selected agent answers with its persona
    for (const agent of responders) {
      const multiNotice = responders.length > 1
        ? ` You are participating in a multi-agent discussion with: ${responders.map((a) => `${a.name} (${a.role})`).join(", ")}.`
        : "";
      const system = [
        `You are ${agent.name}, a ${agent.role} on the agent team of project "${projectName}".${multiNotice}`,
        "You are NOT the underlying LLM model. Never name the model (e.g. \"Crouton Alpha\") or claim to be the provider — always answer as your assigned role.",
        agent.systemPrompt ?? "",
        repoSnapshot
          ? `Your chat replies are grounded in this repo snapshot (read-only, provided by the host):\n${repoSnapshot}\nYou still cannot run commands or read other files; for anything deeper, ask the user to Create a task.`
          : "",
        ...(intent.intent === "ask" ? buildAnswerGuidance(intent.subtype) : []),
        ...buildPlanningGuidance(agent, {
          isOrchestrator: orchestrator !== null && agent._id === orchestrator._id,
          taskIntent,
        }),
        OPTIONS_GUIDANCE,
      ]
        .filter(Boolean)
        .join("\n");

      const systemWithContext = [
        system,
        conversation.length > 0
          ? `Conversation so far (follow this order):\n${conversation.map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      let content: string;
      try {
        const perAgentConfig = await resolveConfigFromProviders(
          llmProviders,
          getGlobalLLMConfig(),
          agent as any
        );
        const result = await streamReplyToAgent(
          agent._id as any,
          perAgentConfig,
          systemWithContext,
          conversation,
        );
        content = result.content;
      } catch (err: any) {
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: args.projectId,
          agentId: agent._id as any,
          conversationId: args.conversationId,
          content: `I couldn't reply (${err.message}). Check global LLM settings.`,
          replyToMessageId: args.userMessageId,
        });
        continue;
      }

      if (content.trim()) {
        // Append response to conversation so subsequent agents have context
        conversation.push({ role: "assistant", content: content.trim() });
      }
    }
  },
});
