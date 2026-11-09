import IconRail from "@/components/IconRail";
import BrowserLab from "@/components/browser-lab/BrowserLab";

export default function BrowserLabPage() {
  return (
    <div className="flex h-dvh overflow-hidden bg-panel text-ink">
      <IconRail mobile="bar" />
      <BrowserLab />
    </div>
  );
}
