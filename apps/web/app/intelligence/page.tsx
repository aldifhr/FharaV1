import "@react-sigma/core/lib/style.css";
import IconRail from "@/components/IconRail";
import ProjectIntelligence from "@/components/intelligence/ProjectIntelligence";

export default function IntelligencePage() {
  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink">
      <IconRail mobile="bar" />
      <ProjectIntelligence />
    </div>
  );
}
