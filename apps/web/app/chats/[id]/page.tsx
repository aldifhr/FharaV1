import { redirect, useParams, useSearchParams } from "@/lib/spaRouter";

/**
 * Legacy project URL (`/chats/:projectId`), kept for old bookmarks. The
 * workspace now lives at `/project/:projectId`; the query (`?task=`, `?tab=`)
 * is carried over so an old deep link still lands on the same view.
 */
export default function LegacyChatPage() {
  const { id } = useParams<{ id: string }>();
  const qs = useSearchParams().toString();
  redirect(`/project/${id}${qs ? `?${qs}` : ""}`);
}
