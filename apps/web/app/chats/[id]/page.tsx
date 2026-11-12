import { redirect } from "next/navigation";

/**
 * Legacy project URL (`/chats/:projectId`), kept for old bookmarks. The
 * workspace now lives at `/project/:projectId`; the query (`?task=`, `?tab=`)
 * is carried over so an old deep link still lands on the same view.
 */
export default async function LegacyChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value)) for (const item of value) query.append(key, item);
  }
  const qs = query.toString();
  redirect(`/project/${id}${qs ? `?${qs}` : ""}`);
}
