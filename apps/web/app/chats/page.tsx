import Link from "next/link";
import Sidebar from "@/components/Sidebar";

export default function ChatPage() {
  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink max-[979px]:h-auto max-[979px]:min-h-dvh max-[979px]:flex-col">
      <Sidebar mobile="inline" />
      <main className="flex min-w-0 flex-1 items-center justify-center bg-dots p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-[17px] font-semibold">Pick a project</h1>
          <p className="mt-1.5 text-[15px] text-ink-2">Choose a project from the sidebar to open its team chat, tasks and files.</p>
          <Link href="/" className="mt-4 inline-flex h-9 items-center rounded-lg bg-ink px-4 text-[14px] font-medium text-canvas hover:bg-ink/85">
            View overview
          </Link>
        </div>
      </main>
    </div>
  );
}
