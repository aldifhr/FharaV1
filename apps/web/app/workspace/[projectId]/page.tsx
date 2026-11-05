import WorkspaceClient from "./WorkspaceClient";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <WorkspaceClient projectId={projectId} />;
}
