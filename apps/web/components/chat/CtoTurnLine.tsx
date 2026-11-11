"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { ctoTurnLine, ctoTurnTickMs } from "@/lib/ctoTurnLine";
import SystemLineRow from "./SystemLineRow";

/**
 * ui-g13: the task's newest CTO decision turn as one quiet System line
 * ("Waiting on CTO · expires in 9m", "CTO answered · …", "Sent to you").
 * Renders nothing when the task never routed a question to the CTO.
 */
export default function CtoTurnLine({ taskId }: { taskId: string }) {
  const turn = useQuery(api.decisionTurns.latestForTask, { taskId: taskId as never });
  const [now, setNow] = useState(() => Date.now());
  const tick = ctoTurnTickMs(turn);
  useEffect(() => {
    if (tick === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), tick);
    return () => window.clearInterval(id);
  }, [tick, turn?._id]);
  const text = ctoTurnLine(turn, now);
  if (!text) return null;
  return (
    <div role="status" aria-live="polite">
      <SystemLineRow text={text} />
    </div>
  );
}
