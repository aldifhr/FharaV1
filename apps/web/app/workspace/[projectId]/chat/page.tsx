import { redirect, useParams } from "@/lib/spaRouter";

/** Old workspace chat URL; the workspace now lives at `/project/:projectId`. */
export default function LegacyWorkspaceChatPage() {
  const { projectId } = useParams<{ projectId: string }>();
  redirect(`/project/${projectId}`);
}
