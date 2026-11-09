import IconRail from "@/components/IconRail";
import KnowledgeGraph from "@/components/knowledge/KnowledgeGraph";

export default function KnowledgePage() {
  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink">
      <IconRail mobile="bar" />
      <KnowledgeGraph />
    </div>
  );
}
