import WorkspaceShell from "@/app/WorkspaceClient";
import ChatSection from "../ChatSection";

/**
 * Deep link to a thread in a project (`/project/:projectId/:threadId`).
 * Task and direct threads (both `tasks` rows) open their thread panel; a
 * conversation (project chat) shows the workspace chat. The id rides as a
 * path segment so the link is shareable and survives reload — the same
 * workspace shell renders, only the open thread differs.
 */
export default async function ProjectThreadPage({
  params,
}: {
  params: Promise<{ projectId: string; threadId: string }>;
}) {
  const { projectId, threadId } = await params;
  return (
    <WorkspaceShell projectId={projectId} threadId={threadId}>
      <ChatSection />
    </WorkspaceShell>
  );
}
