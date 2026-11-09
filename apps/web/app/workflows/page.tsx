import IconRail from "@/components/IconRail";
import WorkflowStudio from "@/components/workflow/WorkflowStudio";

export default function WorkflowsPage() {
  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink">
      <IconRail mobile="bar" />
      <WorkflowStudio />
    </div>
  );
}
