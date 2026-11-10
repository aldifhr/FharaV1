"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Modal from "../Modal";
import GithubRepoSettings from "../GithubRepoSettings";
import { useToast } from "../Toasts";
import { agentName, agentRoleText } from "@/lib/agentRoles";
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
import {
  MODEL_TIER_HINTS,
  MODEL_TIER_KEYS,
  MODEL_TIER_LABELS,
  type ModelTierKey,
  type ModelTiers,
} from "@/api/convex/lib/modelTiers";

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");

type ProjectDoc = {
  name?: string;
  workspacePath?: string;
  approvalMode?: "ask" | "auto";
  defaultPermissionMode?: PermissionMode;
  agentIds?: string[];
  instructions?: string;
  planReview?: string;
  shadowAgentDefault?: boolean;
  prFeedbackReactions?: boolean;
  commandAllowRules?: { prefix: string; createdAt: number; createdBy: string }[];
  commandAllowExact?: { command: string; args: string[]; createdAt: number; createdBy: string }[];
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
  const setShadowDefault = useMutation(api.reviewer.setProjectShadowDefault);
  const removeCommandRule = useMutation(api.commandApprovals.removeRule);
  const [removingRule, setRemovingRule] = useState<string | null>(null);
  const removeExactRule = useMutation(api.commandApprovals.removeExactRule);
  const [shadowDefault, setShadowDefaultState] = useState(Boolean(project.shadowAgentDefault));
  // Post-push feedback loop: CI / review / conflict on a task's PR queue a fix.
  const setPrReactions = useMutation(api.prFeedback.setProjectSetting);
  const prSetting = useQuery(api.prFeedback.getProjectSetting, { projectId: projectId as never });
  const [prReactionsChoice, setPrReactionsState] = useState<boolean | null>(null);
  const prReactions = prReactionsChoice ?? prSetting?.enabled ?? Boolean(project.prFeedbackReactions);
  // O2 supervised auto-merge.
  const setAutoMerge = useMutation(api.autoMerge.setProjectSetting);
  const autoMergeSetting = useQuery(api.autoMerge.getProjectSetting, { projectId: projectId as never });
  const [autoMergeChoice, setAutoMergeState] = useState<boolean | null>(null);
  const autoMerge = autoMergeChoice ?? autoMergeSetting?.enabled ?? false;
  // Plan 022: model tier per role, picked from the models already configured.
  const tierState = useQuery(api.contracts.getProjectModelTiers, { projectId: projectId as never });
  const setModelTiers = useMutation(api.contracts.setProjectModelTiers);
  const [tiers, setTiers] = useState<ModelTiers>({});
  const [tiersTouched, setTiersTouched] = useState(false);
  useEffect(() => {
    if (tierState && !tiersTouched) setTiers(tierState.tiers);
  }, [tierState, tiersTouched]);
  // Context Snapshot retention (days; default 14).
  const retention = useQuery(api.contextSnapshots.getRetention, { projectId: projectId as never });
  const setRetention = useMutation(api.contextSnapshots.setRetention);
  const [retentionDays, setRetentionDays] = useState<string>("");
  useEffect(() => {
    if (retention && retentionDays === "") setRetentionDays(String(retention.days));
  }, [retention, retentionDays]);
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
      if (shadowDefault !== Boolean(project.shadowAgentDefault)) {
        await setShadowDefault({ projectId: projectId as never, enabled: shadowDefault });
      }
      if (prReactionsChoice !== null) {
        await setPrReactions({ projectId: projectId as never, enabled: prReactionsChoice });
      }
      if (autoMergeChoice !== null) {
        await setAutoMerge({ projectId: projectId as never, enabled: autoMergeChoice });
      }
      const days = Number(retentionDays);
      if (retention && retentionDays !== "" && Number.isFinite(days) && days !== retention.days) {
        await setRetention({ projectId: projectId as never, days });
      }
      if (tiersTouched) {
        await setModelTiers({ projectId: projectId as never, modelTiers: tiers as never });
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
        <fieldset className="grid gap-1.5">
          <legend className="font-medium">Always-allowed commands</legend>
          <span className="text-[12.5px] text-ink-3">
            Agent commands that start with these run without asking. Added with “Always allow” on a command approval. Push, merge and destructive commands always ask.
          </span>
          {(project.commandAllowRules ?? []).length === 0 ? (
            <p className="text-[13px] text-ink-3">None yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {(project.commandAllowRules ?? []).map((rule) => (
                <li key={rule.prefix} className="flex items-center gap-3 px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{rule.prefix}</code>
                  <span className="shrink-0 text-[12px] text-ink-3">{new Date(rule.createdAt).toLocaleDateString()}</span>
                  <button
                    type="button"
                    disabled={removingRule !== null}
                    onClick={async () => {
                      setRemovingRule(rule.prefix);
                      try {
                        await removeCommandRule({ projectId: projectId as never, prefix: rule.prefix });
                        toast("success", "Rule removed", rule.prefix);
                      } catch (err) {
                        toast("error", "Couldn't remove the rule", errorText(err));
                      } finally {
                        setRemovingRule(null);
                      }
                    }}
                    className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
                  >
                    {removingRule === rule.prefix ? "Removing…" : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(project.commandAllowExact ?? []).length > 0 && (
            <>
              <span className="mt-1 text-[12.5px] text-ink-3">Exact commands (only this program with exactly these arguments):</span>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {(project.commandAllowExact ?? []).map((entry) => {
                  const line = [entry.command, ...entry.args].map((part) => (/[\s"'`$]/.test(part) ? JSON.stringify(part) : part)).join(" ");
                  const key = `exact:${JSON.stringify([entry.command, ...entry.args])}`;
                  return (
                    <li key={key} className="flex items-center gap-3 px-3 py-2">
                      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{line}</code>
                      <span className="shrink-0 text-[12px] text-ink-3">{new Date(entry.createdAt).toLocaleDateString()}</span>
                      <button
                        type="button"
                        disabled={removingRule !== null}
                        onClick={async () => {
                          setRemovingRule(key);
                          try {
                            await removeExactRule({ projectId: projectId as never, command: entry.command, args: entry.args });
                            toast("success", "Rule removed", line);
                          } catch (err) {
                            toast("error", "Couldn't remove the rule", errorText(err));
                          } finally {
                            setRemovingRule(null);
                          }
                        }}
                        className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
                      >
                        {removingRule === key ? "Removing…" : "Remove"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </fieldset>
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
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={shadowDefault}
            onChange={(e) => setShadowDefaultState(e.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--shell-brand)]"
          />
          <span className="grid gap-0.5">
            Shadow agent on new tasks
            <span className="text-[12.5px] text-ink-3">
              The Reviewer reads each completed subtask and leaves notes. It never runs anything or blocks the task. Off by default; switch it per task in the thread.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={prReactions}
            onChange={(e) => setPrReactionsState(e.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--shell-brand)]"
          />
          <span className="grid gap-0.5">
            Fix pull request feedback
            <span className="text-[12.5px] text-ink-3">
              After a push, a failed CI check, a review asking for changes, new review comments or a merge conflict queues a fix on the same branch, up to {prSetting?.maxAttempts ?? 3} per PR. Each fix push still waits for your approval. The task&apos;s worktree is kept until its PR closes. Off by default.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={autoMerge}
            onChange={(e) => setAutoMergeState(e.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--shell-brand)]"
          />
          <span className="grid gap-0.5">
            Merge pull requests automatically
            <span className="text-[12.5px] text-ink-3">
              A task&apos;s PR merges ({autoMergeSetting?.method ?? "squash"}) once every check passed, the diff is at most {autoMergeSetting?.maxDiffLines || "any number of"} lines with no sensitive path, and its head is the commit you approved. Otherwise it waits and says why. Never forced. Off by default.
            </span>
          </span>
        </label>
        <label className="grid gap-1">
          Context snapshots kept for (days)
          <input
            type="number"
            min={1}
            max={365}
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            className={field}
          />
          <span className="text-[12.5px] text-ink-3">
            {retention && !retention.enabled
              ? "Recording is off for this deployment (CONTEXT_SNAPSHOTS=0)."
              : "What each LLM call saw, for Inspect context and Replay. Older snapshots are deleted daily."}
          </span>
        </label>
        <fieldset className="grid gap-2">
          <legend className="font-medium">Model per role</legend>
          <span className="text-[12.5px] text-ink-3">
            An agent with its own model keeps it. Otherwise the tier for its role is used, then the default provider order.
          </span>
          {MODEL_TIER_KEYS.map((key: ModelTierKey) => (
            <label key={key} className="grid gap-1">
              <span>{MODEL_TIER_LABELS[key]}</span>
              <select
                value={tiers[key] ?? ""}
                disabled={!tierState}
                onChange={(e) => {
                  setTiersTouched(true);
                  setTiers((current) => ({ ...current, [key]: e.target.value || undefined }));
                }}
                className={field}
              >
                <option value="">Default</option>
                {(tierState?.options ?? []).map((option) => (
                  <option key={option._id} value={option._id}>
                    {option.label} · {option.providerName}
                  </option>
                ))}
              </select>
              <span className="text-[12.5px] text-ink-3">{MODEL_TIER_HINTS[key]}</span>
            </label>
          ))}
        </fieldset>
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
                <span>{agentName(agent)}{agentRoleText(agent) ? <span className="text-ink-3">{` · ${agentRoleText(agent)}`}</span> : null}</span>
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
