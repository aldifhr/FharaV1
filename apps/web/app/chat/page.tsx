import IconRail from "../../components/IconRail";
import Sidebar from "../../components/Sidebar";
import { GridPattern } from "@/components/ui/grid-pattern";
import { TextAnimate } from "@/components/ui/text-animate";
import { ShimmerButton } from "@/components/ui/shimmer-button";

export default function ChatPage() {
  return (
    <div className="flex h-screen overflow-hidden bg-[#f7f7fb] text-[#24232d] dark:bg-gray-950 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 items-center justify-center bg-white p-6 dark:bg-gray-950">
        <GridPattern className="pointer-events-none absolute inset-0" />
        <div className="relative max-w-md text-center">
          <TextAnimate animation="fadeIn" as="h1" className="text-xl font-semibold" by="word">Select a project</TextAnimate>
          <p className="mt-2 text-sm text-gray-500">
            Select a project from the sidebar to open its agent chat and tasks.
          </p>
          <ShimmerButton shimmerDuration="2.5s" className="mt-4 rounded-lg px-4 py-2 text-sm">Open sidebar →</ShimmerButton>
        </div>
      </main>
    </div>
  );
}
