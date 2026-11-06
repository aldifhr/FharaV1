import WorkspaceShell from "../../WorkspaceClient";
import ChatSection from "./ChatSection";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <WorkspaceShell projectId={id}>
      <ChatSection />
    </WorkspaceShell>
  );
}
