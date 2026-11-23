import { redirect, useParams } from "@/lib/spaRouter";

export default function WorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>();
  redirect(`/project/${projectId}`);
}
