import Link from "next/link";
import { projectHref } from "@/lib/threadTree";

/**
 * Main view for a deep link whose thread id names nothing in this project
 * (`/project/:projectId/:threadId`): an unknown id, or a thread of another
 * project. Plain text and a way back; no tint.
 */
export default function ThreadNotFound({ projectId }: { projectId: string }) {
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-dots px-6 py-10">
      <div className="mx-auto w-full max-w-3xl" role="status">
        <h1 className="text-[16px] font-semibold text-ink">Thread not found</h1>
        <p className="mt-1.5 text-[14px] text-ink-2">This link doesn&apos;t match a task or conversation in this project.</p>
        <Link href={projectHref(projectId)} className="mt-3 inline-block text-[13px] text-ink-3 hover:text-ink">
          Back to project chat
        </Link>
      </div>
    </main>
  );
}
