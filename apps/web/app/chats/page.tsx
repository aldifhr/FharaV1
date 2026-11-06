import IconRail from "../../components/IconRail";
import Sidebar from "../../components/Sidebar";
import Link from "next/link";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";

export default function ChatPage() {
  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-[#24232d] dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 items-center justify-center bg-transparent p-6">
        <div className="relative max-w-md text-center">
          <TextGenerateEffect
            duration={0.4}
            className="text-center text-xl font-semibold leading-snug text-gray-900 dark:text-white"
            words="Select a project"
          />
          <p className="mt-2 text-sm text-gray-500">
            Choose a project from the sidebar to open its agent chat and tasks.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
          >
            View projects →
          </Link>
        </div>
      </main>
    </div>
  );
}
