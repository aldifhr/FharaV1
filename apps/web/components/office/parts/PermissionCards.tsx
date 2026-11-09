"use client";
/*
 * Permission cards beside the office. The idea (a card per waiting
 * permission, answered from the office) follows Claude-Office's
 * src/components/PermissionCard.tsx (MIT, Copyright (c) 2026 W17ANT); the
 * buttons call Fhara's own mutations:
 *   run_command  -> commandApprovals.respond  (allow / always / deny)
 *   anything else (git_push, apply_changes, merge_pr, plan)
 *                -> approvals.approve / approvals.reject
 * "Selalu izinkan" only shows when the server offered it (never for push,
 * merge or destructive commands; the server downgrades it anyway).
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";
import type { ApprovalCardModel } from "../feed";

const KIND_LABEL: Record<string, string> = {
  run_command: "Jalankan perintah",
  git_push: "Push",
  apply_changes: "Terapkan perubahan",
  merge_pr: "Merge PR",
  plan: "Rencana",
};

type Decision = "allow" | "always" | "deny" | "approve" | "reject";

export default function PermissionCards({ cards, highlightId }: { cards: ApprovalCardModel[]; highlightId?: string | null }) {
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const respond = useMutation(api.commandApprovals.respond);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ card: ApprovalCardModel; request: ConfirmRequest } | null>(null);

  if (cards.length === 0) return null;

  const decide = async (card: ApprovalCardModel, decision: Decision) => {
    setBusy(card.id);
    try {
      if (card.channel === "command") {
        const d = decision === "approve" ? "allow" : decision === "reject" ? "deny" : decision;
        await respond({ approvalId: card.id as never, decision: d as "allow" | "always" | "deny" });
      } else if (decision === "approve" || decision === "allow") {
        await approve({ approvalId: card.id as never });
      } else {
        await reject({ approvalId: card.id as never });
      }
    } catch (err) {
      toast("error", "Keputusan tidak tersimpan", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const askReject = (card: ApprovalCardModel) =>
    setConfirm({
      card,
      request: {
        title: card.kind === "plan" ? "Tolak rencana ini?" : card.kind === "git_push" ? "Tolak push ini?" : "Tolak permintaan ini?",
        message: card.kind === "plan" ? "Task ini akan berhenti sebagai ditolak." : "Agen akan melanjutkan tanpa izin ini.",
        confirmLabel: "Tolak",
        tone: "danger",
      },
    });

  return (
    <section aria-label="Menunggu keputusan" className="rounded-xl border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-medium text-ink">Menunggu keputusan</h2>
        <span className="text-[12px] text-ink-3">{cards.length}</span>
      </header>
      <ul className="divide-y divide-line">
        {cards.map((card) => (
          <li key={card.id} className={`px-4 py-3 ${highlightId && card.agentId === highlightId ? "bg-hover" : ""}`}>
            <p className="text-[12px] text-ink-3">
              {KIND_LABEL[card.kind] ?? card.kind}
              {card.agentName ? ` · ${card.agentName}` : ""}
              {" · "}
              <Link href={`/runs/${card.taskId}`} className="hover:text-ink">buka task</Link>
            </p>
            <p className="mt-0.5 text-[13.5px] leading-snug text-ink">{card.summary}</p>
            {card.command && (
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink">
                {card.command}
              </pre>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy === card.id}
                onClick={() => (card.channel === "command" ? void decide(card, "deny") : askReject(card))}
                className="rounded-lg px-2.5 py-1 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50"
              >
                Tolak
              </button>
              {card.offerAlways && (
                <button
                  type="button"
                  disabled={busy === card.id}
                  onClick={() => void decide(card, "always")}
                  className="rounded-lg border border-line px-2.5 py-1 text-[13px] text-ink transition hover:bg-hover disabled:opacity-50"
                >
                  Selalu izinkan
                </button>
              )}
              <button
                type="button"
                disabled={busy === card.id}
                onClick={() => void decide(card, card.channel === "command" ? "allow" : "approve")}
                className="rounded-lg bg-ink px-2.5 py-1 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50"
              >
                {card.channel === "command" ? "Izinkan" : card.kind === "git_push" ? "Setujui push" : "Setujui"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        request={confirm?.request ?? null}
        pending={busy !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const card = confirm?.card;
          setConfirm(null);
          if (card) void decide(card, "reject");
        }}
      />
    </section>
  );
}
