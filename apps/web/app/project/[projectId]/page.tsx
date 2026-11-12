import WorkspaceShell from "@/app/WorkspaceClient";
import ChatSection from "./ChatSection";

/**
 * A project's workspace at its canonical URL (`/project/:projectId`): team
 * chat, tasks and files. A thread opens in app state, or at its deep link
 * `/project/:projectId/:threadId` (see `app/project/[projectId]/[threadId]`).
 * Either way the same workspace shell renders.
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <WorkspaceShell projectId={projectId}>
      <ChatSection />
    </WorkspaceShell>
  );
}
