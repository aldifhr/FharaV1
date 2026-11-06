"use client";

import { useEffect, useState } from "react";
import ChatPanel from "@/components/ChatPanel";
import { useWorkspace } from "@/app/WorkspaceContext";

function ChatSection() {
  const { projectId, openAgent, selectTask, selectedTaskId } = useWorkspace();
  const [tab, setTab] = useState<"chat" | "tasks">("chat");

  useEffect(() => {
    setTab("chat");
  }, [projectId]);

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
