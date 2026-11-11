import IconRail from "@/components/IconRail";
import SandboxStudio from "@/components/sandbox/SandboxStudio";

export default function PlaygroundPage() {
  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink">
      <IconRail mobile="bar" />
      <SandboxStudio />
    </div>
  );
}