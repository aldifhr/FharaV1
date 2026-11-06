import { createContext, useContext, type ReactNode } from "react";

export type Agent = {
  _id: string;
  name: string;
  role: string;
  status: "idle" | "working" | "queued" | "needs_you";
  llmModel?: string;
  llmProvider?: string;
  llmApiKeyConfigured?: boolean;
  avatarParams?: any;
};

export type Task = { _id: string; title: string; status: string };

export interface WorkspaceContextValue {
  projectId: string;
  agents: Agent[] | undefined;
  tasks: Task[] | undefined;
  selectedTaskId: string | null;
  threadCollapsed: boolean;
  highlightAgentId: string | null;
  selectTask: (taskId: string) => void;
  toggleThread: () => void;
  closeThread: () => void;
  openAgent: (agentId: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return context;
}

export function SectionLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="mt-6 space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="mt-3 h-3 w-4/5" />
          <Skeleton className="mt-2 h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-md bg-gray-200/80 dark:bg-gray-800 ${className}`} />;
}
