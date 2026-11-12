"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import ChatPanel from "@/components/ChatPanel";
import { useWorkspace } from "@/app/WorkspaceContext";

function ChatSection() {
  const { projectId, openAgent, selectTask, selectedTaskId, linkedConversationId, linkedConversationClosed } = useWorkspace();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<"chat" | "tasks" | "files">("chat");

  useEffect(() => {
    const requested = searchParams.get("tab");
    setTab(requested === "tasks" || requested === "files" ? requested : "chat");
  }, [projectId, searchParams]);

  return (
    // Keyed by project: draft, queue, selection and scroll state must not
    // leak from one project into the next (queued messages were sent to
    // the wrong project).
    <ChatPanel
      key={projectId}
      projectId={projectId}
      tab={tab}
      setTab={setTab}
      onSelectTask={selectTask}
      onOpenAgent={openAgent}
      selectedTaskId={selectedTaskId}
      conversationId={linkedConversationId ?? null}
      conversationClosed={linkedConversationClosed ?? false}
    />
  );
}

export default ChatSection;
