/**
 * Context Snapshot: what one LLM call actually saw.
 *
 * Pure helpers shared by the worker (task LLM calls), the Convex chat reply
 * loop and the Context Inspector (web). Nothing here touches the database or
 * the network.
 *
 *  - splitPromptSections: the call's messages → labelled sections (system
 *    persona, shared instructions, skills, memory, conversation history, tool
 *    definitions, task context / contract, user message).
 *  - redactSecrets: masks API keys, tokens, private keys and `key=value`
 *    secrets anywhere in the text (unanchored, unlike the worker's
 *    whole-value maskStringSecrets, which the worker still runs first).
 *  - capSections / capText: per-section and total byte caps with explicit
 *    truncation markers, so one huge prompt can never bloat the table.
 *  - buildContextSnapshot: everything above in one call → the light meta row
 *    plus the heavy body (stored in a separate table).
 */
import { cenv } from "@fhara/config/convex";
import { settingEnvSource } from "./appSettings";

export const SECTION_KEYS = [
  "system",
  "shared",
  "skills",
  "memory",
  "history",
  "tools",
  "task",
  "user",
  "volatile",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  system: "System persona",
  shared: "Shared instructions",
  skills: "Skills",
  memory: "Memory",
  history: "Conversation history",
  tools: "Tool definitions",
  task: "Task context / contract",
  user: "User message",
  volatile: "Runtime context (volatile tail)",
};

/** What the call was for. */
export const CALL_ROLES = [
  "executor",
  "planner",
  "decision",
  "reviewer",
  "qa",
  "chat",
  "chat_tool_step",
  "playground",
  "commit",
  "memory",
] as const;
export type CallRole = (typeof CALL_ROLES)[number];

export const CALL_ROLE_LABELS: Record<CallRole, string> = {
  executor: "Executor",
  planner: "Planner",
  decision: "Decision",
  reviewer: "Reviewer",
  qa: "QA",
  chat: "Chat reply",
  chat_tool_step: "Chat repo-tool step",
  playground: "Playground",
  commit: "Commit message",
  memory: "Memory suggestions",
};

export interface PromptMessage {
  role: string;
  content: string;
}

export interface SnapshotSection {
  key: SectionKey;
  label: string;
  content: string;
  /** Characters cut by the caps (0 when whole). */
  truncatedChars?: number;
}

export interface SectionStat {
  key: SectionKey;
  label: string;
  chars: number;
  tokens: number;
  truncated?: boolean;
}

/** Per-section and total caps (bytes ≈ chars for the mostly-ASCII prompts). */
export const SNAPSHOT_SECTION_CAP = 24 * 1024;
export const SNAPSHOT_TOTAL_CAP = 64 * 1024;
export const SNAPSHOT_RESPONSE_CAP = 16 * 1024;
export const SNAPSHOT_ERROR_CAP = 2 * 1024;
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 14;
export const MAX_SNAPSHOT_RETENTION_DAYS = 365;

/** Global kill switch: CONTEXT_SNAPSHOTS=0 (or false/off) disables recording everywhere. */
export function contextSnapshotsEnabled(env: Record<string, string | undefined> = readEnv()): boolean {
  return cenv("CONTEXT_SNAPSHOTS", env); // falsy list, default on
}

function readEnv(): Record<string, string | undefined> {
  // The worker applies Settings overrides (lib/appSettings.ts); a Convex
  // isolate has none and reads its own env (the record mutation checks the
  // stored setting itself).
  return settingEnvSource();
}

/** Rough token estimate (chars/4), the same rule the worker uses for missing usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// ── Redaction ───────────────────────────────────────────────────────────

// Patterns and the redactor live in ./secretPatterns (shared with the worker).
import { redactSecrets } from "./secretPatterns";
export { redactSecrets };

// ── Caps ────────────────────────────────────────────────────────────────

export function truncationMarker(cut: number): string {
  return `\n…[truncated ${cut.toLocaleString("en-US")} chars]`;
}

/** Keep the head of `text` within `cap` chars, marker included. */
export function capText(text: string, cap: number): { text: string; truncatedChars: number } {
  if (text.length <= cap) return { text, truncatedChars: 0 };
  // Reserve room for the marker so the result stays within the cap.
  const marker = truncationMarker(text.length);
  const keep = Math.max(0, cap - marker.length);
  const cut = text.length - keep;
  return { text: text.slice(0, keep) + truncationMarker(cut), truncatedChars: cut };
}

/**
 * Cap every section at `perSection`, then fit the total under `total` by
 * water-filling: small sections stay whole, the largest share the rest.
 */
export function capSections(
  sections: SnapshotSection[],
  perSection = SNAPSHOT_SECTION_CAP,
  total = SNAPSHOT_TOTAL_CAP
): SnapshotSection[] {
  const lengths = sections.map((s) => Math.min(s.content.length, perSection));
  let budget = total;
  const allowed = new Array<number>(sections.length).fill(0);
  const order = lengths.map((len, index) => ({ len, index })).sort((a, b) => a.len - b.len);
  let remaining = order.length;
  for (const { len, index } of order) {
    const share = Math.floor(budget / remaining);
    const give = Math.min(len, share);
    allowed[index] = give;
    budget -= give;
    remaining -= 1;
  }
  return sections.map((section, index) => {
    const original = section.content;
    const previous = section.truncatedChars ?? 0;
    if (original.length <= allowed[index]) return { ...section, truncatedChars: previous || undefined };
    const capped = capText(original, Math.max(allowed[index], 0));
    return { ...section, content: capped.text, truncatedChars: previous + capped.truncatedChars };
  });
}

// ── Section split ───────────────────────────────────────────────────────

const HEADING = /^#{2,3}\s+(.+)$/;

function classifyHeading(title: string): SectionKey {
  const t = title.trim().toLowerCase();
  if (t.startsWith("skill:") || t === "skills") return "skills";
  if (t === "memory" || t.startsWith("memory")) return "memory";
  if (t.includes("tool")) return "tools";
  if (t.startsWith("contract") || t.startsWith("acceptance") || t.startsWith("task")) return "task";
  return "shared";
}

function classifyParagraph(paragraph: string, fallback: SectionKey): SectionKey {
  const head = paragraph.trimStart().slice(0, 200).toLowerCase();
  // D4: the time line closes the last user turn (lib/timeContext.ts).
  if (/^current time: \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(/.test(head)) return "volatile";
  if (head.startsWith("project instructions (agents.md")) return "shared";
  if (
    head.startsWith("shared task context:") ||
    head.startsWith("previous subtask outputs:") ||
    head.startsWith("files already changed by earlier subtasks") ||
    head.startsWith("contract for this subtask:") ||
    head.startsWith("acceptance") ||
    head.startsWith("repo snapshot") ||
    head.startsWith("your chat replies are grounded in this repo snapshot") ||
    head.startsWith("relevant files") ||
    head.startsWith("workspace files")
  ) {
    return "task";
  }
  if (head.includes("available tools:") || head.startsWith("tools:")) return "tools";
  return fallback;
}

function pushSection(out: Map<SectionKey, string[]>, key: SectionKey, text: string) {
  const trimmed = text.replace(/^\n+|\s+$/g, "");
  if (!trimmed) return;
  const list = out.get(key) ?? [];
  list.push(trimmed);
  out.set(key, list);
}

/**
 * Headings the app itself renders AFTER the skills block (lib/memory.ts,
 * lib/prompts/chat.ts, lib/skillRuntime.ts). Inside a skill, only these
 * (and the next `## Skill:` header) end the skill; any other heading is
 * part of the skill's own body.
 */
const AFTER_SKILLS_HEADINGS = new Set(["memory", "repo tools (read-only)", "skill tool (read-only)"]);

function isSkillHeading(title: string): boolean {
  const t = title.trim().toLowerCase();
  return t.startsWith("skill:") || t === "skills" || t.startsWith("skills (");
}

/**
 * The section a heading opens, given the section it appears in. A skill's
 * body routinely has its own `##` / `###` headings ("## Steps", "## Tools",
 * "### Task"); those stay under Skills instead of being reclassified as
 * Shared instructions / Tools / Task.
 */
export function sectionForHeading(title: string, current: SectionKey): SectionKey {
  if (isSkillHeading(title)) return "skills";
  if (current === "skills" && !AFTER_SKILLS_HEADINGS.has(title.trim().toLowerCase())) return "skills";
  return classifyHeading(title);
}

/** Split one system prompt: persona first, then headed blocks. */
function splitSystem(content: string, out: Map<SectionKey, string[]>) {
  const lines = content.split("\n");
  let current: SectionKey = "system";
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n");
    buffer = [];
    if (current === "system" || current === "shared") {
      // Paragraph-level: a repo snapshot or tool catalog inside the persona block.
      for (const paragraph of text.split(/\n{2,}/)) pushSection(out, classifyParagraph(paragraph, current), paragraph);
    } else {
      pushSection(out, current, text);
    }
  };
  for (const line of lines) {
    const heading = line.match(HEADING);
    if (heading) {
      const next = sectionForHeading(heading[1], current);
      // A heading inside a skill body keeps the skill in one piece; only a
      // new skill header or a section after the skills block splits it.
      if (!(current === "skills" && next === "skills" && !isSkillHeading(heading[1]))) {
        flush();
        current = next;
      }
    }
    buffer.push(line);
  }
  flush();
}

/** Split the final user message: context blocks vs the instruction itself. */
function splitUser(content: string, out: Map<SectionKey, string[]>) {
  const paragraphs = content.split(/\n{2,}/);
  let current: SectionKey = "user";
  for (const paragraph of paragraphs) {
    const heading = paragraph.trimStart().match(HEADING);
    if (heading) {
      current = classifyHeading(heading[1]);
      if (current === "shared") current = "task";
    } else {
      const kind = classifyParagraph(paragraph, "user");
      // A context block runs until the next paragraph that does not look
      // like a continuation (indented, bullet, or "--- file ---" header).
      if (kind !== "user") current = kind;
      else if (current !== "user" && !/^\s*(?:[-*•]|---|###|\d+\.|\s{2})/.test(paragraph)) current = "user";
    }
    pushSection(out, current, paragraph);
  }
}

/**
 * The call's messages → ordered, labelled sections. System messages are split
 * by heading; the LAST user message is the user message (minus context
 * blocks); everything in between (earlier turns, tool results, extra system
 * lines such as a conversation summary) is conversation history.
 */
export function splitPromptSections(messages: PromptMessage[], extra?: { tools?: string; task?: string }): SnapshotSection[] {
  const out = new Map<SectionKey, string[]>();
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  let firstSystemDone = false;
  const history: string[] = [];
  messages.forEach((message, index) => {
    const content = message.content ?? "";
    if (message.role === "system" && !firstSystemDone && index === 0) {
      firstSystemDone = true;
      splitSystem(content, out);
      return;
    }
    if (index === lastUser) {
      splitUser(content, out);
      return;
    }
    // MCP tool-loop catalog arrives as its own user turn.
    if (message.role === "user" && /\n\nAvailable tools:\n/.test(content)) {
      const [instruction, catalog] = content.split(/\n\nAvailable tools:\n/);
      pushSection(out, "tools", `${instruction}\n\nAvailable tools:\n${catalog}`);
      return;
    }
    history.push(`[${message.role}] ${content}`);
  });
  if (history.length > 0) pushSection(out, "history", history.join("\n\n"));
  if (extra?.tools) pushSection(out, "tools", extra.tools);
  if (extra?.task) pushSection(out, "task", extra.task);
  return SECTION_KEYS.filter((key) => out.has(key)).map((key) => ({
    key,
    label: SECTION_LABELS[key],
    content: (out.get(key) ?? []).join("\n\n"),
  }));
}

// ── Facts the inspector lists ───────────────────────────────────────────

export function skillNamesIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^## Skill:\s*(.+)$/gm)) names.add(match[1].trim().slice(0, 80));
  return [...names];
}

export function toolNamesIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^tool "([^"]+)"/gm)) names.add(match[1]);
  for (const match of text.matchAll(/^-\s+([a-z_][a-z0-9_]*)\s*[{(:]/gm)) names.add(match[1]);
  return [...names].slice(0, 60);
}

// ── Build ───────────────────────────────────────────────────────────────

export interface SnapshotInput {
  callRole: CallRole;
  messages: PromptMessage[];
  response?: string;
  error?: string;
  model?: string;
  provider?: string;
  temperature?: number;
  inputTokens?: number;
  outputTokens?: number;
  usageEstimated?: boolean;
  durationMs?: number;
  /** D5: prompt tokens the provider served from its cache (subset of inputTokens). */
  cachedInputTokens?: number;
  /** D5: time to first streamed token. */
  ttftMs?: number;
  /** Extra tool definitions not present in the messages (native tools). */
  toolsText?: string;
  /** Extra redaction for the worker (its whole-value mask). */
  extraRedact?: (text: string) => string;
}

export interface SnapshotMeta {
  callRole: CallRole;
  model?: string;
  provider?: string;
  temperature?: number;
  inputTokens?: number;
  outputTokens?: number;
  usageEstimated?: boolean;
  durationMs?: number;
  cachedInputTokens?: number;
  ttftMs?: number;
  error?: string;
  sectionStats: SectionStat[];
  promptTokens: number;
  toolNames: string[];
  skillNames: string[];
  memoryIncluded: boolean;
  historyMessages: number;
  truncated: boolean;
  bytes: number;
}

export interface SnapshotBody {
  sections: SnapshotSection[];
  response: string;
  responseTruncatedChars?: number;
}

export function buildContextSnapshot(input: SnapshotInput): { meta: SnapshotMeta; body: SnapshotBody } {
  const scrub = (text: string) => redactSecrets(input.extraRedact ? input.extraRedact(text) : text);
  const raw = splitPromptSections(
    input.messages.map((m) => ({ role: m.role, content: scrub(m.content ?? "") })),
    input.toolsText ? { tools: scrub(input.toolsText) } : undefined
  );
  // Stats come from the full (uncapped) text, so shares stay honest.
  const sectionStats: SectionStat[] = raw.map((s) => ({
    key: s.key,
    label: s.label,
    chars: s.content.length,
    tokens: estimateTokens(s.content),
  }));
  const sections = capSections(raw);
  sections.forEach((s, i) => {
    if (s.truncatedChars) sectionStats[i].truncated = true;
  });
  const response = capText(scrub(input.response ?? ""), SNAPSHOT_RESPONSE_CAP);
  const error = input.error ? capText(scrub(input.error), SNAPSHOT_ERROR_CAP).text : undefined;
  const allText = raw.map((s) => s.content).join("\n");
  const historyMessages = Math.max(
    0,
    input.messages.filter((m, i) => i > 0 && i < input.messages.length - 1 && m.role !== "system").length
  );
  const bytes = sections.reduce((n, s) => n + s.content.length, 0) + response.text.length + (error?.length ?? 0);
  return {
    meta: {
      callRole: input.callRole,
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.inputTokens === "number" ? { inputTokens: input.inputTokens } : {}),
      ...(typeof input.outputTokens === "number" ? { outputTokens: input.outputTokens } : {}),
      ...(input.usageEstimated ? { usageEstimated: true } : {}),
      ...(typeof input.durationMs === "number" ? { durationMs: Math.round(input.durationMs) } : {}),
      ...(typeof input.cachedInputTokens === "number" ? { cachedInputTokens: input.cachedInputTokens } : {}),
      ...(typeof input.ttftMs === "number" ? { ttftMs: Math.round(input.ttftMs) } : {}),
      ...(error ? { error } : {}),
      sectionStats,
      promptTokens: sectionStats.reduce((n, s) => n + s.tokens, 0),
      toolNames: toolNamesIn(sections.filter((s) => s.key === "tools").map((s) => s.content).join("\n")),
      skillNames: skillNamesIn(allText),
      memoryIncluded: sections.some((s) => s.key === "memory"),
      historyMessages,
      truncated: sections.some((s) => Boolean(s.truncatedChars)) || response.truncatedChars > 0,
      bytes,
    },
    body: {
      sections,
      response: response.text,
      ...(response.truncatedChars ? { responseTruncatedChars: response.truncatedChars } : {}),
    },
  };
}

/** Share of the prompt each section takes, in whole percent (sums to ~100). */
export function sectionShares<T extends { tokens: number }>(stats: T[]): Array<T & { share: number }> {
  const total = stats.reduce((n, s) => n + s.tokens, 0) || 1;
  return stats.map((s) => ({ ...s, share: Math.round((s.tokens / total) * 1000) / 10 }));
}

/** Retention: clamp the project setting; default 14 days. */
export function retentionDays(setting: number | undefined | null): number {
  if (typeof setting !== "number" || !Number.isFinite(setting) || setting <= 0) return DEFAULT_SNAPSHOT_RETENTION_DAYS;
  return Math.min(MAX_SNAPSHOT_RETENTION_DAYS, Math.max(1, Math.floor(setting)));
}

export function retentionCutoff(now: number, setting: number | undefined | null): number {
  return now - retentionDays(setting) * 24 * 60 * 60 * 1000;
}
