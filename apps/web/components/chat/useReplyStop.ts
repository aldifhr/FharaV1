"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "../Toasts";
import { guardStop, inFlightReply } from "@/lib/stopControl";

export type ReplyStop = { onStop: () => void; stopping: boolean };

/**
 * Composer Stop for the chat's reply in flight (chatReplies.stopReply), or
 * null when nothing is pending or streaming. A second press while the first
 * is on its way does nothing; the button reads "Stopping…" until the reply
 * settles as stopped and the button goes away.
 */
export function useReplyStop(timeline: readonly any[]): ReplyStop | null {
  const stopReply = useMutation(api.chatReplies.stopReply);
  const toast = useToast();
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const guarded = useMemo(() => guardStop((messageId: string) => stopReply({ messageId: messageId as any })), [stopReply]);
  const target = inFlightReply(timeline as any[], Date.now());
  if (!target) return null;
  return {
    stopping: stoppingId === target,
    onStop: () => {
      if (stoppingId === target) return;
      setStoppingId(target);
      void guarded(target).catch((err) => {
        setStoppingId(null);
        toast("error", "Couldn't stop the reply", err instanceof Error ? err.message : undefined);
      });
    },
  };
}
