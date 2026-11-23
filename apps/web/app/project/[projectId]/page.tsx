import WorkspaceShell from "@/app/WorkspaceClient";
import ChatSection from "./ChatSection";
import { useParams } from "@/lib/spaRouter";

/**
 * A project's workspace at its canonical URL (`/project/:projectId`): team
 * chat, tasks and files. A thread opens in app state, or at its deep link
 * `/project/:projectId/:threadId` (see `app/project/[projectId]/[threadId]`).
 * Either way the same workspace shell renders.
 */
export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <WorkspaceShell projectId={projectId}>
      <ChatSection />
    </WorkspaceShell>
  );
}
