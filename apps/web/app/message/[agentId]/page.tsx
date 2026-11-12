"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Sidebar from "@/components/Sidebar";
import PersonalChatPanel from "@/components/chat/PersonalChatPanel";

/**
 * Personal chat with one agent (plan 039) at `/message/:agentId`, opened from
 * the Personal messages page like a project. get-or-create is idempotent per
 * agent, so a reload or a deep link opens the same conversation.
 */
export default function PersonalAgentChatPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const getOrCreate = useMutation(api.conversations.getOrCreatePersonal);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const requested = useRef<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (!agentId || requested.current === agentId) return;
    requested.current = agentId;
    setConversationId(null);
    setError("");
    setSidebarOpen(false);
    getOrCreate({ agentId: agentId as never }).then(
      (id) => setConversationId(id as string),
      (err) => setError(err instanceof Error ? err.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] : "Couldn't open this chat"),
    );
  }, [agentId, getOrCreate]);

  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink">
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden max-[979px]:flex-col">
        <Sidebar drawerOpen={sidebarOpen} onCloseDrawer={() => setSidebarOpen(false)} onSelectProject={() => setSidebarOpen(false)} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
          {error ? (
            <div className="mx-auto w-full max-w-3xl px-6 py-10">
              <p className="text-[14px] text-ink-2">{error}</p>
              <Link href="/messages" className="mt-3 inline-block text-[13px] text-ink-3 hover:text-ink">
                Back to personal messages
              </Link>
            </div>
          ) : conversationId ? (
            <PersonalChatPanel
              conversationId={conversationId}
              onNewChat={setConversationId}
              onOpenSidebar={() => setSidebarOpen(true)}
            />
          ) : (
            <p className="mx-auto w-full max-w-3xl px-6 py-10 text-[13px] text-ink-3" role="status">
              Opening chat…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
