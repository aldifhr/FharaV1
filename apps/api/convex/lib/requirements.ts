/**
 * Intent-to-execution traceability (plan 025). Pure TypeScript: shared by
 * the worker (planning, coverage check before "done"), the backend (the
 * requirements projection on /runs) and the web UI. No Convex runtime, Node
 * or DOM APIs.
 *
 * A requirement is one thing the user asked for, with the span of the
 * request it came from. The planner maps every subtask to requirementIds;
 * evidence (gate results, QA verdicts, changed files) is linked to
 * subtasks and through them to requirements. A requirement with no
 * subtask, or with no passing evidence, keeps the task from being done.
 */

export interface RequirementSpan {
  /** Offset into the original request (inclusive). */
  start: number;
  /** Offset into the original request (exclusive). */
  end: number;
}

export interface Requirement {
  /** Stable id within the task: r1, r2, … */
  id: string;
  text: string;
  /** Where in the request this requirement came from; absent when it could not be located. */
  span?: RequirementSpan;
  /** "llm" = the planner's structured extraction; "fallback" = the deterministic splitter. */
  source: "llm" | "fallback";
}

export const MAX_REQUIREMENTS = 12;
const TEXT_MAX = 300;

// ---------------------------------------------------------------------------
// Deterministic fallback extraction
// ---------------------------------------------------------------------------

/** Words that start an action clause (English + Indonesian). */
const ACTION_VERBS = new Set([
  "add", "build", "create", "implement", "fix", "update", "remove", "delete", "refactor", "write", "make",
  "rename", "move", "migrate", "support", "document", "test", "improve", "change", "replace", "enable",
  "disable", "allow", "show", "hide", "handle", "integrate", "upgrade", "set", "configure", "deploy",
  "tambah", "tambahkan", "buat", "buatkan", "bikin", "perbaiki", "benerin", "ubah", "ganti", "hapus",
  "pindahkan", "dokumentasikan", "uji", "perbarui", "update", "rapikan", "implementasikan", "aktifkan",
]);

const CONJUNCTION = /\s+(?:and|dan|serta|plus|also|juga|&)\s+/i;
const LIST_SPLIT = /\s*,\s*(?:(?:and|dan|serta|plus|&)\s+)?|\s+(?:and|dan|serta|plus|&)\s+/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

interface Piece {
  text: string;
  start: number;
}

function trimPiece(text: string, start: number): Piece | null {
  const lead = text.length - text.trimStart().length;
  let value = text.trim();
  let offset = start + lead;
  // Leading connective words and trailing punctuation are not part of the requirement.
  const leading = /^(?:and|dan|serta|plus|also|juga|then|lalu|kemudian|&)\s+/i.exec(value);
  if (leading) {
    offset += leading[0].length;
    value = value.slice(leading[0].length);
  }
  value = value.replace(/[\s.;:,!?]+$/, "");
  if (!/[\p{L}\p{N}]/u.test(value)) return null;
  return { text: value, start: offset };
}

/** Split one sentence into its list items when it is a list; otherwise the sentence itself. */
function splitSentence(sentence: string, start: number): Piece[] {
  const colon = sentence.indexOf(":");
  // "Implement auth: login, register, logout, dan refresh token" → the
  // items after the colon are the requirements.
  if (colon > 0 && colon < sentence.length - 1) {
    const items = splitList(sentence.slice(colon + 1), start + colon + 1);
    if (items.length >= 2) return items;
  }
  const items = splitList(sentence, start);
  if (items.length >= 3) return items;
  if (items.length === 2) {
    // "A and B" without commas is a list only when both sides are actions
    // ("add login and fix the header"), not "a search and filter bar".
    const bothActions = items.every((item) => ACTION_VERBS.has(firstWord(item.text)));
    if (bothActions && CONJUNCTION.test(sentence)) return items;
    if (bothActions && sentence.includes(",")) return items;
  }
  const whole = trimPiece(sentence, start);
  return whole ? [whole] : [];
}

function firstWord(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^\p{L}]/gu, "");
}

function splitList(text: string, start: number): Piece[] {
  const pieces: Piece[] = [];
  const pattern = new RegExp(LIST_SPLIT.source, "gi");
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    const piece = trimPiece(text.slice(cursor, match.index), start + cursor);
    if (piece) pieces.push(piece);
    cursor = match.index + match[0].length;
  }
  const tail = trimPiece(text.slice(cursor), start + cursor);
  if (tail) pieces.push(tail);
  return pieces;
}

/**
 * Deterministic requirement extraction: bullet / numbered lines first, then
 * sentences, and inside a sentence the items of a list ("login, register,
 * logout, dan refresh token"). A request with no list is one requirement.
 */
export function extractRequirementsFallback(request: string): Requirement[] {
  const source = request ?? "";
  const pieces: Piece[] = [];
  const lines: Piece[] = [];
  let offset = 0;
  for (const line of source.split("\n")) {
    lines.push({ text: line, start: offset });
    offset += line.length + 1;
  }
  const bullets = lines.filter((line) => BULLET.test(line.text));
  if (bullets.length >= 2) {
    // The line before the list ("Do these:") is context, not a requirement.
    for (const line of bullets) {
      const marker = BULLET.exec(line.text)![0].length;
      const piece = trimPiece(line.text.slice(marker), line.start + marker);
      if (piece) pieces.push(piece);
    }
  } else {
    // A sentence ends at "." / "!" / "?" only when whitespace or the end
    // follows: a dot inside a file name or version ("simple.html",
    // "style.css", "v1.2") is not a sentence break (live test 3 split
    // "simple.html + style.css" into "simple", "html + style", "css").
    const sentence = /(?:[^.!?;\n]|[.!?](?=[^\s.!?;]))+[.!?;]*/g;
    let match: RegExpExecArray | null;
    while ((match = sentence.exec(source)) !== null) {
      pieces.push(...splitSentence(match[0], match.index));
    }
  }
  const seen = new Set<string>();
  const unique = pieces.filter((piece) => {
    const key = piece.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const capped = unique.slice(0, MAX_REQUIREMENTS);
  if (capped.length === 0) {
    const text = source.trim();
    if (!text) return [];
    const start = source.indexOf(text);
    return [{ id: "r1", text: text.slice(0, TEXT_MAX), span: { start, end: start + Math.min(text.length, TEXT_MAX) }, source: "fallback" }];
  }
  return capped.map((piece, index) => ({
    id: `r${index + 1}`,
    text: piece.text.slice(0, TEXT_MAX),
    span: { start: piece.start, end: piece.start + piece.text.length },
    source: "fallback" as const,
  }));
}

// ---------------------------------------------------------------------------
// LLM output normalization
// ---------------------------------------------------------------------------

function locate(request: string, needle: string): RequirementSpan | undefined {
  const value = needle.trim();
  if (!value) return undefined;
  const index = request.toLowerCase().indexOf(value.toLowerCase());
  if (index < 0) return undefined;
  return { start: index, end: index + value.length };
}

/**
 * Normalize the planner's `requirements` array (one structured LLM call
 * inside the planning step). Ids are re-issued as r1…rn; `idMap` maps the
 * planner's own ids to them so its subtask `requirementIds` still resolve.
 * Returns null when the output is unusable (the caller falls back).
 */
export function normalizeLlmRequirements(
  raw: unknown,
  request: string
): { requirements: Requirement[]; idMap: Map<string, string> } | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REQUIREMENTS * 2) return null;
  const requirements: Requirement[] = [];
  const idMap = new Map<string, string>();
  const seen = new Set<string>();
  for (const entry of raw) {
    const value = typeof entry === "string" ? { text: entry } : entry;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim().slice(0, TEXT_MAX) : "";
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const quote =
      typeof record.quote === "string" ? record.quote : typeof record.source === "string" ? record.source : "";
    const id = `r${requirements.length + 1}`;
    if (typeof record.id === "string" && record.id.trim()) idMap.set(record.id.trim().toLowerCase(), id);
    idMap.set(id, idMap.get(id) ?? id);
    const span = locate(request, quote) ?? locate(request, text);
    requirements.push({ id, text, ...(span ? { span } : {}), source: "llm" });
    if (requirements.length >= MAX_REQUIREMENTS) break;
  }
  return requirements.length > 0 ? { requirements, idMap } : null;
}

/** Read a stored requirement list (task row / plan payload); invalid entries are dropped. */
export function parseStoredRequirements(raw: unknown): Requirement[] {
  if (!Array.isArray(raw)) return [];
  const out: Requirement[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.text !== "string") continue;
    const span = record.span as { start?: unknown; end?: unknown } | undefined;
    out.push({
      id: record.id,
      text: record.text,
      ...(span && typeof span.start === "number" && typeof span.end === "number"
        ? { span: { start: span.start, end: span.end } }
        : {}),
      source: record.source === "llm" ? "llm" : "fallback",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Subtask → requirement mapping
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  ...ACTION_VERBS,
  "the", "a", "an", "to", "for", "of", "in", "on", "with", "and", "or", "into", "from", "by", "at", "as",
  "is", "be", "it", "its", "this", "that", "new", "page", "flow", "feature", "support", "endpoint", "api",
  "yang", "dan", "di", "ke", "untuk", "dengan", "dari", "pada", "fitur", "halaman", "agar", "supaya",
]);

/** Significant tokens of a text, cut to a 5-letter stem ("registration" ~ "register"). */
export function requirementTokens(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = words.filter((word) => word.length >= 3 && !STOPWORDS.has(word)).map((word) => word.slice(0, 5));
  return [...new Set(tokens)];
}

export interface MappableSubtask {
  key: string;
  title: string;
  description?: string;
  objective?: string;
  kind: string;
  requirementIds?: string[];
}

function mentions(subtask: MappableSubtask, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const haystack = new Set(requirementTokens(`${subtask.title} ${subtask.description ?? ""} ${subtask.objective ?? ""}`));
  const hits = tokens.filter((token) => haystack.has(token)).length;
  return tokens.length <= 2 ? hits === tokens.length : hits / tokens.length >= 0.6;
}

/**
 * Deterministic mapping on top of whatever the planner declared: unknown
 * ids are dropped (planner ids are translated through `idMap`); with a
 * single requirement every subtask serves it; otherwise a requirement no
 * subtask declared is linked to the implementing subtasks (not review /
 * QA nodes) whose title, description or objective names it. A requirement
 * nothing names stays unmapped — that is what the coverage check reports.
 */
export function linkSubtasksToRequirements<T extends MappableSubtask>(
  subtasks: T[],
  requirements: Requirement[],
  idMap?: Map<string, string>
): Array<T & { requirementIds: string[] }> {
  const known = new Set(requirements.map((requirement) => requirement.id));
  const linked = subtasks.map((subtask) => {
    const declared = (subtask.requirementIds ?? [])
      .map((id) => String(id).trim().toLowerCase())
      .map((id) => idMap?.get(id) ?? id)
      .filter((id) => known.has(id));
    return { ...subtask, requirementIds: [...new Set(declared)] };
  });
  if (requirements.length === 0) return linked;
  if (requirements.length === 1) {
    const only = requirements[0].id;
    return linked.map((subtask) => (subtask.requirementIds.length > 0 ? subtask : { ...subtask, requirementIds: [only] }));
  }
  const mapped = new Set(linked.flatMap((subtask) => subtask.requirementIds));
  for (const requirement of requirements) {
    if (mapped.has(requirement.id)) continue;
    const tokens = requirementTokens(requirement.text);
    for (const subtask of linked) {
      if (subtask.kind === "review" || subtask.kind === "qa") continue;
      if (mentions(subtask, tokens)) subtask.requirementIds.push(requirement.id);
    }
  }
  return linked;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type EvidenceStatus = "pass" | "fail" | "skipped";

export interface TraceEvidence {
  /** gate | qa | files */
  kind: "gate" | "qa" | "files";
  /** Gate id, QA subtask key, or the changed file paths. */
  ref: string;
  status: EvidenceStatus;
  summary: string;
}

export interface CoverageSubtask extends MappableSubtask {
  status: string;
  origin?: string | null;
  acceptance?: Array<{ id: string; criterion: string; check: string; required?: boolean }>;
  acceptanceStatus?: string | null;
  gateResults?: Array<{ gateId: string; status: EvidenceStatus; evidence: { kind: string; ref?: string; summary: string } }>;
}

export interface CoverageInput {
  requirements: Requirement[];
  subtasks: CoverageSubtask[];
  /** QA verdicts by QA subtask key. */
  qaVerdicts?: Record<string, string>;
  /** Changed (staged or applied) files by subtask key. */
  filesBySubtask?: Record<string, string[]>;
}

export type RequirementState = "covered" | "missing_evidence" | "uncovered";

export interface RequirementCoverageSubtask {
  key: string;
  title: string;
  kind: string;
  status: string;
  acceptanceStatus: string | null;
  acceptance: string[];
  evidence: TraceEvidence[];
}

export interface RequirementCoverage {
  requirement: Requirement;
  state: RequirementState;
  /** Why the requirement is not covered (empty when covered). */
  reason: string;
  subtasks: RequirementCoverageSubtask[];
}

export interface CoverageReport {
  requirements: RequirementCoverage[];
  covered: string[];
  missingEvidence: string[];
  uncovered: string[];
  /** True when every requirement is covered. */
  complete: boolean;
}

const BAD_ACCEPTANCE = new Set(["rejected", "blocked", "escalated"]);

function evidenceFor(subtask: CoverageSubtask, input: CoverageInput): TraceEvidence[] {
  const evidence: TraceEvidence[] = [];
  for (const result of subtask.gateResults ?? []) {
    evidence.push({
      kind: "gate",
      ref: result.gateId,
      status: result.status,
      summary: result.evidence?.summary ?? "",
    });
  }
  const qa = input.qaVerdicts?.[subtask.key];
  if (qa) {
    evidence.push({
      kind: "qa",
      ref: subtask.key,
      status: qa === "passed" ? "pass" : qa === "failed" ? "fail" : "skipped",
      summary: `QA ${qa}`,
    });
  }
  const files = input.filesBySubtask?.[subtask.key] ?? [];
  if (files.length > 0) {
    evidence.push({
      kind: "files",
      ref: files.slice(0, 20).join(", "),
      status: "pass",
      summary: `${files.length} file${files.length === 1 ? "" : "s"} changed`,
    });
  }
  return evidence;
}

/**
 * The deterministic coverage check. A requirement is
 * - `uncovered` when no subtask maps to it;
 * - `missing_evidence` when a mapped subtask did not complete, its
 *   acceptance was rejected / blocked / escalated, a piece of its evidence
 *   failed, or no mapped subtask has passing evidence (a passing gate, a
 *   passing QA verdict, or changed files);
 * - `covered` otherwise.
 * Runner-added nodes (fixes, delegations) carry no requirement themselves;
 * their parent's gates are the evidence.
 */
export function computeRequirementCoverage(input: CoverageInput): CoverageReport {
  const planned = input.subtasks.filter((subtask) => !subtask.origin || subtask.origin === "planned" || subtask.origin === "plan");
  const linked = linkSubtasksToRequirements(planned, input.requirements);
  const report: CoverageReport = { requirements: [], covered: [], missingEvidence: [], uncovered: [], complete: true };
  for (const requirement of input.requirements) {
    const serving = linked.filter((subtask) => subtask.requirementIds.includes(requirement.id));
    const rows: RequirementCoverageSubtask[] = serving.map((subtask) => ({
      key: subtask.key,
      title: subtask.title,
      kind: subtask.kind,
      status: subtask.status,
      acceptanceStatus: subtask.acceptanceStatus ?? null,
      acceptance: (subtask.acceptance ?? []).map((gate) => gate.criterion),
      evidence: evidenceFor(subtask, input),
    }));
    let state: RequirementState = "covered";
    let reason = "";
    if (rows.length === 0) {
      state = "uncovered";
      reason = "No subtask in the plan serves this requirement";
    } else {
      const active = rows.filter((row) => row.status !== "skipped");
      const unfinished = active.find((row) => row.status !== "completed");
      const refused = active.find((row) => row.acceptanceStatus && BAD_ACCEPTANCE.has(row.acceptanceStatus));
      const failing = active.find((row) => row.evidence.some((item) => item.status === "fail"));
      const passing = active.some((row) => row.evidence.some((item) => item.status === "pass"));
      if (active.length === 0) {
        state = "missing_evidence";
        reason = "Every subtask serving it was skipped";
      } else if (unfinished) {
        state = "missing_evidence";
        reason = `Subtask ${unfinished.key} is ${unfinished.status.replace(/_/g, " ")}`;
      } else if (refused) {
        state = "missing_evidence";
        reason = `Subtask ${refused.key} acceptance is ${refused.acceptanceStatus}`;
      } else if (failing) {
        const item = failing.evidence.find((entry) => entry.status === "fail")!;
        state = "missing_evidence";
        reason = `Subtask ${failing.key}: ${item.kind} ${item.ref} failed`;
      } else if (!passing) {
        state = "missing_evidence";
        reason = "No passing evidence (no passing gate, QA verdict, or changed file)";
      }
    }
    if (state === "covered") report.covered.push(requirement.id);
    else if (state === "uncovered") report.uncovered.push(requirement.id);
    else report.missingEvidence.push(requirement.id);
    report.requirements.push({ requirement, state, reason, subtasks: rows });
  }
  report.complete = report.uncovered.length === 0 && report.missingEvidence.length === 0;
  return report;
}

/**
 * Whether the report keeps the task from being `done`. Every gap counts,
 * except one: a single-requirement request whose only shortfall is
 * missing evidence is left to the existing acceptance / evaluation gates
 * (the whole plan serves it, and those gates already judged the result).
 */
export function coverageBlocksDone(report: CoverageReport): boolean {
  if (report.uncovered.length > 0) return true;
  if (report.missingEvidence.length === 0) return false;
  return report.requirements.length > 1;
}

/** The replan / failure note listing what is not covered. */
export function coverageGapNote(report: CoverageReport): string {
  const gaps = report.requirements
    .filter((entry) => entry.state !== "covered")
    .map((entry) => `${entry.requirement.id} "${entry.requirement.text}" (${entry.state === "uncovered" ? "uncovered" : "missing evidence"}: ${entry.reason})`);
  return `Requirements not covered: ${gaps.join("; ")}`.slice(0, 1500);
}

export const REQUIREMENT_STATE_LABELS: Record<RequirementState, string> = {
  covered: "Covered",
  missing_evidence: "Missing evidence",
  uncovered: "Uncovered",
};
