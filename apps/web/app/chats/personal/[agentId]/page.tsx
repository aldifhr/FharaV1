import { redirect } from "next/navigation";

/**
 * Old personal-chat URL (`/chats/personal/:agentId`); personal chats now live
 * at `/message/:agentId`.
 */
export default async function LegacyPersonalChatPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  redirect(`/message/${encodeURIComponent(agentId)}`);
}
