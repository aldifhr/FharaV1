"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Modal from "../Modal";
import GithubRepoSettings from "../GithubRepoSettings";
import { useToast } from "../Toasts";
import { roleLabel } from "@/lib/agentRoles";
import {
  PERMISSION_MODES,
  PERMISSION_MODE_HINTS,
  PERMISSION_MODE_LABELS,
  projectDefaultPermissionMode,
  type PermissionMode,
} from "@/api/convex/lib/permissionModes";
import {
  PLAN_REVIEW_HINTS,
  PLAN_REVIEW_LABELS,
  PLAN_REVIEW_SETTINGS,
  normalizePlanReview,
  type PlanReviewSetting,
} from "@/api/convex/lib/planReviewPolicy";

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");

type ProjectDoc = {
  name?: string;
  workspacePath?: string;
  approvalMode?: "ask" | "auto";
  defaultPermissionMode?: PermissionMode;
  agentIds?: string[];
  instructions?: string;
  planReview?: string;
};

const field = "rounded-lg border border-line bg-panel px-3 py-2 text-ink outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/15";

/** Project settings: name, folder, default permission mode, instructions, team. */
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
  const setPlanReviewSetting = useMutation(api.planReview.setProjectPlanReview);
  const [planReview, setPlanReview] = useState<PlanReviewSetting>(normalizePlanReview(project.planReview));
  const [name, setName] = useState(project.name ?? "");
  const [path, setPath] = useState(project.workspacePath ?? "");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(projectDefaultPermissionMode(project));
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
      // Plan 020: the per-task permission mode replaces the legacy project
      // switch. Saving retires `approvalMode: "auto"` (which skipped the
      // gate without recording anything); the default mode governs instead.
      await updateProject({
        projectId: projectId as never,
        name,
        workspacePath: path,
        approvalMode: "ask",
        defaultPermissionMode: permissionMode,
        instructions,
      });
    } catch (err) {
      setError(`Couldn't save project settings: ${errorText(err)}`);
      setSaving(false);
      return;
    }
    try {
      if (planReview !== normalizePlanReview(project.planReview)) {
        await setPlanReviewSetting({ projectId: projectId as never, planReview });
      }
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
          Default permission mode
          <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)} className={field}>
            {PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {PERMISSION_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
          <span className="text-[12.5px] text-ink-3">
            {PERMISSION_MODE_HINTS[permissionMode]}. New tasks start in this mode; change it per task in the composer.
          </span>
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
        <label className="grid gap-1">
          Plan review
          <select value={planReview} onChange={(e) => setPlanReview(e.target.value as PlanReviewSetting)} className={field}>
            {PLAN_REVIEW_SETTINGS.map((setting) => (
              <option key={setting} value={setting}>
                {PLAN_REVIEW_LABELS[setting]}
              </option>
            ))}
          </select>
          <span className="text-[12.5px] text-ink-3">{PLAN_REVIEW_HINTS[planReview]}</span>
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
      <GithubRepoSettings projectId={projectId} />
    </Modal>
  );
}
