import { redirect } from "next/navigation";

/** Old workspace chat URL; the workspace now lives at `/project/:projectId`. */
export default async function LegacyWorkspaceChatPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/project/${projectId}`);
}
