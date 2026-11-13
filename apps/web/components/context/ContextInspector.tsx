"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "@/components/Toasts";
import { CALL_ROLE_LABELS, sectionShares, type CallRole } from "@/api/convex/lib/contextSnapshot";
import { roleLabel } from "@/lib/agentRoles";
import { clockTime } from "@/lib/format";
import { formatDuration, formatTokens } from "@/lib/runFormat";
import CallStats from "./CallStats";

function callRoleLabel(role: string): string {
  return CALL_ROLE_LABELS[role as CallRole] ?? role;
}

function useCopy() {
  const toast = useToast();
  return async (text: string, what: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is not available in this browser.");
      await navigator.clipboard.writeText(text);
      toast("success", `${what} copied`, `${text.length.toLocaleString("en-US")} chars`);
    } catch (error) {
      toast("error", "Copy failed", error instanceof Error ? error.message : undefined);
    }
  };
}

export function CopyButton({ text, what, label = "Copy" }: { text: string; what: string; label?: string }) {
  const copy = useCopy();
  return (
    <button
      type="button"
      onClick={() => void copy(text, what)}
      className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
      aria-label={`Copy ${what}`}
    >
      <Copy size={12} /> {label}
    </button>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="truncate text-[12.5px] tabular-nums text-ink">{children}</dd>
    </div>
  );
}

function SectionRow({
  label,
  tokens,
  share,
  content,
  truncatedChars,
  defaultOpen,
}: {
  label: string;
  tokens: number;
  share: number;
  content: string;
  truncatedChars?: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] text-ink hover:text-ink"
        >
          {open ? <ChevronDown size={13} className="shrink-0 text-ink-3" /> : <ChevronRight size={13} className="shrink-0 text-ink-3" />}
          <span className="truncate">{label}</span>
        </button>
        <span className="w-24 shrink-0 max-sm:hidden" aria-hidden="true">
          <span className="block h-1 rounded-full bg-hover">
            <span className="block h-1 rounded-full bg-ink-3" style={{ width: `${Math.min(100, Math.max(1, share))}%` }} />
          </span>
        </span>
        <span className="w-28 shrink-0 text-right text-[12px] tabular-nums text-ink-3">
          ~{formatTokens(tokens)} · {share}%
        </span>
        <CopyButton text={content} what={label} label="" />
      </div>
      {open && (
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
          {content || "(empty)"}
        </pre>
      )}
      {open && truncatedChars ? (
        <p className="mt-1 text-[11.5px] text-ink-3">Stored copy cut by {truncatedChars.toLocaleString("en-US")} chars (snapshot cap).</p>
      ) : null}
    </li>
  );
}

/** Context Inspector for one snapshot: sections with token share, tools, memory, skills, history. */
export default function ContextInspector({ snapshotId }: { snapshotId: string }) {
  const snap = useQuery(api.contextSnapshots.get, { snapshotId: snapshotId as never });
  if (snap === undefined) {
    return (
      <div className="space-y-2" aria-label="Loading context">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-8 rounded-lg bg-hover" />
        ))}
      </div>
    );
  }
  if (snap === null) return <p className="text-[13px] text-ink-3">This snapshot is gone (past retention or deleted).</p>;

  const shares = sectionShares(snap.sectionStats);
  const bodyByKey = new Map(snap.sections.map((s) => [s.key, s]));
  const fullText = snap.sections.map((s) => `## ${s.label}\n${s.content}`).join("\n\n");
  const total = snap.promptTokens;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-ink-2">
          {callRoleLabel(snap.callRole)}
          {snap.agentRole ? ` · ${roleLabel(snap.agentRole)}` : ""}
          {snap.subtaskKey ? ` · ${snap.subtaskKey}` : ""}
          <span className="text-ink-3"> · {clockTime(snap.createdAt)}</span>
        </p>
        <div className="flex items-center gap-3">
          <CopyButton text={fullText} what="Prompt" label="Copy prompt" />
          <CopyButton text={snap.response} what="Response" label="Copy response" />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Model">{snap.model ?? "—"}</Fact>
        <Fact label="Provider">{snap.provider ?? "—"}</Fact>
        <Fact label="Temperature">{snap.temperature ?? "default"}</Fact>
        <Fact label="Duration">{formatDuration(snap.durationMs ?? null)}</Fact>
        <Fact label="Tokens in / out">
          {snap.usageEstimated ? "≈" : ""}
          {formatTokens(snap.inputTokens ?? null)} / {formatTokens(snap.outputTokens ?? null)}
        </Fact>
        <Fact label="Prompt estimate">~{formatTokens(total)}</Fact>
        <Fact label="History">{snap.historyMessages} {snap.historyMessages === 1 ? "message" : "messages"}</Fact>
        <Fact label="Memory">{snap.memoryIncluded ? "included" : "none"}</Fact>
      </dl>
      <CallStats stats={snap} />

      {snap.error && (
        <p className="rounded-lg border border-line px-3 py-2 font-mono text-[12px] text-red-600 dark:text-red-400">{snap.error}</p>
      )}

      <div>
        <h3 className="mb-1 text-[12.5px] font-medium text-ink-2">Prompt sections</h3>
        <ul className="divide-y divide-line">
          {shares.map((s) => (
            <SectionRow
              key={s.key}
              label={s.label}
              tokens={s.tokens}
              share={s.share}
              content={bodyByKey.get(s.key)?.content ?? ""}
              truncatedChars={bodyByKey.get(s.key)?.truncatedChars}
            />
          ))}
        </ul>
        <p className="mt-1 text-[11.5px] text-ink-3">Token counts per section are chars/4 estimates. Secrets are redacted before storage.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-1 text-[12.5px] font-medium text-ink-2">Tools</h3>
          {snap.toolNames.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">No tools in this prompt.</p>
          ) : (
            <ul className="divide-y divide-line">
              {snap.toolNames.map((t) => (
                <li key={t} className="py-1 font-mono text-[12px] text-ink">{t}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-[12.5px] font-medium text-ink-2">Skills</h3>
          {snap.skillNames.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">No library skills loaded.</p>
          ) : (
            <ul className="divide-y divide-line">
              {snap.skillNames.map((t) => (
                <li key={t} className="py-1 text-[12.5px] text-ink">{t}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="text-[12.5px] font-medium text-ink-2">Response</h3>
          {snap.responseTruncatedChars ? (
            <span className="text-[11.5px] text-ink-3">cut by {snap.responseTruncatedChars.toLocaleString("en-US")} chars</span>
          ) : null}
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
          {snap.response || "(no response)"}
        </pre>
      </div>
    </div>
  );
}

type ListRow = {
  _id: string;
  callRole: string;
  agentRole?: string;
  subtaskKey?: string;
  model?: string;
  promptTokens: number;
  error?: string;
  createdAt: number;
};

/** A list of snapshots (one run or one chat bubble) with one inspected at a time. */
export function SnapshotPicker({
  rows,
  selected,
  onSelect,
}: {
  rows: ListRow[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r._id}>
          <button
            type="button"
            onClick={() => onSelect(r._id)}
            aria-current={selected === r._id}
            className={`flex w-full items-center gap-3 px-2 py-2 text-left text-[13px] hover:bg-hover ${selected === r._id ? "bg-hover" : ""}`}
          >
            <span className="w-12 shrink-0 tabular-nums text-ink-3">{clockTime(r.createdAt)}</span>
            <span className="min-w-0 flex-1 truncate text-ink">
              {callRoleLabel(r.callRole)}
              {r.agentRole ? ` · ${roleLabel(r.agentRole)}` : ""}
              {r.subtaskKey ? <span className="text-ink-3"> · {r.subtaskKey}</span> : null}
            </span>
            {r.error && <span className="shrink-0 text-[12px] text-red-600 dark:text-red-400">error</span>}
            <span className="shrink-0 text-[12px] tabular-nums text-ink-3">~{formatTokens(r.promptTokens)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
