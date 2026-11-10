"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import PersonalChatPanel from "@/components/chat/PersonalChatPanel";

/**
 * Personal chat with one agent (plan 039). get-or-create is idempotent per
 * agent, so a reload opens the same conversation.
 */
export default function PersonalAgentChatPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const getOrCreate = useMutation(api.conversations.getOrCreatePersonal);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (!agentId || requested.current === agentId) return;
    requested.current = agentId;
    setConversationId(null);
    setError("");
    getOrCreate({ agentId: agentId as never }).then(
      (id) => setConversationId(id as string),
      (err) => setError(err instanceof Error ? err.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] : "Couldn't open this chat"),
    );
  }, [agentId, getOrCreate]);

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink max-[979px]:flex-col">
      <IconRail />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error ? (
          <div className="mx-auto w-full max-w-3xl px-6 py-10">
            <p className="text-[14px] text-ink-2">{error}</p>
            <Link href="/chats/personal" className="mt-3 inline-block text-[13px] text-ink-3 hover:text-ink">
              Back to personal chat
            </Link>
          </div>
        ) : conversationId ? (
          <PersonalChatPanel conversationId={conversationId} onNewChat={setConversationId} />
        ) : (
          <p className="mx-auto w-full max-w-3xl px-6 py-10 text-[13px] text-ink-3" role="status">
            Opening chat…
          </p>
        )}
      </div>
    </div>
  );
}
