import Sidebar from "@/components/Sidebar";
import SandboxStudio from "@/components/sandbox/SandboxStudio";

export default function SandboxPage() {
  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink">
      <Sidebar />
      <SandboxStudio />
    </div>
  );
}
