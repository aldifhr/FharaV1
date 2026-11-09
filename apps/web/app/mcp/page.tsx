import { redirect } from "next/navigation";

/** /mcp moved into /integrations; old links and bookmarks land there. */
export default async function McpPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  redirect(project ? `/integrations?project=${encodeURIComponent(project)}` : "/integrations");
}
