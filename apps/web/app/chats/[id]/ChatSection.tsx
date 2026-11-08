"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import ChatPanel from "@/components/ChatPanel";
import { useWorkspace } from "@/app/WorkspaceContext";

function ChatSection() {
  const { projectId, openAgent, selectTask, selectedTaskId } = useWorkspace();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<"chat" | "tasks">("chat");

  useEffect(() => {
    const requested = searchParams.get("tab");
    setTab(requested === "tasks" ? requested : "chat");
  }, [projectId, searchParams]);

  return (
    <ChatPanel
      projectId={projectId}
      tab={tab}
      setTab={setTab}
      onSelectTask={selectTask}
      onOpenAgent={openAgent}
      selectedTaskId={selectedTaskId}
    />
  );
}

export default ChatSection;
