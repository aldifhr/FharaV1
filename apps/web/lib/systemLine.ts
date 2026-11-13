/**
 * Orchestrator/CTO split O4: how the web shows System status lines.
 *
 * A System line is a message with `voice: "system"` (apps/api/convex/lib/systemLine.ts):
 * routing/status only, no agent, no @name. Older chats hold the pre-O3 handoff line an agent
 * posted instead ("Handing this to @Backend for …"); it is shown the same way, as "Sent to Backend".
 *
 * Pure, so tests/unit/systemLine.test.mjs can run it under node:test.
 */
import { isSystemLine } from "@/api/convex/lib/systemLine";

export { isSystemLine };

// Same shape as `isHandoffLine` in apps/api/convex/lib/chat/dispatch.ts, with the name captured.
const LEGACY_HANDOFF = /^(?:Handing this to @([\w.-]+) for [^\n]{1,160}\.|Saya serahkan ke @([\w.-]+) untuk [^\n]{1,160}\.)$/;

type Row = { voice?: string | null; authorType?: string; content?: string | null };

/** "Sent to Backend" for a legacy handoff line, else null. */
export function legacyHandoffText(row: Row, label: (name: string) => string = (name) => name): string | null {
  if (row.authorType !== "agent" || isSystemLine(row)) return null;
  const match = LEGACY_HANDOFF.exec((row.content ?? "").trim());
  const name = match?.[1] ?? match?.[2];
  return name ? `Sent to ${label(name)}` : null;
}

/**
 * The text of the status row this message renders as, or null for an ordinary message.
 * System lines show their own text; legacy handoff lines show "Sent to X".
 */
export function systemLineText(row: Row, label?: (name: string) => string): string | null {
  if (isSystemLine(row)) return (row.content ?? "").trim() || null;
  return legacyHandoffText(row, label);
}

/** A System row is never a reply target (no Reply, no quote). */
export const canReplyTo = (row: Row): boolean => systemLineText(row) === null && Boolean(row.content?.trim());

// ── Held task (CTO architecture stop, O2) ───────────────────────────────────
// Mirrors `archStopQuestion` in packages/worker/src/services/runner/archDecision.ts.
const ARCH_STOP_PREFIX = "The CTO recommends stopping before the gated work:";
const ARCH_STOP_SUFFIX = /\n\nResume the plan anyway, or cancel the task\?\s*$/;

/** The answer that resumes a held plan (ARCH_STOP_OPTIONS[0] in archDecision.ts). */
export const ARCH_STOP_RESUME_ANSWER = "Resume the plan";

/** The CTO's reason when the task is held by an architecture stop, else null. */
export function heldStopReason(task: { status?: string; pendingQuestion?: string | null } | null | undefined): string | null {
  if (task?.status !== "waiting_input") return null;
  const question = (task.pendingQuestion ?? "").trim();
  if (!question.startsWith(ARCH_STOP_PREFIX)) return null;
  return question.slice(ARCH_STOP_PREFIX.length).replace(ARCH_STOP_SUFFIX, "").trim() || null;
}

// ── Final report (O2: posted as the Response Owner) ─────────────────────────
const REPORT_OPENING = /^(?:Done\.|Not run\.|Finished, but verification is inconclusive)/;
const ARCH_DECISION = /^(?:Decision:|Architecture decision)/i;

/**
 * Which pinned block a task-thread message belongs to: the final report (shown under the
 * Response Owner's role), a CTO architecture decision, a review note, or null (a reply).
 */
export function threadBlockOf(
  row: Row,
  role: string | undefined,
  responseOwner: string | undefined
): "report" | "decision" | "review" | null {
  if (row.authorType !== "agent" || isSystemLine(row)) return null;
  const text = (row.content ?? "").trim();
  if (role === "reviewer") return "review";
  if (REPORT_OPENING.test(text) && (!responseOwner || !role || role === responseOwner || role === "cto")) return "report";
  if (role === "cto" && ARCH_DECISION.test(text)) return "decision";
  return null;
}
