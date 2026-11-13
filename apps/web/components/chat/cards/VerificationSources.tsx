"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { HostCheckCardData, VerificationCardData } from "@/api/convex/cardTypes";
import { CARD_DIVIDER, MUTED, StatusWord, formatDuration, type StepStatus } from "./primitives";

/**
 * GOAT G9: what the agents reported and what the host's own check saw, on
 * two separate rows. "No check configured" is grey and never reads as a pass.
 */
const AGENT: Record<VerificationCardData["outcome"], { status: StepStatus; label: string }> = {
  passed: { status: "passed", label: "Passed" },
  failed: { status: "failed", label: "Failed" },
  inconclusive: { status: "not_run", label: "Inconclusive" },
};

function hostCheckWord(host: HostCheckCardData): { status: StepStatus; label: string } {
  switch (host.status) {
    case "passed":
      return { status: "passed", label: "Passed" };
    case "failed":
      return { status: "failed", label: typeof host.exitCode === "number" ? `Failed (exit ${host.exitCode})` : "Failed" };
    case "timed_out":
      return { status: "failed", label: "Timed out" };
    case "blocked":
      return { status: "blocked", label: "Blocked" };
    case "error":
      return { status: "blocked", label: "Could not run" };
    default:
      return { status: "not_run", label: "No check configured" };
  }
}

function Row({ title, detail, word }: { title: string; detail?: string; word: { status: StepStatus; label: string } }) {
  return (
    <li className="flex items-center gap-3 py-1.5 text-[13px]">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-ink">{title}</span>
        {detail && <span className={`ml-2 font-mono text-[11px] ${MUTED}`}>{detail}</span>}
      </span>
      <span className="shrink-0 text-right text-[12px]">
        <StatusWord status={word.status} label={word.label} size={13} />
      </span>
    </li>
  );
}

export default function VerificationSources({
  agentOutcome,
  hostCheck,
}: {
  agentOutcome?: VerificationCardData["outcome"];
  hostCheck: HostCheckCardData;
}) {
  const [showTail, setShowTail] = useState(false);
  const hostDetail = [hostCheck.command, formatDuration(hostCheck.durationMs)].filter(Boolean).join(" · ");
  return (
    <>
      <ul className={`border-t px-4 py-2 ${CARD_DIVIDER}`}>
        <Row title="Agent reported" word={agentOutcome ? AGENT[agentOutcome] : { status: "not_run", label: "Nothing reported" }} />
        <Row title="Host check" detail={hostDetail || undefined} word={hostCheckWord(hostCheck)} />
      </ul>
      {hostCheck.tail && (
        <div className={`border-t ${CARD_DIVIDER}`}>
          <button
            type="button"
            onClick={() => setShowTail((v) => !v)}
            aria-expanded={showTail}
            className={`flex w-full items-center gap-1.5 px-4 py-2 text-left text-[12px] font-medium outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 ${MUTED}`}
          >
            {showTail ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Host check output
          </button>
          {showTail && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-panel-2 px-4 py-3 font-mono text-[11px] leading-5 text-ink-2">
              {hostCheck.tail}
            </pre>
          )}
        </div>
      )}
    </>
  );
}
