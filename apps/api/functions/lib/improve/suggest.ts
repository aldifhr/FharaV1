/**
 * Self-Improvement Lab (pure helpers): build the one LLM call that reads a
 * failed run and proposes a change to a prompt, skill, or role config, and
 * turn its answer into a concrete new version + diff. Nothing here applies
 * anything; the user decides on the Apply / Dismiss buttons.
 */
import { extractJsonObject, clip } from "../reviewer/opinion";
import { unifiedDiff } from "./textDiff";

export const SUGGESTION_TARGET_KINDS = ["agent_prompt", "skill", "role_prompt"] as const;
export type SuggestionTargetKind = (typeof SUGGESTION_TARGET_KINDS)[number];

export const TARGET_KIND_LABELS: Record<SuggestionTargetKind, string> = {
  agent_prompt: "Agent prompt",
  skill: "Skill",
  role_prompt: "Role config",
};

/** Longest text a suggestion may write back (matches the editors' limits loosely). */
export const SUGGESTION_MAX_TEXT = 40_000;
export const SUGGESTION_MAX_CANDIDATES = 8;
export const SUGGESTION_CANDIDATE_CHARS = 6_000;
export const SUGGESTION_EVENTS = 40;

export interface SuggestionCandidate {
  kind: SuggestionTargetKind;
  id: string;
  label: string;
  text: string;
}

export interface FailedRunMaterial {
  taskTitle: string;
  command: string;
  status: string;
  error?: string;
  incident?: { trigger: string; error?: string; failurePoint?: string; escalation?: string };
  subtasks: Array<{ key: string; title: string; role?: string; status: string; output?: string; error?: string; acceptanceReason?: string }>;
  events: Array<{ type: string; level?: string; subtaskKey?: string; text?: string }>;
  snapshots?: string[];
}

export function buildSuggestionPrompt(run: FailedRunMaterial, candidates: SuggestionCandidate[]): { system: string; user: string } {
  const system = [
    "You improve a multi-agent coding team after a failed run. Read the run and propose ONE concrete change to one of the candidate texts (an agent's system prompt, a library skill, or a role's prompt) that would most likely have prevented this failure.",
    "Change only what the evidence supports. Keep the rest of the text as it is. Never add secrets, never weaken safety or approval rules.",
    "Reply with ONLY this JSON object:",
    '{"targetId":"<candidate id>","rationale":"<= 3 sentences: what failed and why this change helps","edits":[{"find":"exact text from the candidate (copied verbatim)","replace":"new text"}]}',
    'Use {"find":"","replace":"text"} to append to the end. Use at most 4 edits. If no candidate text could have prevented the failure, reply {"targetId":null,"rationale":"why"}.',
  ].join("\n");
  const sub = run.subtasks
    .map(
      (s) =>
        `- ${s.key} "${s.title}"${s.role ? ` [${s.role}]` : ""}: ${s.status}${s.error ? ` — error: ${clip(s.error, 400)}` : ""}${
          s.acceptanceReason ? ` — acceptance: ${clip(s.acceptanceReason, 300)}` : ""
        }${s.output && (s.status === "failed" || s.status === "blocked") ? `\n  output: ${clip(s.output, 800)}` : ""}`
    )
    .join("\n");
  const events = run.events
    .slice(-SUGGESTION_EVENTS)
    .map((e) => `- ${e.level && e.level !== "info" ? `${e.level.toUpperCase()} ` : ""}${e.type}${e.subtaskKey ? ` [${e.subtaskKey}]` : ""}${e.text ? `: ${clip(e.text, 300)}` : ""}`)
    .join("\n");
  const cands = candidates
    .map((c) => `### ${c.id} (${TARGET_KIND_LABELS[c.kind]}: ${c.label})\n${clip(c.text || "(empty)", SUGGESTION_CANDIDATE_CHARS)}`)
    .join("\n\n");
  const user = [
    `Task: ${run.taskTitle} (${run.status})`,
    `Request: ${clip(run.command, 1_500)}`,
    run.error ? `Error: ${clip(run.error, 1_000)}` : "",
    run.incident
      ? `Incident: ${run.incident.trigger}${run.incident.failurePoint ? ` at ${run.incident.failurePoint}` : ""}${run.incident.error ? ` — ${clip(run.incident.error, 600)}` : ""}${
          run.incident.escalation ? ` — escalation: ${run.incident.escalation}` : ""
        }`
      : "",
    "",
    "Subtasks:",
    sub || "(none)",
    "",
    "Last events:",
    events || "(none)",
    run.snapshots?.length ? `\nContext snapshots:\n${run.snapshots.map((s) => clip(s, 1_500)).join("\n---\n")}` : "",
    "",
    "Candidates:",
    cands,
  ]
    .filter((line) => line !== "")
    .join("\n");
  return { system, user };
}

export interface ParsedSuggestion {
  targetId: string | null;
  rationale: string;
  edits: Array<{ find: string; replace: string }>;
}

export function parseSuggestion(text: string): ParsedSuggestion | null {
  const obj = extractJsonObject(text) as Record<string, unknown> | null;
  if (!obj) return null;
  const targetId = typeof obj.targetId === "string" && obj.targetId.trim() ? obj.targetId.trim() : null;
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim().slice(0, 1_000) : "";
  const edits = Array.isArray(obj.edits)
    ? (obj.edits as unknown[])
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
        .map((e) => ({
          find: typeof e.find === "string" ? e.find : "",
          replace: typeof e.replace === "string" ? e.replace : "",
        }))
        .filter((e) => e.find !== "" || e.replace.trim() !== "")
        .slice(0, 4)
    : [];
  return { targetId, rationale, edits };
}

/**
 * Apply find/replace edits to the current text. Each `find` must occur
 * exactly once (else that edit is skipped); an empty `find` appends.
 * Returns the new text and how many edits applied.
 */
export function applyEdits(current: string, edits: ParsedSuggestion["edits"]): { text: string; applied: number; skipped: number } {
  let text = current;
  let applied = 0;
  let skipped = 0;
  for (const edit of edits) {
    if (edit.find === "") {
      text = text.trimEnd() ? `${text.trimEnd()}\n\n${edit.replace.trim()}` : edit.replace.trim();
      applied += 1;
      continue;
    }
    const first = text.indexOf(edit.find);
    if (first < 0 || text.indexOf(edit.find, first + 1) >= 0) {
      skipped += 1;
      continue;
    }
    text = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length);
    applied += 1;
  }
  return { text, applied, skipped };
}

export type SuggestionOutcome =
  | { ok: true; target: SuggestionCandidate; rationale: string; proposedText: string; diff: string }
  | { ok: false; reason: string; rationale?: string };

/** From the model's reply to a concrete proposal (or a reason there is none). */
export function resolveSuggestion(reply: string, candidates: SuggestionCandidate[]): SuggestionOutcome {
  const parsed = parseSuggestion(reply);
  if (!parsed) return { ok: false, reason: "The model did not return a suggestion." };
  if (!parsed.targetId) return { ok: false, reason: "No prompt, skill, or role change would have prevented this.", rationale: parsed.rationale };
  const target = candidates.find((c) => c.id === parsed.targetId);
  if (!target) return { ok: false, reason: `The model picked an unknown target (${parsed.targetId}).`, rationale: parsed.rationale };
  const { text, applied } = applyEdits(target.text, parsed.edits);
  if (applied === 0 || text === target.text) {
    return { ok: false, reason: "The proposed edits did not match the current text.", rationale: parsed.rationale };
  }
  if (text.length > SUGGESTION_MAX_TEXT) return { ok: false, reason: "The proposed text is too long.", rationale: parsed.rationale };
  return {
    ok: true,
    target,
    rationale: parsed.rationale || "No rationale given.",
    proposedText: text,
    diff: unifiedDiff(target.text, text, target.label),
  };
}
