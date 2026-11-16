"use client";

import { MessageCircle } from "lucide-react";
import InitialAvatar from "@/components/InitialAvatar";
import Modal from "@/components/Modal";
import { roleLabel } from "@/lib/agentRoles";

export type AgentOption = {
  agent: { _id: string; name: string; role: string; avatarParams?: unknown };
};

/**
 * Personal messages: the "+" picker. Lists every enabled, non-retired agent;
 * picking one opens (get-or-create) its personal chat at `/message/<agentId>`.
 */
export default function MessageAgentModal({
  agents,
  loading,
  onClose,
  onPick,
}: {
  agents: AgentOption[] | undefined;
  loading: boolean;
  onClose: () => void;
  onPick: (agentId: string) => void;
}) {
  return (
    <Modal title="New message" onClose={onClose}>
      <p className="mt-1 text-[13px] text-ink-3">Choose an agent to start a one-to-one chat.</p>
      {loading ? (
        <p className="mt-6 text-[13px] text-ink-3" role="status">Loading agents…</p>
      ) : !agents || agents.length === 0 ? (
        <div className="mt-6 rounded-xl border border-line px-4 py-8 text-center">
          <MessageCircle size={18} className="mx-auto text-ink-3" aria-hidden="true" />
          <p className="mt-2 text-[14px] text-ink">No agents yet.</p>
          <p className="mt-1 text-[13px] text-ink-3">Add an agent to your team first.</p>
        </div>
      ) : (
        <ul className="mt-4 max-h-[60dvh] divide-y divide-line overflow-y-auto overscroll-contain rounded-xl border border-line">
          {agents.map(({ agent }) => (
            <li key={agent._id}>
              <button
                type="button"
                onClick={() => onPick(agent._id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition hover:bg-hover focus-visible:bg-hover"
              >
                <InitialAvatar agent avatarParams={agent.avatarParams} name={agent.name} size={32} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{agent.name}</span>
                <span className="shrink-0 truncate text-[12.5px] text-ink-3">{roleLabel(agent.role)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
