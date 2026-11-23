import WorkspaceShell from "@/app/WorkspaceClient";
import ChatSection from "../ChatSection";
import { useParams } from "@/lib/spaRouter";

/**
 * Deep link to a thread in a project (`/project/:projectId/:threadId`).
 * A task thread (a `tasks` row) opens its thread panel; a
 * conversation (project chat) shows the workspace chat. The id rides as a
 * path segment so the link is shareable and survives reload — the same
 * workspace shell renders, only the open thread differs.
 */
export default function ProjectThreadPage() {
  const { projectId, threadId } = useParams<{ projectId: string; threadId: string }>();
  return (
    <WorkspaceShell projectId={projectId} threadId={threadId}>
      <ChatSection />
    </WorkspaceShell>
  );
}
