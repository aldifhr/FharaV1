import { redirect, useParams } from "@/lib/spaRouter";

/**
 * Old personal-chat URL (`/chats/personal/:agentId`); personal chats now live
 * at `/message/:agentId`.
 */
export default function LegacyPersonalChatPage() {
  const { agentId } = useParams<{ agentId: string }>();
  redirect(`/message/${encodeURIComponent(agentId)}`);
}
