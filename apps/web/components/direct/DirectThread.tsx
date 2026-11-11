"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { Skeleton } from "@/app/WorkspaceContext";
import { useToast } from "@/components/Toasts";
import { decisionKey, focusedBoxHasText, useKeybindings } from "@/lib/keybindings";
import type { ApprovalRow, OptimisticMessage, QuestionRow, TranscriptRow } from "@/lib/threadbear/types";
import { useDirectTranscript } from "./useDirectTranscript";
import TranscriptRows from "./TranscriptRows";
import DirectComposer from "./DirectComposer";

const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);
const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] : "Please try again.");
const isMacPlatform = () => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
};

/** The newest card still waiting on the user, and the newest open question. */
function waitingOn(rows: readonly TranscriptRow[]): { card?: ApprovalRow; question?: QuestionRow } {
  let card: ApprovalRow | undefined;
  let question: QuestionRow | undefined;
  for (const row of rows) {
    if (row.kind === "approval" && row.state === "pending") card = row;
    else if (row.kind === "question" && row.state === "open") question = row;
  }
  return { card, question };
}
const newClientId = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Threadbear T3: the body of a direct thread (`task.mode === "direct"`),
 * shown inside the task thread panel under its header (which carries the
 * D8 goal line). Transcript from the streamed events, Load earlier, the
 * composer (send / steer / `/goal`, Stop, effort).
 */
export default function DirectThread({ taskId, projectId }: { taskId: string; projectId?: string }) {
  const toast = useToast();
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([]);
  const { task, rows, running, loading, hasEarlier, loadingEarlier, loadEarlier } = useDirectTranscript(taskId, projectId, optimistic);
  const send = useMutation(api.directThreads.send);
  const respond = useMutation(api.directThreads.respond);
  const interrupt = useMutation(api.directThreads.interrupt);
  const setEffort = useMutation(api.directThreadSettings.setEffort);
  const closed = task ? TERMINAL.has(task.status) : false;

  // Messages the tail has returned leave the optimistic list.
  const stored = useMemo(() => new Set(rows.flatMap((r) => (r.kind === "user" && !r.sending && r.clientId ? [r.clientId] : []))), [rows]);
  useEffect(() => {
    setOptimistic((list) => (list.some((m) => stored.has(m.clientId)) ? list.filter((m) => !stored.has(m.clientId)) : list));
  }, [stored]);

  const sendText = useCallback(
    async (text: string): Promise<boolean> => {
      const clientId = newClientId();
      // A slash command (`/goal`) writes no message, so it gets no optimistic row.
      const shown = !text.startsWith("/");
      if (shown) setOptimistic((list) => [...list, { clientId, text }]);
      try {
        await send({ taskId: taskId as any, text, clientId });
        return true;
      } catch (err) {
        if (shown) setOptimistic((list) => list.filter((m) => m.clientId !== clientId));
        toast("error", "Couldn't send", errorText(err));
        return false;
      }
    },
    [send, taskId, toast],
  );
  const onRespond = useCallback(
    async (approvalId: string, decision: "allow" | "deny") => {
      try {
        await respond({ approvalId: approvalId as any, decision });
      } catch (err) {
        toast("error", decision === "allow" ? "Couldn't allow" : "Couldn't deny", errorText(err));
      }
    },
    [respond, toast],
  );
  const onStop = useCallback(async () => {
    try {
      await interrupt({ taskId: taskId as any });
    } catch (err) {
      toast("error", "Couldn't stop the agent", errorText(err));
    }
  }, [interrupt, taskId, toast]);
  const onEffort = useCallback(
    async (effort: string | null) => {
      try {
        await setEffort({ taskId: taskId as any, effort });
      } catch (err) {
        toast("error", "Couldn't change the effort", errorText(err));
      }
    },
    [setEffort, taskId, toast],
  );

  // N8 hotkeys: allow / deny the waiting card, pick an option on the open question.
  const bindings = useKeybindings();
  const waiting = useMemo(() => waitingOn(rows), [rows]);
  useEffect(() => {
    if (closed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const decision = decisionKey(e, bindings, { typing: focusedBoxHasText(document.activeElement), mac: isMacPlatform() });
      if (!decision) return;
      if (decision.kind === "option") {
        const option = waiting.question?.options[decision.index];
        if (!option) return;
        e.preventDefault();
        void sendText(option);
        return;
      }
      if (!waiting.card) return;
      e.preventDefault();
      void onRespond(waiting.card.approvalId, decision.kind === "approve" ? "allow" : "deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings, closed, waiting, sendText, onRespond]);

  // Stay pinned to the newest row unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastKey = rows.at(-1)?.key;
  const lastText = rows.at(-1)?.kind === "assistant" ? (rows.at(-1) as { text: string }).text.length : 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, lastText]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <>
      <div ref={scrollRef} onScroll={onScroll} className="bg-dots min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="space-y-3" role="status" aria-label="Loading the thread">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ) : task === null ? (
          <p className="text-[14px] text-ink-2">This thread is no longer available.</p>
        ) : (
          <>
            {hasEarlier && (
              <div className="mb-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadEarlier()}
                  disabled={loadingEarlier}
                  className="rounded-field px-2 py-1 text-[12.5px] text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
                >
                  {loadingEarlier ? "Loading…" : "Load earlier"}
                </button>
              </div>
            )}
            {rows.length === 0 ? (
              <p className="text-center text-[13px] text-ink-3">{running ? "The agent is starting…" : "Send a message to start."}</p>
            ) : (
              <TranscriptRows rows={rows} actions={{ taskId, turnOpen: running, closed, onRespond, onAnswer: sendText }} />
            )}
          </>
        )}
      </div>
      <DirectComposer
        running={running && !closed}
        closed={closed}
        effort={(task?.direct?.effort as string | undefined) ?? null}
        onSend={sendText}
        onStop={onStop}
        onEffort={onEffort}
      />
    </>
  );
}
