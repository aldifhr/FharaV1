"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { attachCandidates } from "@/lib/personalChat";
import Modal from "../Modal";
import { useToast } from "../Toasts";

/**
 * Attach a project to a personal chat (plan 039 D2/D3). Lists the projects
 * the viewer can see; only those whose team includes the agent can be
 * picked. Nothing is preselected. The server re-checks everything
 * (conversations.attachProject): this list is only a convenience.
 */
export default function AttachProjectDialog({
  conversationId,
  agent,
  onClose,
}: {
  conversationId: string;
  agent: { _id: string; name: string };
  onClose: () => void;
}) {
  const toast = useToast();
  const projects = useQuery(api.projects.list, {}) as Array<{ _id: string; name: string; agentIds?: string[] }> | undefined;
  const attach = useMutation(api.conversations.attachProject);
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const rows = projects ? attachCandidates(projects, agent) : [];

  const submit = async () => {
    if (!picked) return;
    setPending(true);
    setError("");
    try {
      await attach({ conversationId: conversationId as never, projectId: picked as never });
      toast("success", "Project attached");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] : "Couldn't attach the project");
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal title="Attach project" onClose={onClose}>
      <p className="mt-2 text-[13px] text-ink-2">
        {agent.name} gets this project&apos;s memory and can read its files. The messages so far stay as they are. A chat can be attached once.
      </p>
      {projects === undefined ? (
        <p className="mt-4 text-[13px] text-ink-3" role="status">Loading projects…</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-[13px] text-ink-3">No projects yet.</p>
      ) : (
        <ul role="radiogroup" aria-label="Project" className="mt-4 max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line">
          {rows.map(({ project, blocked }) => (
            <li key={project._id}>
              <label className={`flex items-start gap-3 px-3 py-2.5 ${blocked ? "cursor-not-allowed" : "cursor-pointer hover:bg-hover"}`}>
                <input
                  type="radio"
                  name="attach-project"
                  value={project._id}
                  checked={picked === project._id}
                  disabled={blocked !== null || pending}
                  onChange={() => setPicked(project._id)}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[13.5px] ${blocked ? "text-ink-3" : "text-ink"}`}>{project.name}</span>
                  {blocked && <span className="block text-[12px] text-ink-3">{blocked}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-3 text-[13px] text-ink-2">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className="h-9 rounded-lg border border-line px-4 text-[13px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!picked || pending}
          className="h-9 rounded-lg bg-ink px-4 text-[13px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40"
        >
          {pending ? "Attaching…" : "Attach"}
        </button>
      </div>
    </Modal>
  );
}
