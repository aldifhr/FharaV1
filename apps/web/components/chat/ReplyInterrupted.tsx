"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { RotateCcw } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "../Toasts";

/**
 * Quiet line under a reply whose run died (stale sweep or a failed run):
 * what happened plus one action. Theme tokens only, no badge.
 */
export default function ReplyInterrupted({
  userMessageId,
  reason,
  align = "start",
}: {
  userMessageId: string;
  reason?: string;
  align?: "start" | "end";
}) {
  const retry = useMutation(api.chatReplies.retryReply);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="status"
      className={`mt-1 flex items-center gap-2 text-[12px] text-ink-3 ${align === "end" ? "justify-end pr-1" : "pl-1"}`}
      title={reason}
    >
      <span>Reply interrupted</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const res = await retry({ messageId: userMessageId as any });
            if (!res.retried) toast("info", "This reply can no longer be retried.");
          } catch (err) {
            toast("error", "Couldn't retry", err instanceof Error ? err.message : undefined);
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex items-center gap-1 font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
      >
        <RotateCcw size={12} aria-hidden />
        {busy ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
