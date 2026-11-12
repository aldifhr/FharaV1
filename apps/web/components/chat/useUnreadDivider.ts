import { useEffect, useRef, useState, type RefObject } from "react";
import { readLastRead, writeLastRead } from "@/lib/lastRead";

type TimelineRow = { _creationTime: number; authorType?: string };

/**
 * Unread "• New" divider: last-read timestamp per conversation.
 * `lastReadAt` advances (and persists) as the user reads to the bottom; the
 * divider stays where it was when the conversation was opened, so it does
 * not vanish the moment the view auto-scrolls. Sending a message means the
 * user caught up: the divider goes away.
 */
export function useUnreadDivider({
  conversationKey,
  projectId,
  timeline,
  lastMessage,
  scrollRef,
}: {
  conversationKey: string;
  projectId: string;
  timeline: readonly TimelineRow[];
  lastMessage: TimelineRow | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const lastReadRef = useRef<number>(0);
  const [dividerAt, setDividerAt] = useState<number | null>(null);
  useEffect(() => {
    // The pre-conversation per-project key stays readable after the switch.
    const stored = readLastRead(conversationKey) ?? readLastRead(projectId);
    lastReadRef.current = stored ?? 0;
    // First visit (nothing stored): the backlog is not "new".
    setDividerAt(stored ?? Number.POSITIVE_INFINITY);
  }, [conversationKey, projectId]);
  const markSeen = () => {
    const seen = lastMessage?._creationTime ?? 0;
    if (!seen || seen <= lastReadRef.current) return;
    lastReadRef.current = seen;
    writeLastRead(conversationKey, seen);
  };
  useEffect(() => {
    if (timeline.length === 0 || dividerAt === null) return;
    const el = scrollRef.current;
    const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
    if ((atBottom && document.visibilityState === "visible") || dividerAt === Number.POSITIVE_INFINITY) markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markSeen is recreated each render; these are the triggers
  }, [timeline, conversationKey, dividerAt]);
  const firstNewIndex =
    dividerAt === null ? -1 : timeline.findIndex((m) => m._creationTime > dividerAt && m.authorType !== "user");
  /** The user caught up (sent a message): hide the divider. */
  const clearDivider = () => setDividerAt(Number.POSITIVE_INFINITY);
  return { firstNewIndex, markSeen, clearDivider };
}
