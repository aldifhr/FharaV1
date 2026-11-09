"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Modal from "../Modal";
import { useToast } from "../Toasts";
import { roleLabel } from "@/lib/agentRoles";

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");

type ProjectDoc = {
  name?: string;
  workspacePath?: string;
  approvalMode?: "ask" | "auto";
  agentIds?: string[];
  instructions?: string;
};

const field = "rounded-lg border border-line bg-panel px-3 py-2 text-ink outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/15";

/** Project settings: name, folder, approval mode, instructions, team. */
export default function ManageProjectModal({
  projectId,
  project,
  allAgents,
  onClose,
}: {
  projectId: string;
  project: ProjectDoc;
  allAgents: { _id: string; role: string }[];
  onClose: () => void;
}) {
  const toast = useToast();
  const updateProject = useMutation(api.projects.update);
  const updateTeam = useMutation(api.projects.updateTeam);
  const [name, setName] = useState(project.name ?? "");
  const [path, setPath] = useState(project.workspacePath ?? "");
  const [approvalMode, setApprovalMode] = useState<"ask" | "auto">(project.approvalMode ?? "ask");
  const [agentIds, setAgentIds] = useState<string[]>(project.agentIds ?? []);
  const [instructions, setInstructions] = useState(project.instructions ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await updateProject({ projectId: projectId as never, name, workspacePath: path, approvalMode, instructions });
    } catch (err) {
      setError(`Couldn't save project settings: ${errorText(err)}`);
      setSaving(false);
      return;
    }
    try {
      await updateTeam({ projectId: projectId as never, agentIds: agentIds as never[] });
      toast("success", "Project updated");
      onClose();
    } catch (err) {
      // Settings above already saved: say exactly which part failed.
      setError(`Project settings saved, but the team couldn't be updated: ${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Manage project · ${name}`} onClose={onClose} maxWidth="max-w-lg">
      <form onSubmit={save} className="mt-4 grid gap-3 text-[14px]">
        <label className="grid gap-1">
          Project name
          <input value={name} onChange={(e) => setName(e.target.value)} required className={field} />
        </label>
        <label className="grid gap-1">
          Folder path
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/your/repo" className={field} />
        </label>
        <label className="grid gap-1">
          Approval mode
          <select value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as "ask" | "auto")} className={field}>
            <option value="ask">Ask before changes</option>
            <option value="auto">Auto-approve</option>
          </select>
        </label>
        <label className="grid gap-1">
          Shared instructions
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            placeholder="Durable project instructions loaded into planning every run (e.g. architecture rules, conventions)."
            className={field}
          />
        </label>
        <fieldset className="grid gap-2">
          <legend className="font-medium">Project team</legend>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
            {allAgents.length === 0 && <p className="text-[13px] text-ink-3">No agents yet. Create one with + in the Team section of the sidebar.</p>}
            {allAgents.map((agent) => (
              <label key={agent._id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={agentIds.includes(agent._id)}
                  onChange={(e) => setAgentIds((current) => (e.target.checked ? [...current, agent._id] : current.filter((id) => id !== agent._id)))}
                />
                <span>{roleLabel(agent.role)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p className="text-[13px] text-red-600">{error}</p>}
        <button type="submit" disabled={saving} className="rounded-lg bg-brand px-4 py-2 font-medium text-white hover:bg-brand-hover disabled:opacity-50">
          {saving ? "Saving…" : "Save project"}
        </button>
      </form>
    </Modal>
  );
}
