"use client";

import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";

/**
 * G10: one plain line above the composer while a worker's host is under
 * memory, disk or load pressure. At critical the worker defers new tasks
 * (they stay queued, nothing fails). Theme tokens only, no pill or card.
 */
export default function HostPressureLine() {
  const pressure = useQuery(api.appSettings.hostPressure, {});
  if (!pressure) return null;
  const what = pressure.resources.length ? pressure.resources.join(", ") : "resources";
  const host = pressure.hostname ? ` on ${pressure.hostname}` : "";
  return (
    <p className="w-full shrink-0 truncate bg-panel px-3 pb-1 text-[12.5px] text-ink-2 sm:px-8 lg:px-10" role="status" data-testid="host-pressure-line">
      {pressure.level === "critical"
        ? `Host is low on ${what}${host}: new tasks wait in the queue until it recovers.`
        : `Host is running high on ${what}${host}.`}
      <span className="text-ink-3"> Running tasks continue.</span>
    </p>
  );
}
