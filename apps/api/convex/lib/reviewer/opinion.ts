/**
 * Reviewer observer: Second Opinion and Shadow Agent (pure helpers).
 *
 * Both modes run the Reviewer read-only. A second opinion is asked for by
 * the user on one finished subtask (or one chat reply) and returns a
 * verdict; the shadow agent watches a whole task and leaves short notes
 * after each subtask completes. Neither ever writes files, runs commands,
 * edits the plan, or blocks the run: the only tools offered are the
 * read-only repo tools (list_files, grep, read_file), and every result is
 * stored as a note for the user to act on (or not).
 *
 * No Convex, Node or DOM APIs here, so the parsers and prompt builders are
 * unit-testable and shared with the web app (labels).
 */

export const OPINION_VERDICTS = ["agree", "concerns", "disagree"] as const;
export type OpinionVerdict = (typeof OPINION_VERDICTS)[number];

export const SHADOW_NOTE_KINDS = ["risk", "missed_requirement", "suggestion"] as const;
export type ShadowNoteKind = (typeof SHADOW_NOTE_KINDS)[number];

export const VERDICT_LABELS: Record<OpinionVerdict, string> = {
  agree: "Agrees",
  concerns: "Has concerns",
  disagree: "Disagrees",
};

export const SHADOW_KIND_LABELS: Record<ShadowNoteKind, string> = {
  risk: "Risk",
  missed_requirement: "Missed requirement",
  suggestion: "Suggestion",
};

/** Read-only repo tool calls one second opinion may make. */
export const OPINION_MAX_TOOL_CALLS = 6;
/** Hard token cap (estimated in+out) for one second opinion run. */
export const OPINION_TOKEN_CAP = 60_000;
/** Shadow agent: notes per task, and its own token cap per task. */
export const SHADOW_MAX_NOTES_PER_TASK = 8;
export const SHADOW_TOKEN_CAP_PER_TASK = 80_000;
/** Shadow notes kept from one subtask review. */
export const SHADOW_MAX_NOTES_PER_SUBTASK = 3;
/** Repo tool calls one shadow review may make (kept small: it is an observer). */
export const SHADOW_MAX_TOOL_CALLS = 2;

/** Input caps (chars) for the material fed to the reviewer. */
export const REVIEW_INPUT_CAPS = {
  output: 8_000,
  diffPerFile: 4_000,
  diffTotal: 16_000,
  message: 8_000,
  question: 2_000,
} as const;

export interface EvidenceRef {
  file: string;
  line?: number;
  note?: string;
}

export interface OpinionResult {
  verdict: OpinionVerdict;
  reason: string;
  evidence: EvidenceRef[];
}

export interface ShadowNote {
  kind: ShadowNoteKind;
  text: string;
  evidence: EvidenceRef[];
}

/** chars/4: the same estimate the worker records when a provider omits usage. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

export function clip(text: string | undefined | null, max: number): string {
  const value = text ?? "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [truncated: ${value.length - max} more chars]`;
}

export interface ReviewGate {
  id: string;
  criterion: string;
  check?: string;
  required?: boolean;
}

export interface ReviewGateResult {
  gateId: string;
  status: string;
  summary?: string;
}

export interface SubtaskReviewMaterial {
  taskTitle: string;
  taskCommand: string;
  subtask: {
    key: string;
    title: string;
    description: string;
    kind: string;
    role?: string;
    status: string;
    output?: string;
    error?: string;
    objective?: string;
    constraints?: string[];
    deliverable?: string;
    allowedPaths?: string[];
    acceptance?: ReviewGate[];
    gateResults?: ReviewGateResult[];
    acceptanceStatus?: string;
  };
  diffs: Array<{ filePath: string; changeType: string; diff: string }>;
}

export interface MessageReviewMaterial {
  projectName: string;
  question: string;
  reply: string;
  replyRole?: string;
  checkedFiles?: string[];
}

function diffSection(diffs: SubtaskReviewMaterial["diffs"]): string {
  if (diffs.length === 0) return "No file changes were recorded for this subtask.";
  let used = 0;
  const parts: string[] = [];
  for (const change of diffs) {
    if (used >= REVIEW_INPUT_CAPS.diffTotal) {
      parts.push(`… ${diffs.length - parts.length} more changed file(s) not shown`);
      break;
    }
    const body = clip(change.diff, Math.min(REVIEW_INPUT_CAPS.diffPerFile, REVIEW_INPUT_CAPS.diffTotal - used));
    used += body.length;
    parts.push(`--- ${change.filePath} (${change.changeType})\n${body}`);
  }
  return parts.join("\n\n");
}

/** The subtask under review: contract, gates, output and diff, as one user message. */
export function buildSubtaskMaterial(m: SubtaskReviewMaterial): string {
  const s = m.subtask;
  const lines: string[] = [
    `Task: ${m.taskTitle}`,
    `User request: ${clip(m.taskCommand, REVIEW_INPUT_CAPS.question)}`,
    "",
    `Subtask ${s.key}: ${s.title} (${s.kind}${s.role ? `, ${s.role}` : ""}, status ${s.status})`,
    `Description: ${clip(s.description, 2_000)}`,
  ];
  if (s.objective) lines.push(`Objective: ${s.objective}`);
  if (s.deliverable) lines.push(`Deliverable: ${s.deliverable}`);
  if (s.constraints?.length) lines.push(`Constraints:\n${s.constraints.map((c) => `- ${c}`).join("\n")}`);
  if (s.allowedPaths?.length) lines.push(`Scope (allowed paths): ${s.allowedPaths.join(", ")}`);
  if (s.acceptance?.length) {
    lines.push(
      `Acceptance gates:\n${s.acceptance
        .map((g) => `- [${g.id}] ${g.criterion}${g.check ? ` (check: ${g.check})` : ""}${g.required === false ? " (optional)" : ""}`)
        .join("\n")}`
    );
  }
  if (s.gateResults?.length) {
    lines.push(
      `Gate results (${s.acceptanceStatus ?? "unknown"}):\n${s.gateResults
        .map((g) => `- [${g.gateId}] ${g.status}${g.summary ? `: ${g.summary}` : ""}`)
        .join("\n")}`
    );
  }
  if (s.error) lines.push(`Error: ${clip(s.error, 1_000)}`);
  lines.push("", "Output:", clip(s.output || "(no output)", REVIEW_INPUT_CAPS.output));
  lines.push("", "Diff:", diffSection(m.diffs));
  return lines.join("\n");
}

export function buildMessageMaterial(m: MessageReviewMaterial): string {
  return [
    `Project: ${m.projectName}`,
    `The user asked:\n${clip(m.question || "(no question found)", REVIEW_INPUT_CAPS.question)}`,
    "",
    `${m.replyRole ? `The ${m.replyRole}` : "The agent"} answered:\n${clip(m.reply, REVIEW_INPUT_CAPS.message)}`,
    m.checkedFiles?.length ? `\nFiles the agent read while answering: ${m.checkedFiles.join(", ")}` : "",
  ]
    .join("\n")
    .trim();
}

const READ_ONLY_RULES = [
  "You are an observer. You cannot write files, run commands, change the plan, or approve anything; you only read and report.",
  "Base every claim on the material above or on a repo tool result in this review. Cite evidence as file:line only exactly as a tool result or the diff shows it.",
];

/** System prompt for a second opinion (subtask or chat reply). */
export function buildOpinionSystem(opts: { persona?: string; target: "subtask" | "chat"; hasRepoTools: boolean; toolProtocol?: string }): string {
  return [
    opts.persona?.trim() || "You are the Reviewer on a software team.",
    "",
    opts.target === "subtask"
      ? "The user asked you for a second opinion on one finished subtask: does its output and diff actually meet its contract and acceptance gates, and is it correct?"
      : "The user asked you for a second opinion on a teammate's chat answer: is it correct and grounded in the repository?",
    ...READ_ONLY_RULES,
    opts.hasRepoTools && opts.toolProtocol ? `\n${opts.toolProtocol}` : "You have no repo tools in this review; judge from the material only and say what you could not check.",
    "",
    "When you are done, reply with ONLY this JSON object (no prose around it):",
    '{"verdict":"agree"|"concerns"|"disagree","reason":"<= 3 short sentences","evidence":[{"file":"path","line":12,"note":"what is there"}]}',
    "agree = it is correct and meets the contract; concerns = mostly right but something should be checked or fixed; disagree = it is wrong or misses the goal. Evidence may be empty when there is nothing to point at.",
  ].join("\n");
}

/** System prompt for one shadow review (after a subtask completed). */
export function buildShadowSystem(opts: { persona?: string; maxNotes: number; hasRepoTools: boolean; toolProtocol?: string }): string {
  return [
    opts.persona?.trim() || "You are the Reviewer on a software team.",
    "",
    "You are shadowing a running task as a silent observer. A subtask just completed. Read its output and diff against its contract and write at most " +
      `${opts.maxNotes} short notes the user should see: a risk, a missed requirement, or a suggestion.`,
    ...READ_ONLY_RULES,
    "Your notes never block or change the run. Write nothing when the work looks fine.",
    opts.hasRepoTools && opts.toolProtocol ? `\n${opts.toolProtocol}` : "",
    "",
    "Reply with ONLY this JSON object:",
    '{"notes":[{"kind":"risk"|"missed_requirement"|"suggestion","text":"one or two sentences","evidence":[{"file":"path","line":12}]}]}',
    'Use {"notes":[]} when there is nothing worth noting.',
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** First balanced JSON object in `text` (fenced or bare), or null. */
export function extractJsonObject(text: string): unknown {
  const source = (text ?? "").replace(/```(?:json)?/gi, "");
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function cleanEvidence(raw: unknown, max = 6): EvidenceRef[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceRef[] = [];
  for (const item of raw) {
    if (out.length >= max) break;
    let file = "";
    let line: number | undefined;
    let note: string | undefined;
    if (typeof item === "string") {
      const match = /^(.+?):(\d+)(?::\d+)?(?:\s+[-—–]\s*(.*))?$/.exec(item.trim());
      file = match ? match[1] : item.trim();
      line = match ? Number(match[2]) : undefined;
      note = match?.[3]?.trim() || undefined;
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      file = typeof o.file === "string" ? o.file : typeof o.path === "string" ? o.path : "";
      const rawLine = typeof o.line === "number" ? o.line : typeof o.line === "string" ? Number(o.line) : NaN;
      line = Number.isFinite(rawLine) && rawLine > 0 ? Math.floor(rawLine) : undefined;
      note = typeof o.note === "string" && o.note.trim() ? o.note.trim().slice(0, 200) : undefined;
      if (!line && /:\d+$/.test(file)) {
        const idx = file.lastIndexOf(":");
        line = Number(file.slice(idx + 1));
        file = file.slice(0, idx);
      }
    }
    file = file.trim().replace(/^\.\//, "").slice(0, 300);
    if (!file || /\s/.test(file)) continue;
    out.push({ file, ...(line ? { line } : {}), ...(note ? { note } : {}) });
  }
  return out;
}

/**
 * Parse the reviewer's verdict. A reply that is not the JSON shape falls
 * back to "concerns" with the prose as the reason: an unparseable review is
 * never reported as agreement.
 */
export function parseOpinion(text: string): OpinionResult {
  const obj = extractJsonObject(text) as Record<string, unknown> | null;
  const verdictRaw = typeof obj?.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  const verdict = (OPINION_VERDICTS as readonly string[]).includes(verdictRaw) ? (verdictRaw as OpinionVerdict) : null;
  const reasonRaw = typeof obj?.reason === "string" ? obj.reason.trim() : "";
  if (verdict) {
    return { verdict, reason: (reasonRaw || "No reason given.").slice(0, 800), evidence: cleanEvidence(obj?.evidence) };
  }
  const prose = (text ?? "").trim();
  return {
    verdict: "concerns",
    reason: (reasonRaw || prose || "The reviewer returned no verdict.").slice(0, 800),
    evidence: [],
  };
}

export function parseShadowNotes(text: string, max: number = SHADOW_MAX_NOTES_PER_SUBTASK): ShadowNote[] {
  const obj = extractJsonObject(text) as Record<string, unknown> | null;
  const raw = Array.isArray(obj?.notes) ? (obj!.notes as unknown[]) : [];
  const out: ShadowNote[] = [];
  for (const item of raw) {
    if (out.length >= max) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kindRaw = typeof o.kind === "string" ? o.kind.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    const kind = (SHADOW_NOTE_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as ShadowNoteKind) : "suggestion";
    const body = typeof o.text === "string" ? o.text.trim() : "";
    if (!body) continue;
    out.push({ kind, text: body.slice(0, 500), evidence: cleanEvidence(o.evidence, 3) });
  }
  return out;
}

/** "Replan with this note" text built from a second opinion. */
export function replanNoteFromOpinion(o: { verdict: string; reason: string; evidence?: EvidenceRef[]; subtaskTitle?: string }): string {
  const refs = (o.evidence ?? []).map((e) => `${e.file}${e.line ? `:${e.line}` : ""}${e.note ? ` (${e.note})` : ""}`);
  return [
    `Reviewer second opinion (${o.verdict})${o.subtaskTitle ? ` on "${o.subtaskTitle}"` : ""}: ${o.reason}`,
    refs.length ? `Evidence: ${refs.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2_000);
}

/** Shadow budget: whether one more shadow review may run for a task. */
export function shadowBudgetLeft(used: { notes: number; tokens: number }): { ok: boolean; notesLeft: number; reason?: "notes" | "tokens" } {
  if (used.notes >= SHADOW_MAX_NOTES_PER_TASK) return { ok: false, notesLeft: 0, reason: "notes" };
  if (used.tokens >= SHADOW_TOKEN_CAP_PER_TASK) return { ok: false, notesLeft: 0, reason: "tokens" };
  return { ok: true, notesLeft: SHADOW_MAX_NOTES_PER_TASK - used.notes };
}
