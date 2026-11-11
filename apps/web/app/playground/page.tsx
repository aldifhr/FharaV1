import Sidebar from "@/components/Sidebar";
import SandboxStudio from "@/components/sandbox/SandboxStudio";

export default function PlaygroundPage() {
  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink max-[979px]:flex-col">
      <Sidebar />
      <SandboxStudio />
    </div>
  );
}