"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { roleLabel } from "@/lib/agentRoles";
import { looksIndonesian } from "@/api/convex/lib/chat/toolCallText";
import type { ChatToolStep } from "@/api/convex/lib/chat/activity";
import { activityTitleKind, isHandoffStep, reasoningRowHasLabel } from "@/lib/activityHeading";

/**
 * Activity timeline above an agent's chat reply (à la "Working" /
 * "N tools used"): "Berpikir…" → "Bekerja" with a one-line intent →
 * one row per tool call (streamed from `messages.toolSteps`) →
 * "Menyusun jawaban". Expanded while the reply streams, collapsed once it
 * is done. "Checked:" / "Unverified:" live inside it.
 */

const COPY = {
  id: {
    thinking: "Berpikir…",
    working: "Bekerja",
    composing: "Menyusun jawaban",
    tools: (n: number) => `${n} tool dipakai`,
    worked: "Selesai",
    failed: "gagal",
    reasoning: "Penalaran",
    list: (t: string) => `Melihat struktur ${t}`,
    grep: (t: string) => `Mencari ${t}`,
    read: (t: string, lines?: string) => `Membaca ${t}${lines ? ` (baris ${lines})` : ""}`,
    skill: (t: string) => `Memuat skill ${t}`,
    handoff: (t: string) => `Meminta bantuan ${t}`,
  },
  en: {
    thinking: "Thinking…",
    working: "Working",
    composing: "Writing the answer",
    tools: (n: number) => `${n} tool${n === 1 ? "" : "s"} used`,
    worked: "Done",
    failed: "failed",
    reasoning: "Reasoning",
    list: (t: string) => `Listing ${t}`,
    grep: (t: string) => `Searching for ${t}`,
    read: (t: string, lines?: string) => `Reading ${t}${lines ? ` (lines ${lines})` : ""}`,
    skill: (t: string) => `Loading skill ${t}`,
    handoff: (t: string) => `Asking ${t} for help`,
  },
};

type Copy = (typeof COPY)["id"];

export function toolStepLabel(step: ChatToolStep, copy: Copy = COPY.id): string {
  const target = step.target ?? "";
  switch (step.tool) {
    case "list_files":
      return copy.list(target || ".");
    case "grep":
      return copy.grep(target ? `"${target}"` : "");
    case "read_file":
      return copy.read(target, step.lines);
    case "load_skill":
      return copy.skill(target);
    case "handoff":
      return copy.handoff(roleLabel(target));
    default:
      return [step.tool, target].filter(Boolean).join(" ");
  }
}

export function hasActivityTimeline(m: any): boolean {
  return m?.authorType === "agent" && !m.card && (Boolean(m.intentLine) || (Array.isArray(m.toolSteps) && m.toolSteps.length > 0));
}

function Row({ children, last, active }: { children: React.ReactNode; last?: boolean; active?: boolean }) {
  return (
    <li className="relative flex min-w-0 gap-2.5 pb-1.5 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute left-[3px] top-[13px] bottom-0 w-px bg-line" />}
      <span
        aria-hidden="true"
        className={`relative mt-[7px] h-[7px] w-[7px] shrink-0 rounded-full border ${active ? "border-ink-2 bg-panel" : "border-ink-3 bg-ink-3"}`}
      />
      <div className="min-w-0 flex-1 text-[13px] leading-5 text-ink-2">{children}</div>
    </li>
  );
}

export default function ActivityTimeline({
  message,
  live,
  checkedLabel,
  unverifiedLabel,
}: {
  message: any;
  live: boolean;
  checkedLabel?: string | null;
  unverifiedLabel?: string | null;
}) {
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  const [showReasoning, setShowReasoning] = useState(false);
  const steps: ChatToolStep[] = Array.isArray(message.toolSteps) ? message.toolSteps : [];
  // Handoffs are steps, not tool calls: they never count toward "N tools used".
  const toolSteps = steps.filter((s) => !isHandoffStep(s));
  const handoffSteps = steps.filter(isHandoffStep);
  const content: string = message.content ?? "";
  const copy = looksIndonesian(content || message.intentLine || "") ? COPY.id : COPY.en;
  const hasContent = Boolean(content.trim());
  const phase: "thinking" | "working" | "composing" | "done" = !live
    ? "done"
    : hasContent
      ? "composing"
      : steps.length > 0 || Boolean(message.reasoning?.trim())
        ? "working"
        : "thinking";
  const open = userOpen ?? live;
  const extras = [checkedLabel, unverifiedLabel].filter(Boolean) as string[];
  const reasoning: string = (message.reasoning ?? "").trim();

  // A finished reply with no tool, nothing to verify and no reasoning needs no timeline.
  if (phase === "done" && steps.length === 0 && extras.length === 0 && !reasoning) return null;

  const titleKind = activityTitleKind(phase, toolSteps.length, extras.length, handoffSteps.length);
  const title =
    titleKind === "thinking"
      ? copy.thinking
      : titleKind === "working"
        ? copy.working
        : titleKind === "tools"
          ? copy.tools(toolSteps.length)
          : titleKind === "handoff"
            ? copy.handoff(handoffSteps.map((s) => roleLabel(s.target ?? "")).filter(Boolean).join(", "))
            : titleKind === "worked"
            ? copy.worked
            : copy.reasoning;
  const Chevron = open ? ChevronDown : ChevronRight;

  // Rows in order; the last one has no connector line below its dot.
  // A pure handoff is its own title: no step rows repeating it.
  const rowSteps = titleKind === "handoff" ? [] : steps;
  const rows: Array<{ key: string; active?: boolean; node: React.ReactNode }> = rowSteps.map((step, i) => ({
    key: `s${i}-${step.at}`,
    node: (
      <>
        <span className="break-words">{toolStepLabel(step, copy)}</span>
        {!step.ok && <span className="text-ink-3"> · {copy.failed}</span>}
      </>
    ),
  }));
  if (phase === "composing" || (phase === "done" && toolSteps.length > 0)) {
    rows.push({ key: "compose", active: phase === "composing", node: <span>{copy.composing}</span> });
  }
  if (phase === "done") {
    for (const line of extras) {
      rows.push({
        key: line,
        node: (
          <span className="block truncate text-ink-3" title={line}>
            {line}
          </span>
        ),
      });
    }
    if (reasoning) {
      const reasoningText = (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas px-3 py-2 font-sans text-[12px] leading-relaxed text-ink-2">
          {reasoning}
        </pre>
      );
      rows.push({
        key: "reasoning",
        // Titled "Reasoning" already: the row shows the text, not a second heading.
        node: reasoningRowHasLabel(titleKind) ? (
          <>
            <button type="button" onClick={() => setShowReasoning((v) => !v)} className="text-ink-3 hover:text-ink">
              {copy.reasoning}
            </button>
            {showReasoning && reasoningText}
          </>
        ) : (
          reasoningText
        ),
      });
    }
  }

  // Nothing to expand (a pure handoff): a plain line, no toggle.
  if (!live && rows.length === 0) {
    return (
      <div className="mt-1 flex max-w-3xl items-center py-0.5 text-[13px] text-ink-2">
        <span className="min-w-0 truncate font-medium text-ink">{title}</span>
      </div>
    );
  }

  return (
    <div className="mt-1 max-w-3xl" aria-live={live ? "polite" : undefined}>
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[13px] text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ink-3"
      >
        {live ? <Loader2 size={13} className="shrink-0 animate-spin text-ink-3" aria-hidden="true" /> : <Chevron size={13} className="shrink-0 text-ink-3" aria-hidden="true" />}
        <span className="shrink-0 font-medium text-ink">{title}</span>
        {phase !== "thinking" && phase !== "done" && message.intentLine && (
          <span className="min-w-0 truncate text-ink-2">{message.intentLine}</span>
        )}
        {live && <Chevron size={13} className="shrink-0 text-ink-3" aria-hidden="true" />}
      </button>
      {open && rows.length > 0 && (
        <ol className="mt-1.5 pl-1">
          {rows.map((row, i) => (
            <Row key={row.key} last={i === rows.length - 1} active={row.active}>
              {row.node}
            </Row>
          ))}
        </ol>
      )}
    </div>
  );
}
