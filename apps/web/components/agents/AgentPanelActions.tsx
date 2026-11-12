"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "../Toasts";

const ACTION =
  "inline-flex h-7 items-center rounded-field border border-line px-2.5 text-[12px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50";

/**
 * Agent panel header actions: Performance, Disable/Enable (every agent, the
 * fixed team included) and Delete — only for agents outside the fixed team,
 * and only through the caller's ConfirmDialog (`onRemove`).
 */
export default function AgentPanelActions({
  agent,
  removable,
  onRemove,
}: {
  agent: { _id: string; name: string; isEnabled?: boolean };
  /** False for the nine fixed-team agents: the server refuses to delete them. */
  removable: boolean;
  onRemove?: (agent: any) => void;
}) {
  const setEnabled = useMutation(api.agentEnabled.setEnabled);
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const enabled = agent.isEnabled !== false;
  const toggle = async () => {
    setPending(true);
    try {
      await setEnabled({ agentId: agent._id as never, isEnabled: !enabled });
      toast("success", enabled ? "Agent disabled" : "Agent enabled", agent.name);
    } catch (err) {
      toast("error", enabled ? "Failed to disable agent" : "Failed to enable agent", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Link href={`/team/${agent._id}`} className={ACTION}>
        Performance
      </Link>
      <button type="button" onClick={() => void toggle()} disabled={pending} aria-pressed={!enabled} className={ACTION}>
        {enabled ? "Disable" : "Enable"}
      </button>
      {removable && onRemove && (
        <button type="button" onClick={() => onRemove(agent)} className={`${ACTION} hover:text-danger`}>
          Delete
        </button>
      )}
    </>
  );
}
