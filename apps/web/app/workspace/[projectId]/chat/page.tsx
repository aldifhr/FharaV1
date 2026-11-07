import { redirect } from "next/navigation";

export default async function LegacyWorkspaceChatPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/chats/${projectId}`);
}
