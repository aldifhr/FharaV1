"use client";

import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import HostPressureLine from "./HostPressureLine";

/**
 * One plain line above the composer while the global automation hold
 * (GOAT G3, Settings → Scheduled tasks) is on, so a quiet chat is not
 * mistaken for a stuck one. Theme tokens only, no pill or card.
 */
export default function AutomationHoldLine() {
  const hold = useQuery(api.appSettings.automationHold, {});
  // G10's host pressure line rides here, so ChatPanel needs no new slot.
  if (!hold) return <HostPressureLine />;
  return (
    <>
      <HostPressureLine />
      <p className="w-full shrink-0 truncate bg-panel px-3 pb-1 text-[12.5px] text-ink-2 sm:px-8 lg:px-10" role="status" data-testid="automation-hold-line">
        Automation is held: auto-merge, issue intake and automatic fixes wait. Your own tasks still run.
        <span className="text-ink-3"> Resume in Settings → Scheduled tasks.</span>
      </p>
    </>
  );
}
