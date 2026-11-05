import WorkspaceClient from "./WorkspaceClient";
import type { WorkspaceSection } from "../../../components/IconRail";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const { projectId } = await params;
  const { section } = await searchParams;
  const validSections: WorkspaceSection[] = ["chat", "board", "team", "activity", "health", "integrations", "memory"];
  const initialSection = validSections.includes(section as WorkspaceSection) ? section as WorkspaceSection : "chat";
  return <WorkspaceClient projectId={projectId} initialSection={initialSection} />;
}
